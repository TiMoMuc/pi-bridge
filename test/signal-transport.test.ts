import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { InboundMessage, TransportAttachment } from "../src/transport.js";
import { SignalTransport, computeReconnectDelay } from "../src/transports/signal.js";
import { SignalMessageRefStore } from "../src/transports/signal-message-refs.js";
import type {
  SignalAttachmentSource,
  SignalReactionTarget,
  SignalRoute,
  SignalSendResult,
} from "../src/transports/signal-client.js";

type SignalClientLike = {
  baseUrl: string;
  phoneNumber: string;
  send: ReturnType<typeof vi.fn<(route: SignalRoute, message: string, attachments?: string[], textStyles?: string[]) => Promise<SignalSendResult>>>;
  sendReaction: ReturnType<typeof vi.fn<(route: SignalRoute, emoji: string, target: SignalReactionTarget) => Promise<void>>>;
  waitUntilReady: ReturnType<typeof vi.fn<(timeoutMs?: number) => Promise<void>>>;
  getAttachment: ReturnType<typeof vi.fn<(attachmentId: string, source: SignalAttachmentSource) => Promise<string>>>;
};

function createClient(baseUrl: string, overrides: Partial<SignalClientLike> = {}): SignalClientLike {
  return {
    baseUrl,
    phoneNumber: "+15550000000",
    send: vi.fn().mockResolvedValue({}),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    waitUntilReady: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(""),
    ...overrides,
  };
}

describe("SignalTransport", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "signal-transport-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("forwards direct sends with text styles", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);

    await transport.send("+15551234567", "hello", {
      attachments: ["/tmp/file.txt"],
      textStyles: ["0:5:BOLD"],
    });

    expect(client.send).toHaveBeenCalledWith(
      { kind: "direct", recipient: "+15551234567" },
      "hello",
      ["/tmp/file.txt"],
      ["0:5:BOLD"],
    );
  });

  it("routes outbound group sends through groupId", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);

    await transport.send("+15551234567", "hello group", {
      target: "group-123",
    });

    expect(client.send).toHaveBeenCalledWith(
      { kind: "group", groupId: "group-123", recipient: "+15551234567" },
      "hello group",
      undefined,
      undefined,
    );
  });

  it("records inbound and outbound message refs when enabled", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    const store = new SignalMessageRefStore(tmpDir);

    await transport.recordInboundMessageRef(
      "+15551234567",
      {
        sender: "+15551234567",
        text: "hello from user",
        attachments: [],
        timestamp: 100,
        meta: { senderId: "+15551234567", senderNumber: "+15551234567", senderUuid: "uuid-user" },
      },
      { sessionFile: "/tmp/s.jsonl", userMessageId: "user1234" },
      "hello from user",
    );
    await transport.recordOutboundMessageRef(
      "+15551234567",
      { sessionFile: "/tmp/s.jsonl", assistantMessageId: "assist123" },
      "hello from assistant",
      { timestamp: 200 },
      0,
      1,
    );

    expect((await store.findBySignalMessage("+15551234567", 100))?.sessionMessageId).toBe("user1234");
    expect((await store.findBySignalMessage("+15550000000", 200))?.sessionMessageId).toBe("assist123");
  });

  it("sends outbound direct reactions by session message id through the reference store", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);

    await transport.recordInboundMessageRef(
      "+15551234567",
      {
        sender: "+15551234567",
        text: "target user message",
        attachments: [],
        timestamp: 1737630212345,
        meta: { senderId: "+15551234567", senderNumber: "+15551234567" },
      },
      { sessionFile: "/tmp/s.jsonl", userMessageId: "abcd1234" },
      "target user message",
    );

    const sent = await transport.sendReactionForSessionMessageId(
      "+15551234567",
      "abcd1234",
      "👍",
    );

    expect(sent).toBe(true);
    expect(client.sendReaction).toHaveBeenCalledWith(
      { kind: "direct", recipient: "+15551234567" },
      "👍",
      { author: "+15551234567", authorUuid: undefined, timestamp: 1737630212345 },
    );
  });

  it("sends outbound group reactions by session message id through the reference store", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);

    await transport.recordInboundMessageRef(
      "group-123",
      {
        sender: "group-123",
        text: "target user message",
        attachments: [],
        timestamp: 1737630212345,
        meta: {
          senderId: "+15551234567",
          senderNumber: "+15551234567",
          senderUuid: "uuid-user",
          groupId: "group-123",
        },
      },
      { sessionFile: "/tmp/s.jsonl", userMessageId: "groupmsg1" },
      "target user message",
    );

    const sent = await transport.sendReactionForSessionMessageId(
      "+15551234567",
      "groupmsg1",
      "👍",
    );

    expect(sent).toBe(true);
    expect(client.sendReaction).toHaveBeenCalledWith(
      { kind: "group", groupId: "group-123", recipient: "+15551234567" },
      "👍",
      { author: "+15551234567", authorUuid: "uuid-user", timestamp: 1737630212345 },
    );
  });

  it("returns false for outbound reactions when no matching session message exists", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);

    const sent = await transport.sendReactionForSessionMessageId(
      "+15551234567",
      "deadbeef",
      "👍",
    );

    expect(sent).toBe(false);
    expect(client.sendReaction).not.toHaveBeenCalled();
  });

  it("records inbound message refs for later reaction resolution", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    const store = new SignalMessageRefStore(tmpDir);

    await transport.recordInboundMessageRef(
      "+15551234567",
      { sender: "+15551234567", text: "hello from user", attachments: [], timestamp: 100 },
      { sessionFile: "/tmp/s.jsonl", userMessageId: "user1234" },
      "hello from user",
    );

    expect((await store.findBySignalMessage("+15551234567", 100))?.sessionMessageId).toBe("user1234");
    expect(await transport.sendReactionForSessionMessageId("+15551234567", "user1234", "👍")).toBe(true);
  });

  it("emits normalized inbound direct messages from SSE receive events", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        sourceUuid: "uuid-user",
        sourceName: "Ada",
        dataMessage: {
          message: "hello from signal",
          timestamp: 123,
          attachments: [
            {
              id: "att-1",
              contentType: "image/png",
              filename: "photo.png",
              size: 42,
            },
          ],
        },
      },
    };
    const server = await startSseServer(() => [payload]);
    const client = createClient(server.baseUrl);
    const transport = new SignalTransport(server.baseUrl, client.phoneNumber, tmpDir, client, {
      initialMs: 10,
      maxMs: 20,
      jitter: 0,
    });

    const message = await new Promise<InboundMessage>((resolve) => {
      transport.listen((incoming) => {
        transport.stop();
        resolve(incoming);
      });
    });

    expect(message.sender).toBe("+15551234567");
    expect(message.text).toBe("hello from signal");
    expect(message.meta).toEqual(expect.objectContaining({
      transport: "signal",
      conversationId: "+15551234567",
      conversationKind: "direct",
      senderId: "+15551234567",
      senderNumber: "+15551234567",
      senderUuid: "uuid-user",
      senderName: "Ada",
      authSender: "+15551234567",
      recipient: "+15551234567",
    }));
    expect(message.attachments[0]?.metadata).toEqual(expect.objectContaining({
      fetchSource: { kind: "direct", recipient: "+15551234567" },
    }));

    await server.close();
  });

  it("emits normalized inbound group messages from SSE receive events", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        sourceUuid: "uuid-user",
        sourceName: "Ada",
        dataMessage: {
          message: "hello from group",
          timestamp: 123,
          attachments: [
            {
              id: "att-1",
              contentType: "image/png",
              filename: "photo.png",
              size: 42,
            },
          ],
          groupInfo: {
            groupId: "group-123",
            groupName: "Project",
          },
        },
      },
    };
    const server = await startSseServer(() => [payload]);
    const client = createClient(server.baseUrl);
    const transport = new SignalTransport(server.baseUrl, client.phoneNumber, tmpDir, client, {
      initialMs: 10,
      maxMs: 20,
      jitter: 0,
    });

    const message = await new Promise<InboundMessage>((resolve) => {
      transport.listen((incoming) => {
        transport.stop();
        resolve(incoming);
      });
    });

    expect(message.sender).toBe("group-123");
    expect(message.text).toBe("hello from group");
    expect(message.meta).toEqual(expect.objectContaining({
      transport: "signal",
      conversationId: "group-123",
      conversationKind: "group",
      groupId: "group-123",
      groupName: "Project",
      senderId: "+15551234567",
      senderNumber: "+15551234567",
      senderUuid: "uuid-user",
      senderName: "Ada",
      authSender: "+15551234567",
      recipient: "+15551234567",
      target: "group-123",
    }));
    expect(message.attachments[0]?.metadata).toEqual(expect.objectContaining({
      fetchSource: { kind: "group", groupId: "group-123", recipient: "+15551234567" },
      groupId: "group-123",
      groupName: "Project",
    }));

    await server.close();
  });

  it("emits inbound group reactions as synthetic feedback events when they target the bot", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        sourceUuid: "uuid-user",
        sourceName: "Ada",
        dataMessage: {
          message: null,
          timestamp: 1774127728207,
          reaction: {
            emoji: "👍",
            targetAuthor: "+15550000000",
            targetAuthorNumber: "+15550000000",
            targetAuthorUuid: "bot-uuid",
            targetSentTimestamp: 1737630212345,
            isRemove: false,
          },
          groupInfo: {
            groupId: "group-123",
            groupName: "Project",
          },
        },
      },
    };
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    await transport.recordOutboundMessageRef(
      "group-123",
      { sessionFile: "/tmp/s.jsonl", assistantMessageId: "assist123" },
      "hello from assistant",
      { timestamp: 1737630212345, results: [{ groupId: "group-123", type: "SUCCESS" }] } as SignalSendResult,
      0,
      1,
    );

    const message = await new Promise<InboundMessage>((resolve) => {
      (transport as unknown as { onMessage: (message: InboundMessage) => void }).onMessage = resolve;

      void (transport as unknown as {
        handleSSEEvent: (eventType: string, data: string) => Promise<void>;
      }).handleSSEEvent("receive", JSON.stringify(payload));
    });

    expect(message).toEqual(expect.objectContaining({
      kind: "event",
      sender: "group-123",
      attachments: [],
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      meta: expect.objectContaining({
        transport: "signal",
        conversationId: "group-123",
        conversationKind: "group",
        groupId: "group-123",
        senderId: "+15551234567",
        recipient: "+15551234567",
        target: "group-123",
      }),
    }));
    expect(message.text).toContain("assist123");
  });

  it("still synthesizes inbound reactions when targetAuthor formatting differs but the timestamp resolves", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        reactionMessage: {
          emoji: "👍",
          targetAuthor: " +1 555 000 0000 ",
          targetSentTimestamp: 1737630212345,
        },
      },
    };
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    await transport.recordOutboundMessageRef(
      "+15551234567",
      { sessionFile: "/tmp/s.jsonl", assistantMessageId: "assist123" },
      "hello from assistant",
      { timestamp: 1737630212345 },
      0,
      1,
    );

    const message = await new Promise<InboundMessage>((resolve) => {
      (transport as unknown as { onMessage: (message: InboundMessage) => void }).onMessage = resolve;

      void (transport as unknown as {
        handleSSEEvent: (eventType: string, data: string) => Promise<void>;
      }).handleSSEEvent("receive", JSON.stringify(payload));
    });

    expect(message.kind).toBe("event");
    expect(message.sender).toBe("+15551234567");
    expect(message.text).toContain("assist123");
  });

  it("parses inbound reactions from syncMessage.sentMessage envelopes too", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        syncMessage: {
          sentMessage: {
            reactionMessage: {
              emoji: "👍",
              targetAuthor: "+15550000000",
              targetSentTimestamp: 1737630212345,
            },
          },
        },
      },
    };
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    await transport.recordOutboundMessageRef(
      "+15551234567",
      { sessionFile: "/tmp/s.jsonl", assistantMessageId: "assist123" },
      "hello from assistant",
      { timestamp: 1737630212345 },
      0,
      1,
    );

    const message = await new Promise<InboundMessage>((resolve) => {
      (transport as unknown as { onMessage: (message: InboundMessage) => void }).onMessage = resolve;

      void (transport as unknown as {
        handleSSEEvent: (eventType: string, data: string) => Promise<void>;
      }).handleSSEEvent("receive", JSON.stringify(payload));
    });

    expect(message.kind).toBe("event");
    expect(message.sender).toBe("+15551234567");
    expect(message.text).toContain("assist123");
  });

  it("reconnects after a dropped SSE stream and recovers without restart", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        dataMessage: {
          message: "after reconnect",
          timestamp: 999,
          attachments: [],
        },
      },
    };

    let connectionCount = 0;
    const server = await startSseServer(() => {
      connectionCount += 1;
      return connectionCount === 1 ? [] : [payload];
    });
    const client = createClient(server.baseUrl);
    const transport = new SignalTransport(server.baseUrl, client.phoneNumber, tmpDir, client, {
      initialMs: 10,
      maxMs: 10,
      jitter: 0,
    });

    const message = await new Promise<InboundMessage>((resolve) => {
      transport.listen((incoming) => {
        transport.stop();
        resolve(incoming);
      });
    });

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(message.text).toBe("after reconnect");
    await server.close();
  });

  it("deduplicates repeated receive events for the same conversation, sender, and timestamp", async () => {
    const payload = {
      envelope: {
        sourceNumber: "+15551234567",
        dataMessage: {
          message: "duplicate",
          timestamp: 456,
          attachments: [],
          groupInfo: { groupId: "group-123", groupName: "Project" },
        },
      },
    };
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    const received: InboundMessage[] = [];

    (transport as unknown as { onMessage: (message: InboundMessage) => void }).onMessage = (incoming) => {
      received.push(incoming);
    };

    await (transport as unknown as {
      handleSSEEvent: (eventType: string, data: string) => Promise<void>;
    }).handleSSEEvent("receive", JSON.stringify(payload));
    await (transport as unknown as {
      handleSSEEvent: (eventType: string, data: string) => Promise<void>;
    }).handleSSEEvent("receive", JSON.stringify(payload));

    expect(received).toHaveLength(1);
  });

  it("fetchAttachment prefers inline attachment data", async () => {
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    const base64 = Buffer.from("inline data").toString("base64");
    const attachment: TransportAttachment = {
      id: "att-1",
      contentType: "text/plain",
      metadata: { data: base64 },
    };

    const result = await transport.fetchAttachment(attachment, "+15551234567");

    expect(result.toString("utf8")).toBe("inline data");
    expect(client.getAttachment).not.toHaveBeenCalled();
  });

  it("fetchAttachment prefers storedFilename before RPC", async () => {
    const storedFilename = path.join(tmpDir, "stored.txt");
    await fs.writeFile(storedFilename, "stored data", "utf8");
    const client = createClient("http://localhost:9999");
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);
    const attachment: TransportAttachment = {
      id: "att-2",
      contentType: "text/plain",
      metadata: { storedFilename },
    };

    const result = await transport.fetchAttachment(attachment, "+15551234567");

    expect(result.toString("utf8")).toBe("stored data");
    expect(client.getAttachment).not.toHaveBeenCalled();
  });

  it("fetchAttachment falls back to getAttachment RPC with direct and group routes", async () => {
    const base64 = Buffer.from("rpc data").toString("base64");
    const client = createClient("http://localhost:9999", {
      getAttachment: vi.fn().mockResolvedValue(base64),
    });
    const transport = new SignalTransport(client.baseUrl, client.phoneNumber, tmpDir, client);

    const directAttachment: TransportAttachment = {
      id: "att-3",
      contentType: "text/plain",
    };
    const groupAttachment: TransportAttachment = {
      id: "att-4",
      contentType: "text/plain",
      metadata: {
        fetchSource: { kind: "group", groupId: "group-123", recipient: "+15557654321" },
      },
    };

    const directResult = await transport.fetchAttachment(directAttachment, "+15557654321");
    const groupResult = await transport.fetchAttachment(groupAttachment, "+15557654321");

    expect(directResult.toString("utf8")).toBe("rpc data");
    expect(groupResult.toString("utf8")).toBe("rpc data");
    expect(client.getAttachment).toHaveBeenNthCalledWith(1, "att-3", { kind: "direct", recipient: "+15557654321" });
    expect(client.getAttachment).toHaveBeenNthCalledWith(2, "att-4", {
      kind: "group",
      groupId: "group-123",
      recipient: "+15557654321",
    });
  });
});

describe("computeReconnectDelay", () => {
  it("grows exponentially up to the configured max", () => {
    const policy = { initialMs: 10, maxMs: 40, factor: 2, jitter: 0, random: () => 0.5 };
    expect(computeReconnectDelay(1, policy)).toBe(10);
    expect(computeReconnectDelay(2, policy)).toBe(20);
    expect(computeReconnectDelay(3, policy)).toBe(40);
    expect(computeReconnectDelay(4, policy)).toBe(40);
  });
});

async function startSseServer(
  payloadsForRequest: () => unknown[],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url !== "/api/v1/events") {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    });

    for (const payload of payloadsForRequest()) {
      res.write(`event: receive\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to resolve test server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

