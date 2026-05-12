import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignalClient, type SignalRoute } from "../src/transports/signal-client.js";

describe("SignalClient", () => {
  let client: SignalClient;

  beforeEach(() => {
    client = new SignalClient("http://localhost:9999", "+15550000000");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("send() makes a direct-message JSON-RPC POST request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "direct", recipient: "+15551234567" }, "Hello!");

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://localhost:9999/api/v1/rpc");
    expect(init?.method).toBe("POST");

    const body = JSON.parse(init?.body as string) as {
      method: string;
      params: { recipient: string[]; message: string };
    };
    expect(body.method).toBe("send");
    expect(body.params.recipient).toEqual(["+15551234567"]);
    expect(body.params.message).toBe("Hello!");
  });

  it("send() uses groupId for group messages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "group", groupId: "group-123" }, "Hello group");

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(body.method).toBe("send");
    expect(body.params.groupId).toBe("group-123");
    expect(body.params).not.toHaveProperty("recipient");
  });

  it("send() includes attachments when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "direct", recipient: "+15551234567" }, "Here's a file", ["/path/to/file.pdf"]);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      method: string;
      params: { message: string; attachments: string[] };
    };
    expect(body.method).toBe("send");
    expect(body.params.message).toBe("Here's a file");
    expect(body.params.attachments).toEqual(["/path/to/file.pdf"]);
  });

  it("send() includes textStyle when provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "direct", recipient: "+15551234567" }, "Styled", undefined, ["0:6:BOLD"]);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      params: { textStyle: string[] };
    };
    expect(body.params.textStyle).toEqual(["0:6:BOLD"]);
  });

  it("send() omits attachments and textStyle params when empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "direct", recipient: "+15551234567" }, "No extras", [], []);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      params: Record<string, unknown>;
    };
    expect(body.params).not.toHaveProperty("attachments");
    expect(body.params).not.toHaveProperty("textStyle");
  });

  it("send() returns the signal-cli timestamp when present", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { timestamp: 1774113184994 } }), { status: 200 }),
    );

    const result = await client.send({ kind: "direct", recipient: "+15551234567" }, "Hello!");

    expect(result.timestamp).toBe(1774113184994);
  });

  it("sendReaction() sends a direct reaction emoji", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.sendReaction(
      { kind: "direct", recipient: "+15551234567" },
      "👍",
      { author: "+15551234567", timestamp: 1737630212345 },
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      method: string;
      params: { recipient: string[]; emoji: string; targetAuthor: string; targetTimestamp: number };
    };
    expect(body.method).toBe("sendReaction");
    expect(body.params.recipient).toEqual(["+15551234567"]);
    expect(body.params.emoji).toBe("👍");
    expect(body.params.targetAuthor).toBe("+15551234567");
    expect(body.params.targetTimestamp).toBe(1737630212345);
  });

  it("sendReaction() uses groupId and optional targetAuthorUuid for group reactions", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.sendReaction(
      { kind: "group", groupId: "group-123" },
      "🔥",
      { author: "+15551234567", authorUuid: "uuid-123", timestamp: 1737630212345 },
    );

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      params: Record<string, unknown>;
    };
    expect(body.params.groupId).toBe("group-123");
    expect(body.params.targetAuthor).toBe("+15551234567");
    expect(body.params.targetAuthorUuid).toBe("uuid-123");
    expect(body.params.targetTimestamp).toBe(1737630212345);
  });

  it("throws on HTTP error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(client.send({ kind: "direct", recipient: "+15551234567" }, "test")).rejects.toThrow("500");
  });

  it("throws on JSON-RPC error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Not registered" } }), { status: 200 }),
    );

    await expect(client.send({ kind: "direct", recipient: "+15551234567" }, "test")).rejects.toThrow("Not registered");
  });

  it("includes account in RPC params", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "direct", recipient: "+15551234567" }, "Hello!");

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      params: { account: string };
    };
    expect(body.params.account).toBe("+15550000000");
  });

  it("check() probes the HTTP health endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const result = await client.check();

    expect(fetchSpy).toHaveBeenCalledWith("http://localhost:9999/api/v1/check");
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("version() calls the JSON-RPC version method", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: "0.14.0" }), { status: 200 }),
    );

    const result = await client.version();

    expect(result).toBe("0.14.0");
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as { method: string };
    expect(body.method).toBe("version");
  });

  it("waitUntilReady retries until check and version succeed", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      callCount += 1;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (callCount === 1 && url.endsWith("/api/v1/check")) {
        throw new Error("Connection refused");
      }
      if (callCount === 2 && url.endsWith("/api/v1/check")) {
        return new Response("ok", { status: 200 });
      }
      if (callCount === 3 && url.endsWith("/api/v1/rpc")) {
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }
      throw new Error(`unexpected fetch call ${callCount} ${url}`);
    });

    await client.waitUntilReady(10_000);
    expect(callCount).toBe(3);
  });

  it("waitUntilReady throws after timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));

    await expect(client.waitUntilReady(100)).rejects.toThrow("not reachable");
  });

  it("send() handles multiple attachments", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: {} }), { status: 200 }),
    );

    await client.send({ kind: "direct", recipient: "+15551234567" }, "Multiple files", ["/path/a.pdf", "/path/b.jpg"]);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      params: { attachments: string[] };
    };
    expect(body.params.attachments).toEqual(["/path/a.pdf", "/path/b.jpg"]);
  });

  it("getAttachment() fetches a direct attachment by ID", async () => {
    const base64Data = Buffer.from("image content").toString("base64");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { data: base64Data } }), { status: 200 }),
    );

    const result = await client.getAttachment("attachment-id-123", { kind: "direct", recipient: "+15559876543" });

    expect(result).toBe(base64Data);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      method: string;
      params: { id: string; recipient: string };
    };
    expect(body.method).toBe("getAttachment");
    expect(body.params.id).toBe("attachment-id-123");
    expect(body.params.recipient).toBe("+15559876543");
  });

  it("getAttachment() uses groupId for group attachments", async () => {
    const base64Data = Buffer.from("group attachment").toString("base64");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { data: base64Data } }), { status: 200 }),
    );

    const route: SignalRoute = { kind: "group", groupId: "group-123", recipient: "+15559876543" };
    const result = await client.getAttachment("attachment-id-123", route);

    expect(result).toBe(base64Data);
    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as {
      params: Record<string, unknown>;
    };
    expect(body.params.groupId).toBe("group-123");
    expect(body.params.recipient).toBe("+15559876543");
  });

  it("getAttachment() handles string response", async () => {
    const base64Data = Buffer.from("direct string").toString("base64");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: base64Data }), { status: 200 }),
    );

    const result = await client.getAttachment("id", { kind: "direct", recipient: "+1234" });

    expect(result).toBe(base64Data);
  });

  it("getAttachment() throws on unexpected response format", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ result: { unexpected: "format" } }), { status: 200 }),
    );

    await expect(client.getAttachment("id", { kind: "direct", recipient: "+1234" })).rejects.toThrow("Unexpected getAttachment response");
  });
});
