/**
 * HTTP wrapper for the signal-cli JSON-RPC API.
 *
 * signal-cli exposes:
 *   POST /api/v1/rpc    — send messages, reactions, attachments
 *   GET  /api/v1/events — SSE stream of incoming messages
 *   GET  /api/v1/check  — readiness / health probe
 *
 * Attachment handling:
 *   - Outbound: pass file paths to send() → signal-cli reads and sends them
 *   - Inbound: attachments arrive with metadata; data is base64 in the event
 *              or stored in signal-cli's data dir (we handle both)
 *
 * Node 22 native fetch is used — no extra HTTP library needed.
 */

import { getLogger } from "../logger.js";

export interface SignalCheckResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface SignalDirectRoute {
  kind: "direct";
  recipient: string;
}

interface SignalGroupRoute {
  kind: "group";
  groupId: string;
  /** Optional participant context when signal-cli accepts both groupId and recipient. */
  recipient?: string;
}

export type SignalRoute = SignalDirectRoute | SignalGroupRoute;
export type SignalAttachmentSource = SignalRoute;

export interface SignalReactionTarget {
  author: string;
  timestamp: number;
  authorUuid?: string;
}

export interface SignalSendResult {
  timestamp?: number;
  results?: Array<{
    recipientAddress?: {
      uuid?: string;
      number?: string;
      username?: string | null;
    };
    groupId?: string;
    type?: string;
  }>;
}

export class SignalClient {
  private idCounter = 0;

  constructor(
    readonly baseUrl: string,
    readonly phoneNumber: string,
  ) {}

  private nextId(): number {
    return ++this.idCounter;
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const body = {
      jsonrpc: "2.0",
      method,
      params: { account: this.phoneNumber, ...params },
      id: this.nextId(),
    };

    const res = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`signal-cli RPC ${method} failed: ${res.status} ${res.statusText}`);
    }

    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) {
      throw new Error(`signal-cli RPC ${method} error: ${json.error.message}`);
    }

    return json.result;
  }

  /** Send a text message to a direct recipient or group, optionally with file attachments and style ranges. */
  async send(
    route: SignalRoute,
    message: string,
    attachments?: string[],
    textStyles?: string[],
  ): Promise<SignalSendResult> {
    const params: Record<string, unknown> = { message };
    if (route.kind === "direct") {
      params.recipient = [route.recipient];
    } else {
      params.groupId = route.groupId;
    }
    if (attachments && attachments.length > 0) {
      params.attachments = attachments;
    }
    if (textStyles && textStyles.length > 0) {
      params.textStyle = textStyles;
    }
    const result = await this.rpc("send", params);
    return isSignalSendResult(result) ? result : {};
  }

  /** Send a reaction emoji to a specific direct or group message. */
  async sendReaction(
    route: SignalRoute,
    emoji: string,
    target: SignalReactionTarget,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      emoji,
      targetAuthor: target.author,
      targetTimestamp: target.timestamp,
    };
    if (target.authorUuid) {
      params.targetAuthorUuid = target.authorUuid;
    }
    if (route.kind === "direct") {
      params.recipient = [route.recipient];
    } else {
      params.groupId = route.groupId;
    }

    await this.rpc("sendReaction", params);
  }

  /** Health probe against signal-cli's HTTP endpoint. */
  async check(): Promise<SignalCheckResult> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/check`);
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `${res.status} ${res.statusText}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Fetch signal-cli version through JSON-RPC. */
  async version(): Promise<unknown> {
    return this.rpc("version", {});
  }

  /**
   * Poll until signal-cli HTTP API is reachable.
   * Called once at bridge startup before opening the SSE stream.
   * Retry every 2 s up to timeoutMs.
   */
  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    const interval = 2_000;

    while (Date.now() - start < timeoutMs) {
      const check = await this.check();
      if (check.ok) {
        try {
          await this.version();
          getLogger().info("signal-client", "ready", "signal-cli is ready", { baseUrl: this.baseUrl });
          return;
        } catch {
          // HTTP is up, but RPC path is not fully ready yet.
        }
      }

      const elapsed = Math.round((Date.now() - start) / 1000);
      getLogger().info("signal-client", "waiting", `Waiting for signal-cli... (${elapsed}s)`, {
        baseUrl: this.baseUrl,
        elapsedSeconds: elapsed,
      });
      await new Promise((r) => setTimeout(r, interval));
    }

    throw new Error(`signal-cli not reachable at ${this.baseUrl} after ${timeoutMs}ms`);
  }

  /**
   * Fetch attachment data by ID.
   * signal-cli stores attachments internally and only sends metadata in SSE events.
   * Call this to retrieve the actual file content as base64.
   */
  async getAttachment(attachmentId: string, source: SignalAttachmentSource): Promise<string> {
    const params: Record<string, unknown> = { id: attachmentId };
    if (source.kind === "direct") {
      params.recipient = source.recipient;
    } else {
      params.groupId = source.groupId;
      if (source.recipient) {
        params.recipient = source.recipient;
      }
    }

    const result = await this.rpc("getAttachment", params);
    if (typeof result === "string") {
      return result;
    }
    if (result && typeof result === "object" && "data" in result) {
      return (result as { data: string }).data;
    }
    throw new Error(`Unexpected getAttachment response: ${JSON.stringify(result)}`);
  }
}

function isSignalSendResult(value: unknown): value is SignalSendResult {
  return !!value && typeof value === "object";
}
