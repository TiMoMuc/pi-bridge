import { describe, expect, it } from "vitest";
import {
  isUserWhitelisted,
  resolveBridgeContainerIdentifier,
  resolveInboundAuthSender,
  resolveInboundBindingId,
  resolveOutboundRecipient,
  resolveOutboundTarget,
} from "../src/bridge-runtime.js";

describe("bridge-runtime", () => {
  it("prefers explicit auth sender metadata for allowlisting", () => {
    expect(resolveInboundAuthSender({
      sender: "room-abc",
      text: "hello",
      attachments: [],
      meta: { authSender: "users/admin" },
    })).toBe("users/admin");
  });

  it("extracts the inbound binding id from signal and nextcloud metadata", () => {
    expect(resolveInboundBindingId({
      sender: "+15551234567",
      text: "hello",
      attachments: [],
      meta: { transport: "signal", senderId: "+15551234567" },
    })).toBe("+15551234567");

    expect(resolveInboundBindingId({
      sender: "group-123",
      text: "hello",
      attachments: [],
      meta: {
        transport: "signal",
        conversationId: "group-123",
        groupId: "group-123",
        senderId: "+15551234567",
      },
    })).toBe("group-123");

    expect(resolveInboundBindingId({
      sender: "ignored",
      text: "hello",
      attachments: [],
      meta: { transport: "nextcloud", roomToken: "room-abc" },
    })).toBe("room-abc");
  });

  it("resolves outbound recipient and target from transport metadata when present", () => {
    const inbound = {
      sender: "+15551234567",
      text: "hello",
      attachments: [],
      meta: {
        recipient: "+15551234567",
        target: "room-live",
      },
    };

    expect(resolveOutboundRecipient("fallback-recipient", inbound)).toBe("+15551234567");
    expect(resolveOutboundTarget(inbound, "room-stored")).toBe("room-live");
  });

  it("falls back to stored outbound recipient and target when overrides are absent", () => {
    expect(resolveOutboundRecipient("ws_a7b3c9")).toBe("ws_a7b3c9");
    expect(resolveOutboundTarget(undefined, "room-abc")).toBe("room-abc");
  });

  it("treats an empty or missing user whitelist as allow-all", () => {
    expect(isUserWhitelisted("users/admin", undefined)).toBe(true);
    expect(isUserWhitelisted("users/admin", [])).toBe(true);
    expect(isUserWhitelisted("users/admin", ["users/admin"])).toBe(true);
    expect(isUserWhitelisted("users/admin", ["users/alice"])).toBe(false);
  });

  it("prefers explicit container name env, then hostname, then the default", () => {
    expect(resolveBridgeContainerIdentifier({ BRIDGE_CONTAINER_NAME: "bridge-a", HOSTNAME: "ignored" })).toBe("bridge-a");
    expect(resolveBridgeContainerIdentifier({ HOSTNAME: "container-id" })).toBe("container-id");
    expect(resolveBridgeContainerIdentifier({})).toBe("pi-bridge");
  });
});
