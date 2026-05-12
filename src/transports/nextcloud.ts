import * as http from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextcloudConfig } from "../config.js";
import { getLogger } from "../logger.js";
import type {
  InboundMessage,
  Transport,
  TransportAttachment,
  TransportSendOptions,
  TransportSendResult,
} from "../transport.js";

const HEALTH_PATH = "/healthz";
const DEFAULT_MAX_MESSAGE_LENGTH = 12_000;
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const WEBHOOK_BODY_TIMEOUT_MS = 5_000;
const REPLAY_TTL_MS = 24 * 60 * 60 * 1000;

type FetchLike = typeof fetch;

interface NextcloudWebhookPayload {
  type?: string;
  actor?: {
    id?: string;
    name?: string;
  };
  object?: {
    id?: string | number;
    type?: string;
    name?: string;
    content?: unknown;
  };
  target?: {
    id?: string;
    name?: string;
  };
}

interface NextcloudTransportOptions {
  maxWebhookBodyBytes?: number;
  webhookBodyTimeoutMs?: number;
  replayTtlMs?: number;
}

export class NextcloudTransport implements Transport {
  readonly name = "nextcloud";
  readonly maxMessageLength = DEFAULT_MAX_MESSAGE_LENGTH;

  private server: http.Server | undefined;
  private onMessage: ((message: InboundMessage) => void) | undefined;
  private listenReady: Promise<void> | undefined;
  private replayGuard = new Map<string, number>();

  constructor(
    private readonly config: NextcloudConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly options: NextcloudTransportOptions = {},
  ) {}

  async send(
    _recipient: string,
    message: string,
    options: TransportSendOptions = {},
  ): Promise<TransportSendResult> {
    const roomToken = normalizeRoomToken(options.target);
    if (!roomToken) {
      throw new Error("Nextcloud send() requires an explicit target room token");
    }

    const trimmed = message.trim();
    if (!trimmed) {
      throw new Error("Nextcloud send() requires non-empty message text");
    }

    const payload: Record<string, unknown> = { message: trimmed };
    if (options.replyToMessageId) {
      payload["replyTo"] = options.replyToMessageId;
    }

    const { random, signature } = generateNextcloudTalkSignature({
      body: trimmed,
      secret: this.config.botSecret,
    });

    const response = await this.fetchImpl(
      `${trimTrailingSlash(this.config.baseUrl)}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(roomToken)}/message`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "OCS-APIRequest": "true",
          "X-Nextcloud-Talk-Bot-Random": random,
          "X-Nextcloud-Talk-Bot-Signature": signature,
        },
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(describeNextcloudSendError(response.status, body));
    }

    return {};
  }

  async fetchAttachment(_attachment: TransportAttachment, _sender: string): Promise<Buffer> {
    throw new Error("NextcloudTransport does not support attachments yet");
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (!this.listenReady) return;
    await withTimeout(this.listenReady, timeoutMs, "Nextcloud webhook server did not start in time");
  }

  listen(onMessage: (message: InboundMessage) => void): void {
    this.stop();
    this.onMessage = onMessage;

    this.listenReady = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.config.webhookPort, this.config.webhookHost, () => {
        this.server = server;
        const address = server.address();
        const printable = typeof address === "string"
          ? address
          : `${address?.address ?? this.config.webhookHost}:${address?.port ?? this.config.webhookPort}`;
        getLogger().info("nextcloud-transport", "webhook-listening", `Webhook listening on ${printable}${this.config.webhookPath}`, {
          webhookHost: this.config.webhookHost,
          webhookPort: this.config.webhookPort,
          webhookPath: this.config.webhookPath,
        });
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = undefined;
    }
    this.onMessage = undefined;
    this.listenReady = undefined;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = req.url ? new URL(req.url, "http://localhost").pathname : "/";

    if (method === "GET" && path === HEALTH_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }

    if (method !== "POST" || path !== this.config.webhookPath) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }

    const signature = getHeader(req, "x-nextcloud-talk-signature");
    const random = getHeader(req, "x-nextcloud-talk-random");
    const backend = getHeader(req, "x-nextcloud-talk-backend");
    if (!signature || !random) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Missing signature headers" }));
      return;
    }

    if (backend && !isAllowedBackendOrigin(backend, this.config.baseUrl)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Invalid backend" }));
      return;
    }

    let body: string;
    try {
      body = await readRawBody(req, {
        maxBytes: this.options.maxWebhookBodyBytes ?? MAX_WEBHOOK_BODY_BYTES,
        timeoutMs: this.options.webhookBodyTimeoutMs ?? WEBHOOK_BODY_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Payload too large" }));
        return;
      }
      if (err instanceof BodyTimeoutError) {
        res.writeHead(408, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Request body timeout" }));
        return;
      }
      throw err;
    }
    if (!verifyNextcloudTalkSignature({ signature, random, body, secret: this.config.botSecret })) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    let payload: NextcloudWebhookPayload;
    try {
      payload = JSON.parse(body) as NextcloudWebhookPayload;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Invalid payload format" }));
      return;
    }

    if (payload.type !== "Create") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }

    const message = toInboundMessage(payload, backend);
    if (!message || !message.text.trim()) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }

    const replayKey = buildReplayKey(message.meta?.roomToken, message.meta?.messageId);
    if (replayKey && this.isReplay(replayKey)) {
      getLogger().info("nextcloud-transport", "webhook-replay", `Ignoring replayed webhook for ${replayKey}`, {
        replayKey,
      });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, replay: true }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true }));

    if (!this.onMessage) return;
    void Promise.resolve(this.onMessage(message)).catch((err) => {
      getLogger().error("nextcloud-transport", "inbound-handler-error", "Error handling inbound message", {
        error: err,
        roomToken: message.meta?.roomToken,
      });
    });
  }

  private isReplay(key: string): boolean {
    const now = Date.now();
    const replayTtlMs = this.options.replayTtlMs ?? REPLAY_TTL_MS;
    for (const [existingKey, seenAt] of this.replayGuard) {
      if (now - seenAt > replayTtlMs) {
        this.replayGuard.delete(existingKey);
      }
    }

    if (this.replayGuard.has(key)) return true;
    this.replayGuard.set(key, now);
    return false;
  }
}

function toInboundMessage(payload: NextcloudWebhookPayload, backend: string | undefined): InboundMessage | undefined {
  const senderId = payload.actor?.id;
  const roomToken = payload.target?.id;
  if (!senderId || !roomToken) return undefined;

  const text = parseMessageText(payload.object?.content);
  return {
    kind: "message",
    sender: roomToken,
    text,
    attachments: [],
    meta: {
      transport: "nextcloud",
      messageId: payload.object?.id !== undefined ? String(payload.object.id) : undefined,
      roomToken,
      roomName: payload.target?.name,
      senderId,
      senderName: payload.actor?.name,
      backend,
      authSender: senderId,
      target: roomToken,
    },
  };
}

function parseMessageText(content: unknown): string {
  if (typeof content !== "string") return "";
  try {
    const parsed = JSON.parse(content) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : "";
  } catch {
    return content;
  }
}

function getHeader(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readRawBody(
  req: http.IncomingMessage,
  options: { maxBytes: number; timeoutMs: number },
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new BodyTimeoutError());
    }, options.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
      req.removeListener("aborted", onAborted);
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > options.maxBytes) {
        cleanup();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = (): void => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const onAborted = (): void => {
      cleanup();
      reject(new BodyTimeoutError());
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

class BodyTooLargeError extends Error {}
class BodyTimeoutError extends Error {}

function isAllowedBackendOrigin(backend: string, baseUrl: string): boolean {
  try {
    return new URL(backend).origin.toLowerCase() === new URL(baseUrl).origin.toLowerCase();
  } catch {
    return false;
  }
}

function buildReplayKey(roomToken: unknown, messageId: unknown): string | undefined {
  if (typeof roomToken !== "string" || !roomToken) return undefined;
  if (typeof messageId !== "string" || !messageId) return undefined;
  return `${roomToken}:${messageId}`;
}

function describeNextcloudSendError(status: number, body: string): string {
  const suffix = body ? `: ${body}` : "";
  switch (status) {
    case 400:
      return `Nextcloud send failed: bad request / invalid message format${suffix}`;
    case 401:
      return `Nextcloud send failed: authentication failed / check bot secret${suffix}`;
    case 403:
      return `Nextcloud send failed: forbidden / bot lacks permission in room${suffix}`;
    case 404:
      return `Nextcloud send failed: room not found${suffix}`;
    default:
      return `Nextcloud send failed: HTTP ${status}${suffix}`;
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeRoomToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  for (const prefix of ["nextcloud-talk:", "nc-talk:", "nc:", "room:"]) {
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

export function normalizeNextcloudRoomWorkspaceKey(roomToken: string): string {
  const trimmed = normalizeRoomToken(roomToken) ?? roomToken.trim();
  return `nextcloud_room_${trimmed}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function verifyNextcloudTalkSignature(params: {
  signature: string;
  random: string;
  body: string;
  secret: string;
}): boolean {
  if (!params.signature || !params.random || !params.secret) return false;

  const expected = createHmac("sha256", params.secret)
    .update(params.random + params.body)
    .digest("hex");

  const left = Buffer.from(params.signature, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function generateNextcloudTalkSignature(params: { body: string; secret: string }) {
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", params.secret)
    .update(random + params.body)
    .digest("hex");
  return { random, signature };
}
