/**
 * Signal transport adapter.
 *
 * Owns the Signal-specific edge of the system:
 * - JSON-RPC send / reaction / attachment fetch (via SignalClient)
 * - SSE listen / reconnect / stop lifecycle
 * - Signal envelope parsing
 * - UUID→phone learning and duplicate filtering
 * - Signal-specific durable affordances such as reactions and
 *   central Signal↔session message reference storage
 *
 * Everything downstream stays transport-agnostic.
 */

import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as https from "node:https";
import { getLogger } from "../logger.js";
import {
  SignalClient,
  type SignalAttachmentSource,
  type SignalReactionTarget,
  type SignalRoute,
  type SignalSendResult,
} from "./signal-client.js";
import { SignalMessageRefStore, previewText } from "./signal-message-refs.js";
import type {
  InboundMessage,
  SupportsMessageReferences,
  SupportsOutboundReactions,
  Transport,
  TransportAttachment,
  TransportRunRefs,
  TransportSendOptions,
  TransportSendResult,
} from "../transport.js";

interface SignalGroupInfo {
  groupId?: string;
  groupName?: string;
  revision?: number;
  type?: string;
}

interface SignalAttachmentPayload {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
  data?: string;
  storedFilename?: string;
}

interface SignalReactionMessage {
  emoji?: string;
  targetAuthor?: string;
  targetAuthorNumber?: string;
  targetAuthorUuid?: string;
  targetSentTimestamp?: number;
  isRemove?: boolean;
}

interface SignalDataMessage {
  message?: string | null;
  timestamp?: number;
  attachments?: SignalAttachmentPayload[];
  reaction?: SignalReactionMessage;
  reactionMessage?: SignalReactionMessage;
  groupInfo?: SignalGroupInfo;
}

interface SignalEnvelope {
  envelope?: {
    source?: string;
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    sourceDevice?: number;
    dataMessage?: SignalDataMessage;
    syncMessage?: {
      sentMessage?: {
        destination?: string;
        timestamp?: number;
        message?: string | null;
        reactionMessage?: SignalReactionMessage;
        groupInfo?: SignalGroupInfo;
      };
    };
    reactionMessage?: SignalReactionMessage;
  };
}

interface SignalActor {
  id: string;
  number?: string;
  uuid?: string;
  name?: string;
}

interface SignalConversationContext {
  conversationId: string;
  kind: "direct" | "group";
  route: SignalRoute;
  groupId?: string;
  groupName?: string;
}

interface SignalAttachmentMetadata extends SignalAttachmentPayload {
  fetchSource?: SignalAttachmentSource;
  groupId?: string;
  groupName?: string;
}

export interface SignalReconnectPolicy {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
  random: () => number;
}

const DEFAULT_RECONNECT_POLICY: SignalReconnectPolicy = {
  initialMs: 1_000,
  maxMs: 10_000,
  factor: 2,
  jitter: 0.2,
  random: Math.random,
};

type SignalTransportClient = Pick<SignalClient, "send" | "sendReaction" | "waitUntilReady" | "getAttachment"> & {
  readonly baseUrl: string;
  readonly phoneNumber: string;
};

export function computeReconnectDelay(
  attempt: number,
  policy: Pick<SignalReconnectPolicy, "initialMs" | "maxMs" | "factor" | "jitter" | "random">,
): number {
  const cappedAttempt = Math.max(1, attempt);
  const baseDelay = Math.min(
    policy.maxMs,
    Math.round(policy.initialMs * policy.factor ** (cappedAttempt - 1)),
  );
  if (policy.jitter <= 0) return baseDelay;

  const spread = baseDelay * policy.jitter;
  const offset = (policy.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(baseDelay + offset));
}

export class SignalTransport
implements Transport, SupportsMessageReferences, SupportsOutboundReactions {
  readonly name = "signal";
  readonly maxMessageLength = 4_000;

  private readonly uuidToPhone = new Map<string, string>();
  private readonly recentMessages = new Map<string, number>();
  private readonly dedupWindowMs = 30_000;
  private readonly reconnectPolicy: SignalReconnectPolicy;
  private readonly messageRefStore: SignalMessageRefStore;

  private sseRequest: http.ClientRequest | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = true;
  private onMessage: ((message: InboundMessage) => void) | undefined;

  constructor(
    baseUrl: string,
    phoneNumber: string,
    workspaceDir: string,
    private readonly client: SignalTransportClient = new SignalClient(baseUrl, phoneNumber),
    reconnectPolicy: Partial<SignalReconnectPolicy> = {},
  ) {
    this.reconnectPolicy = { ...DEFAULT_RECONNECT_POLICY, ...reconnectPolicy };
    this.messageRefStore = new SignalMessageRefStore(workspaceDir);
  }

  async send(
    recipient: string,
    message: string,
    options: TransportSendOptions = {},
  ): Promise<TransportSendResult> {
    const route = options.target
      ? buildGroupRoute(options.target, recipient)
      : buildDirectRoute(recipient);
    return this.client.send(route, message, options.attachments, options.textStyles);
  }

  async sendReactionForSessionMessageId(
    recipient: string,
    sessionMessageId: string,
    emoji: string,
  ): Promise<boolean> {
    const refs = await this.messageRefStore.findBySessionMessageId(sessionMessageId);
    const target = refs.find((ref) => ref.role === "user" && ref.direction === "inbound");
    if (!target) return false;

    const route = target.groupId
      ? buildGroupRoute(target.groupId, recipient)
      : buildDirectRoute(target.signalAuthorNumber ?? target.signalAuthor);
    const reactionTarget: SignalReactionTarget = {
      author: target.signalAuthorNumber ?? target.signalAuthor,
      authorUuid: target.signalAuthorUuid,
      timestamp: target.signalTimestamp,
    };

    await this.client.sendReaction(route, emoji, reactionTarget);
    return true;
  }

  async recordInboundMessageRef(
    conversationId: string,
    inbound: InboundMessage,
    refs: TransportRunRefs,
    text: string,
  ): Promise<void> {
    if (!refs.userMessageId || !refs.sessionFile || !inbound.timestamp) return;

    const senderId = typeof inbound.meta?.senderId === "string" && inbound.meta.senderId
      ? inbound.meta.senderId
      : inbound.sender;
    const senderNumber = typeof inbound.meta?.senderNumber === "string" && inbound.meta.senderNumber
      ? inbound.meta.senderNumber
      : looksLikePhoneNumber(senderId)
        ? senderId
        : undefined;
    const senderUuid = typeof inbound.meta?.senderUuid === "string" && inbound.meta.senderUuid
      ? inbound.meta.senderUuid
      : undefined;
    const groupId = typeof inbound.meta?.groupId === "string" && inbound.meta.groupId
      ? inbound.meta.groupId
      : undefined;

    await this.messageRefStore.append({
      conversation: conversationId,
      direction: "inbound",
      role: "user",
      signalAuthor: senderId,
      signalAuthorNumber: senderNumber,
      signalAuthorUuid: senderUuid,
      signalTimestamp: inbound.timestamp,
      sessionFile: refs.sessionFile,
      sessionMessageId: refs.userMessageId,
      textPreview: previewText(text),
      groupId,
    });
  }

  async recordOutboundMessageRef(
    conversationId: string,
    refs: TransportRunRefs,
    text: string,
    sendResult: TransportSendResult,
    chunkIndex: number,
    chunkCount: number,
  ): Promise<void> {
    if (!refs.assistantMessageId || !refs.sessionFile || !sendResult.timestamp) return;

    const signalSendResult = sendResult as SignalSendResult;
    const groupId = signalSendResult.results?.find((result) => typeof result.groupId === "string")?.groupId;

    await this.messageRefStore.append({
      conversation: conversationId,
      direction: "outbound",
      role: "assistant",
      signalAuthor: this.client.phoneNumber,
      signalAuthorNumber: this.client.phoneNumber,
      signalTimestamp: sendResult.timestamp,
      sessionFile: refs.sessionFile,
      sessionMessageId: refs.assistantMessageId,
      textPreview: previewText(text),
      chunkIndex,
      chunkCount,
      groupId,
    });
  }

  async fetchAttachment(attachment: TransportAttachment, sender: string): Promise<Buffer> {
    const raw = isSignalAttachmentMetadata(attachment.metadata) ? attachment.metadata : undefined;

    if (raw?.data) {
      return Buffer.from(raw.data, "base64");
    }

    if (raw?.storedFilename) {
      return fs.readFile(raw.storedFilename);
    }

    const source = raw?.fetchSource ?? buildDirectRoute(sender);
    const base64 = await this.client.getAttachment(attachment.id, source);
    return Buffer.from(base64, "base64");
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    await this.client.waitUntilReady(timeoutMs);
  }

  listen(onMessage: (message: InboundMessage) => void): void {
    this.stop();
    this.stopped = false;
    this.onMessage = onMessage;
    this.reconnectAttempt = 0;

    const sseUrl = `${this.client.baseUrl}/api/v1/events`;
    getLogger().info("signal-transport", "sse-open", `Opening SSE stream: ${sseUrl}`, {
      baseUrl: this.client.baseUrl,
    });
    this.connectSSE();
  }

  stop(): void {
    this.stopped = true;
    this.onMessage = undefined;
    this.reconnectAttempt = 0;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.sseRequest) {
      this.sseRequest.destroy();
      this.sseRequest = undefined;
    }
  }

  private connectSSE(): void {
    if (this.stopped || !this.onMessage) return;

    const sseUrl = `${this.client.baseUrl}/api/v1/events`;
    const url = new URL(sseUrl);
    const transport = url.protocol === "https:" ? https : http;

    this.sseRequest = transport.get(sseUrl, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        this.scheduleReconnect(`SSE returned HTTP ${res.statusCode ?? "unknown"}`);
        return;
      }

      getLogger().info("signal-transport", "sse-connected", `SSE stream connected (status ${res.statusCode})`, {
        baseUrl: this.client.baseUrl,
        statusCode: res.statusCode,
      });

      let buffer = "";
      let currentEvent = "";
      let currentData = "";
      let sawEvent = false;
      let disconnected = false;

      const disconnect = (reason: string): void => {
        if (disconnected || this.stopped) return;
        disconnected = true;
        this.sseRequest = undefined;
        this.scheduleReconnect(reason);
      };

      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIdx).replace(/\r$/, "");
          buffer = buffer.slice(nlIdx + 1);

          if (line === "") {
            if (currentData) {
              void this.handleSSEEvent(currentEvent, currentData.replace(/\n$/, ""));
              currentEvent = "";
              currentData = "";
              if (!sawEvent) {
                sawEvent = true;
                if (this.reconnectAttempt > 0) {
                  getLogger().info("signal-transport", "sse-recovered", `SSE stream healthy again after ${this.reconnectAttempt} reconnect attempt(s)`, {
                    baseUrl: this.client.baseUrl,
                    reconnectAttempt: this.reconnectAttempt,
                  });
                }
                this.reconnectAttempt = 0;
              }
            }
          } else if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            currentData += line.slice(5) + "\n";
          }
        }
      });

      res.on("end", () => {
        disconnect("SSE stream ended");
      });

      res.on("close", () => {
        disconnect("SSE stream closed");
      });

      res.on("error", (err) => {
        disconnect(`SSE stream error: ${err.message}`);
      });
    });

    this.sseRequest.on("error", (err) => {
      if (this.stopped) return;
      this.sseRequest = undefined;
      this.scheduleReconnect(`SSE connection error: ${err.message}`);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempt += 1;
    const delayMs = computeReconnectDelay(this.reconnectAttempt, this.reconnectPolicy);
    getLogger().warn("signal-transport", "sse-reconnect", `${reason}; reconnect attempt ${this.reconnectAttempt} in ${delayMs}ms`, {
      baseUrl: this.client.baseUrl,
      reconnectAttempt: this.reconnectAttempt,
      delayMs,
      reason,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connectSSE();
    }, delayMs);
  }

  private async handleSSEEvent(eventType: string, data: string): Promise<void> {
    if (eventType !== "receive" || !this.onMessage) return;

    try {
      const parsed = JSON.parse(data) as SignalEnvelope;
      const env = parsed.envelope;
      if (!env) return;

      this.learnUuidMapping(env.sourceUuid ?? env.source, env.sourceNumber);
      const actor = this.resolveActor(env);
      if (!actor || actor.id === this.client.phoneNumber) return;
      const conversation = resolveConversation(env, actor.id);

      const reaction = extractReactionMessage(env);
      if (reaction && !reaction.isRemove) {
        const reactionKey = this.buildReactionKey(conversation.conversationId, actor.id, reaction);
        if (reactionKey && this.isDuplicateKey(reactionKey)) {
          getLogger().info("signal-transport", "duplicate-reaction", `Skipping duplicate reaction from ${actor.id}`, {
            senderId: actor.id,
          });
          return;
        }

        const resolved = reaction.targetSentTimestamp
          ? await this.messageRefStore?.findBySignalMessage(
            this.client.phoneNumber,
            reaction.targetSentTimestamp,
          )
          : null;
        const targetsAssistant = isReactionTargetingAssistant(reaction, this.client.phoneNumber) || !!resolved;

        getLogger().info("signal-transport", "reaction-inbound", `Inbound reaction from ${actor.id}: ${reaction.emoji ?? "(no emoji)"} -> ${reaction.targetAuthor ?? reaction.targetAuthorUuid ?? "unknown"} @ ${reaction.targetSentTimestamp ?? "unknown"}${resolved ? ` resolved=${resolved.sessionMessageId}` : ""}`, {
          senderId: actor.id,
          emoji: reaction.emoji,
          targetAuthor: reaction.targetAuthor ?? reaction.targetAuthorUuid,
          targetSentTimestamp: reaction.targetSentTimestamp,
          resolvedSessionMessageId: resolved?.sessionMessageId,
        });

        if (!targetsAssistant) {
          getLogger().info("signal-transport", "reaction-ignored", `Ignoring reaction from ${actor.id}: does not target an assistant message`, {
            senderId: actor.id,
          });
          return;
        }

        const text = resolved
          ? `[Reaction] User reacted ${reaction.emoji ?? "(no emoji)"} to your earlier assistant message (${resolved.sessionMessageId}: "${resolved.textPreview}").`
          : `[Reaction] User reacted ${reaction.emoji ?? "(no emoji)"} to one of your earlier assistant messages, but the exact target could not be resolved.`;

        this.onMessage({
          kind: "event",
          sender: conversation.conversationId,
          text,
          attachments: [],
          meta: buildInboundMeta(conversation, actor),
        });
        return;
      }

      const text = env.dataMessage?.message ?? "";
      const attachments = (env.dataMessage?.attachments ?? []).map((attachment) => normalizeAttachment(attachment, conversation.route, conversation));
      const timestamp = env.dataMessage?.timestamp;

      if (!text && attachments.length === 0) return;
      const messageKey = timestamp ? `${conversation.conversationId}:${actor.id}:${timestamp}` : undefined;
      if (messageKey && this.isDuplicateKey(messageKey)) {
        getLogger().info("signal-transport", "duplicate-message", `Skipping duplicate message from ${actor.id} (ts=${timestamp})`, {
          senderId: actor.id,
          signalTimestamp: timestamp,
        });
        return;
      }

      this.onMessage({
        kind: "message",
        sender: conversation.conversationId,
        text,
        attachments,
        timestamp,
        meta: buildInboundMeta(conversation, actor, timestamp),
      });
    } catch (err) {
      getLogger().error("signal-transport", "sse-parse-error", "Error parsing SSE event", {
        error: err,
      });
    }
  }

  private learnUuidMapping(uuid: string | undefined, phone: string | undefined): void {
    if (uuid && phone) this.uuidToPhone.set(uuid, phone);
  }

  private resolveActor(env: NonNullable<SignalEnvelope["envelope"]>): SignalActor | undefined {
    const id = this.resolveSender(env.sourceNumber, env.sourceUuid, env.source);
    if (!id) return undefined;
    return {
      id,
      number: env.sourceNumber,
      uuid: env.sourceUuid ?? env.source,
      name: env.sourceName,
    };
  }

  private resolveSender(
    sourceNumber: string | undefined,
    sourceUuid: string | undefined,
    source: string | undefined,
  ): string | undefined {
    if (sourceNumber) return sourceNumber;
    if (sourceUuid && this.uuidToPhone.has(sourceUuid)) return this.uuidToPhone.get(sourceUuid);
    if (source && this.uuidToPhone.has(source)) return this.uuidToPhone.get(source);
    return sourceUuid ?? source;
  }

  private buildReactionKey(
    conversationId: string,
    sender: string,
    reaction: SignalReactionMessage | undefined,
  ): string | undefined {
    if (!reaction) return undefined;
    const target = reaction.targetAuthor ?? reaction.targetAuthorUuid ?? "unknown";
    const ts = reaction.targetSentTimestamp ?? "unknown";
    const emoji = reaction.emoji ?? "";
    return `reaction:${conversationId}:${sender}:${target}:${ts}:${emoji}`;
  }

  private isDuplicateKey(key: string): boolean {
    const now = Date.now();

    for (const [existingKey, seenAt] of this.recentMessages) {
      if (now - seenAt > this.dedupWindowMs) {
        this.recentMessages.delete(existingKey);
      }
    }

    if (this.recentMessages.has(key)) return true;
    this.recentMessages.set(key, now);
    return false;
  }
}

function resolveConversation(
  envelope: NonNullable<SignalEnvelope["envelope"]>,
  senderId: string,
): SignalConversationContext {
  const groupInfo = extractGroupInfo(envelope);
  if (groupInfo?.groupId) {
    return {
      conversationId: groupInfo.groupId,
      kind: "group",
      route: buildGroupRoute(groupInfo.groupId, senderId),
      groupId: groupInfo.groupId,
      groupName: groupInfo.groupName,
    };
  }

  return {
    conversationId: senderId,
    kind: "direct",
    route: buildDirectRoute(senderId),
  };
}

function buildInboundMeta(
  conversation: SignalConversationContext,
  actor: SignalActor,
  timestamp?: number,
): InboundMessage["meta"] {
  return {
    transport: "signal",
    messageId: timestamp ? String(timestamp) : undefined,
    conversationId: conversation.conversationId,
    conversationKind: conversation.kind,
    groupId: conversation.groupId,
    groupName: conversation.groupName,
    senderId: actor.id,
    senderNumber: actor.number,
    senderUuid: actor.uuid,
    senderName: actor.name,
    authSender: actor.id,
    recipient: actor.id,
    target: conversation.groupId,
  };
}

function buildDirectRoute(recipient: string): SignalRoute {
  return { kind: "direct", recipient };
}

function buildGroupRoute(groupId: string, recipient?: string): SignalRoute {
  return recipient && recipient !== groupId
    ? { kind: "group", groupId, recipient }
    : { kind: "group", groupId };
}

function extractReactionMessage(
  envelope: NonNullable<SignalEnvelope["envelope"]>,
): SignalReactionMessage | undefined {
  return envelope.reactionMessage
    ?? envelope.dataMessage?.reaction
    ?? envelope.dataMessage?.reactionMessage
    ?? envelope.syncMessage?.sentMessage?.reactionMessage;
}

function extractGroupInfo(
  envelope: NonNullable<SignalEnvelope["envelope"]>,
): SignalGroupInfo | undefined {
  return envelope.dataMessage?.groupInfo
    ?? envelope.syncMessage?.sentMessage?.groupInfo;
}

function isReactionTargetingAssistant(
  reaction: SignalReactionMessage,
  assistantPhoneNumber: string,
): boolean {
  const assistant = normalizeSignalAddress(assistantPhoneNumber);
  return normalizeSignalAddress(reaction.targetAuthor) === assistant
    || normalizeSignalAddress(reaction.targetAuthorNumber) === assistant;
}

function normalizeSignalAddress(value: string | undefined): string {
  return (value ?? "").replace(/[\s()-]/g, "");
}

function looksLikePhoneNumber(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().startsWith("+");
}

function normalizeAttachment(
  attachment: SignalAttachmentPayload,
  fetchSource: SignalAttachmentSource,
  conversation: SignalConversationContext,
): TransportAttachment {
  const metadata: SignalAttachmentMetadata = {
    ...attachment,
    fetchSource,
    groupId: conversation.groupId,
    groupName: conversation.groupName,
  };

  return {
    id: attachment.id ?? "",
    contentType: attachment.contentType ?? "application/octet-stream",
    filename: attachment.filename,
    size: attachment.size,
    metadata,
  };
}

function isSignalAttachmentMetadata(value: unknown): value is SignalAttachmentMetadata {
  return !!value && typeof value === "object";
}
