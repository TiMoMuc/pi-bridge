/**
 * Minimal transport boundary for the bridge.
 *
 * Keep this intentionally small: only the operations the current bridge already
 * needs. New transports can implement this without pulling in a plugin system.
 */

export type TransportName = "signal" | "nextcloud";

export interface TransportAttachment {
  id: string;
  contentType: string;
  filename?: string;
  size?: number;
  /** Opaque transport-specific payload used internally by the adapter. */
  metadata?: unknown;
}

type InboundMessageKind = "message" | "event";

export interface InboundMessageMeta {
  transport?: TransportName;
  messageId?: string;
  conversationId?: string;
  conversationKind?: "direct" | "group";
  roomToken?: string;
  roomName?: string;
  groupId?: string;
  groupName?: string;
  senderId?: string;
  senderNumber?: string;
  senderUuid?: string;
  senderName?: string;
  backend?: string;
  authSender?: string;
  recipient?: string;
  target?: string;
  [key: string]: unknown;
}

export interface InboundMessage {
  sender: string;
  text: string;
  attachments: TransportAttachment[];
  timestamp?: number;
  kind?: InboundMessageKind;
  meta?: InboundMessageMeta;
}

export interface TransportSendOptions {
  attachments?: string[];
  textStyles?: string[];
  target?: string;
  replyToMessageId?: string;
  meta?: Record<string, unknown>;
}

export interface TransportSendResult {
  timestamp?: number;
}

export interface Transport {
  readonly name: string;
  readonly maxMessageLength: number;

  send(recipient: string, message: string, options?: TransportSendOptions): Promise<TransportSendResult>;
  fetchAttachment(attachment: TransportAttachment, sender: string): Promise<Buffer>;
  waitUntilReady(timeoutMs?: number): Promise<void>;
  listen(onMessage: (message: InboundMessage) => void): void;
  stop(): void;
}

export interface TransportRunRefs {
  sessionFile?: string;
  userMessageId?: string;
  assistantMessageId?: string;
}

export interface SupportsMessageReferences {
  recordInboundMessageRef(
    sender: string,
    inbound: InboundMessage,
    refs: TransportRunRefs,
    textPreview: string,
  ): Promise<void>;
  recordOutboundMessageRef(
    sender: string,
    refs: TransportRunRefs,
    textPreview: string,
    sendResult: TransportSendResult,
    chunkIndex: number,
    chunkCount: number,
  ): Promise<void>;
}

export interface SupportsOutboundReactions {
  sendReactionForSessionMessageId(
    recipient: string,
    sessionMessageId: string,
    emoji: string,
  ): Promise<boolean>;
}

export function supportsMessageReferences(transport: Transport): transport is Transport & SupportsMessageReferences {
  return "recordInboundMessageRef" in transport && "recordOutboundMessageRef" in transport;
}

export function supportsOutboundReactions(transport: Transport): transport is Transport & SupportsOutboundReactions {
  return "sendReactionForSessionMessageId" in transport;
}
