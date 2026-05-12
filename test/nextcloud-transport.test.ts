import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextcloudConfig } from "../src/config.js";
import type { InboundMessage } from "../src/transport.js";
import {
  NextcloudTransport,
  generateNextcloudTalkSignature,
  normalizeNextcloudRoomWorkspaceKey,
  verifyNextcloudTalkSignature,
} from "../src/transports/nextcloud.js";

function makeConfig(overrides: Partial<NextcloudConfig> = {}): NextcloudConfig {
  return {
    baseUrl: "https://cloud.example.com",
    botSecret: "super-secret",
    webhookHost: "127.0.0.1",
    webhookPort: 0,
    webhookPath: "/nextcloud-talk-webhook",
    apiUser: "",
    apiPassword: "",
    ...overrides,
  };
}

describe("NextcloudTransport", () => {
  it("uses the raw room token in the workspace key", () => {
    expect(normalizeNextcloudRoomWorkspaceKey("room-abc")).toBe("nextcloud_room_room-abc");
    expect(normalizeNextcloudRoomWorkspaceKey(" room-abc ")).toBe("nextcloud_room_room-abc");
    expect(normalizeNextcloudRoomWorkspaceKey("room:room-abc")).toBe("nextcloud_room_room-abc");
  });

  const transports: NextcloudTransport[] = [];

  afterEach(() => {
    for (const transport of transports.splice(0)) {
      transport.stop();
    }
  });

  it("starts a webhook server and serves healthz", async () => {
    const transport = new NextcloudTransport(makeConfig());
    transports.push(transport);

    transport.listen(() => {});
    await transport.waitUntilReady();

    const response = await fetch(`${serverBaseUrl(transport)}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("accepts signed webhook messages and emits inbound metadata", async () => {
    const transport = new NextcloudTransport(makeConfig());
    transports.push(transport);

    const messagePromise = new Promise<InboundMessage>((resolve) => {
      transport.listen(resolve);
    });
    await transport.waitUntilReady();

    const payload = {
      type: "Create",
      actor: { id: "users/alice", name: "Alice" },
      object: {
        id: 123,
        type: "chat",
        name: "message",
        content: JSON.stringify({ message: "hello from nextcloud" }),
      },
      target: { id: "room-abc", name: "Alice + Bot" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: makeConfig().botSecret,
    });

    const response = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": random,
        "X-Nextcloud-Talk-Signature": signature,
        "X-Nextcloud-Talk-Backend": "https://cloud.example.com",
      },
      body,
    });

    expect(response.status).toBe(200);
    const message = await messagePromise;
    expect(message).toEqual({
      kind: "message",
      sender: "room-abc",
      text: "hello from nextcloud",
      attachments: [],
      meta: {
        transport: "nextcloud",
        messageId: "123",
        roomToken: "room-abc",
        roomName: "Alice + Bot",
        senderId: "users/alice",
        senderName: "Alice",
        backend: "https://cloud.example.com",
        authSender: "users/alice",
        target: "room-abc",
      },
    });
  });

  it("rejects invalid webhook signatures", async () => {
    const transport = new NextcloudTransport(makeConfig());
    transports.push(transport);

    const onMessage = vi.fn();
    transport.listen(onMessage);
    await transport.waitUntilReady();

    const response = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": "abc",
        "X-Nextcloud-Talk-Signature": "wrong",
      },
      body: JSON.stringify({ type: "Create" }),
    });

    expect(response.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("rejects invalid backend origins", async () => {
    const transport = new NextcloudTransport(makeConfig());
    transports.push(transport);

    const onMessage = vi.fn();
    transport.listen(onMessage);
    await transport.waitUntilReady();

    const body = JSON.stringify({ type: "Create", actor: { id: "users/alice" }, target: { id: "room-abc" } });
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: makeConfig().botSecret });

    const response = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": random,
        "X-Nextcloud-Talk-Signature": signature,
        "X-Nextcloud-Talk-Backend": "https://evil.example.com",
      },
      body,
    });

    expect(response.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("rejects oversized webhook bodies", async () => {
    const transport = new NextcloudTransport(makeConfig(), fetch, { maxWebhookBodyBytes: 32 });
    transports.push(transport);

    const onMessage = vi.fn();
    transport.listen(onMessage);
    await transport.waitUntilReady();

    const body = JSON.stringify({
      type: "Create",
      actor: { id: "users/alice" },
      object: { id: 1, content: JSON.stringify({ message: "x".repeat(200) }) },
      target: { id: "room-abc" },
    });
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: makeConfig().botSecret });

    const response = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": random,
        "X-Nextcloud-Talk-Signature": signature,
      },
      body,
    });

    expect(response.status).toBe(413);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("times out slow webhook bodies", async () => {
    const transport = new NextcloudTransport(makeConfig(), fetch, { webhookBodyTimeoutMs: 25 });
    transports.push(transport);

    const onMessage = vi.fn();
    transport.listen(onMessage);
    await transport.waitUntilReady();

    const body = JSON.stringify({
      type: "Create",
      actor: { id: "users/alice" },
      object: { id: 1, content: JSON.stringify({ message: "hello" }) },
      target: { id: "room-abc" },
    });
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: makeConfig().botSecret });

    const response = await postSlowBody(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, body, {
      "Content-Type": "application/json",
      "X-Nextcloud-Talk-Random": random,
      "X-Nextcloud-Talk-Signature": signature,
    }, 60);

    expect(response.statusCode).toBe(408);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores replayed webhook deliveries", async () => {
    const transport = new NextcloudTransport(makeConfig());
    transports.push(transport);

    const onMessage = vi.fn();
    transport.listen(onMessage);
    await transport.waitUntilReady();

    const body = JSON.stringify({
      type: "Create",
      actor: { id: "users/alice", name: "Alice" },
      object: { id: 123, content: JSON.stringify({ message: "hello" }) },
      target: { id: "room-abc", name: "Alice + Bot" },
    });
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: makeConfig().botSecret });

    const first = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": random,
        "X-Nextcloud-Talk-Signature": signature,
      },
      body,
    });
    const second = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": random,
        "X-Nextcloud-Talk-Signature": signature,
      },
      body,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1));
  });

  it("ignores non-Create events", async () => {
    const transport = new NextcloudTransport(makeConfig());
    transports.push(transport);

    const onMessage = vi.fn();
    transport.listen(onMessage);
    await transport.waitUntilReady();

    const body = JSON.stringify({ type: "Update", actor: { id: "users/alice" }, target: { id: "room-abc" } });
    const { random, signature } = generateNextcloudTalkSignature({ body, secret: makeConfig().botSecret });

    const response = await fetch(`${serverBaseUrl(transport)}${makeConfig().webhookPath}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Nextcloud-Talk-Random": random,
        "X-Nextcloud-Talk-Signature": signature,
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("sends outbound text to the explicit target room and signs the message text", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ ocs: { data: { id: 1 } } }), { status: 200 });
    });
    const transport = new NextcloudTransport(makeConfig(), fetchMock as typeof fetch);

    await transport.send(normalizeNextcloudRoomWorkspaceKey("room-abc"), "Hello room", { target: "room-abc" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cloud.example.com/ocs/v2.php/apps/spreed/api/v1/bot/room-abc/message");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ message: "Hello room" }));

    const headers = init.headers as Record<string, string>;
    const random = headers["X-Nextcloud-Talk-Bot-Random"];
    const signature = headers["X-Nextcloud-Talk-Bot-Signature"];

    expect(verifyNextcloudTalkSignature({
      signature,
      random,
      body: "Hello room",
      secret: makeConfig().botSecret,
    })).toBe(true);
    expect(verifyNextcloudTalkSignature({
      signature,
      random,
      body: JSON.stringify({ message: "Hello room" }),
      secret: makeConfig().botSecret,
    })).toBe(false);
  });

  it("requires an explicit target room token for outbound sends", async () => {
    const transport = new NextcloudTransport(makeConfig());
    await expect(
      transport.send(normalizeNextcloudRoomWorkspaceKey("room-abc"), "follow-up without explicit target"),
    ).rejects.toThrow("explicit target room token");
  });
});

function serverBaseUrl(transport: NextcloudTransport): string {
  const server = (transport as unknown as { server?: { address(): string | import("node:net").AddressInfo | null } }).server;
  const address = server?.address();
  if (!address || typeof address === "string") {
    throw new Error("Nextcloud test transport is not listening on a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postSlowBody(
  url: string,
  body: string,
  headers: Record<string, string>,
  delayMs: number,
): Promise<{ statusCode: number }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0 }));
    });

    req.on("error", reject);
    req.write(body.slice(0, 1));
    setTimeout(() => {
      req.write(body.slice(1));
      req.end();
    }, delayMs);
  });
}
