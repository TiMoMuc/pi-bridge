import type { InboundMessage } from "./transport.js";

export function resolveInboundAuthSender(message: InboundMessage): string {
  const authSender = message.meta?.authSender;
  return typeof authSender === "string" && authSender ? authSender : message.sender;
}

export function resolveInboundBindingId(message: InboundMessage): string | undefined {
  const transport = message.meta?.transport;
  if (transport === "signal") {
    const conversationId = message.meta?.conversationId;
    if (typeof conversationId === "string" && conversationId) return conversationId;
    const groupId = message.meta?.groupId;
    if (typeof groupId === "string" && groupId) return groupId;
    const senderId = message.meta?.senderId;
    return typeof senderId === "string" && senderId ? senderId : message.sender;
  }
  if (transport === "nextcloud") {
    const roomToken = message.meta?.roomToken;
    return typeof roomToken === "string" && roomToken ? roomToken : undefined;
  }
  return undefined;
}

export function isUserWhitelisted(authSender: string, userWhitelist: string[] | undefined): boolean {
  if (!Array.isArray(userWhitelist) || userWhitelist.length === 0) return true;
  return userWhitelist.includes(authSender);
}

export function resolveOutboundRecipient(
  fallbackRecipient: string,
  inbound?: Pick<InboundMessage, "meta">,
): string {
  const recipient = inbound?.meta?.recipient;
  return typeof recipient === "string" && recipient ? recipient : fallbackRecipient;
}

export function resolveOutboundTarget(
  inbound?: Pick<InboundMessage, "meta">,
  fallbackTarget?: string,
): string | undefined {
  const target = inbound?.meta?.target;
  if (typeof target === "string" && target) return target;
  return typeof fallbackTarget === "string" && fallbackTarget ? fallbackTarget : undefined;
}

export function resolveBridgeContainerIdentifier(env: NodeJS.ProcessEnv = process.env): string {
  return env["BRIDGE_CONTAINER_NAME"] || env["HOSTNAME"] || "pi-bridge";
}
