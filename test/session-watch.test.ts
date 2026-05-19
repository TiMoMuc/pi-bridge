import { describe, it, expect, afterEach } from "vitest";
import {
  SessionWatchServer,
  sessionWatchEventsPath,
  sessionWatchLocalUrl,
  sessionWatchPath,
  sessionWatchPublicUrl,
  type SessionWatchEvent,
} from "../src/session-watch.js";

function createServer(enabled = true): SessionWatchServer {
  return new SessionWatchServer({
    enabled,
    bindHost: "127.0.0.1",
    port: 0,
    publicBaseUrl: undefined,
  }, {
    getWorkspace: (workspaceKey: string) => (
      workspaceKey === "ws_live123"
        ? {
          createdAt: "2026-04-22T00:00:00.000Z",
          lastSeen: "2026-04-22T00:00:00.000Z",
          status: "active",
          workspacePath: "ws_live123",
          primaryTransport: "signal",
          transports: { signal: { sender: "+15551234567" } },
          sessionWatch: { enabled: true, token: "watch-token" },
        }
        : undefined
    ),
  });
}

describe("SessionWatchServer", () => {
  it("builds tokenized local and public watch URLs", () => {
    expect(sessionWatchPath("ws_live123", "tok/with spaces")).toBe("/watch/ws_live123/tok%2Fwith%20spaces");
    expect(sessionWatchEventsPath("ws_live123", "secret")).toBe("/watch/ws_live123/secret/events");
    expect(sessionWatchLocalUrl("0.0.0.0", 8791, "ws_live123", "secret")).toBe(
      "http://localhost:8791/watch/ws_live123/secret",
    );
    expect(sessionWatchPublicUrl("https://watch.example.com/base/", "ws_live123", "secret")).toBe(
      "https://watch.example.com/base/watch/ws_live123/secret",
    );
  });

  const servers: SessionWatchServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
  });

  it("does not start when disabled", async () => {
    const server = createServer(false);
    servers.push(server);

    await server.start();

    expect(server.address()).toBeNull();
  });

  it("serves a localhost watch page for known workspaces", async () => {
    const server = createServer(true);
    servers.push(server);
    await server.start();

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const ok = await fetch(`http://127.0.0.1:${port}/watch/ws_live123/watch-token`);
    const wrongToken = await fetch(`http://127.0.0.1:${port}/watch/ws_live123/wrong-token`);
    const missing = await fetch(`http://127.0.0.1:${port}/watch/ws_missing/watch-token`);

    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    expect(await ok.text()).toContain("Live Session Watch: ws_live123");
    expect(wrongToken.status).toBe(404);
    expect(missing.status).toBe(404);
  });

  it("streams live SSE events for a workspace", async () => {
    const server = createServer(true);
    servers.push(server);
    await server.start();

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/watch/ws_live123/watch-token/events`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE reader");

    const event: SessionWatchEvent = {
      type: "tool_start",
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "bash",
      summary: "$ npm test",
    };

    server.publish("ws_live123", event);

    const decoder = new TextDecoder();
    let combined = "";
    for (let i = 0; i < 5 && !combined.includes('"tool_start"'); i += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      combined += decoder.decode(chunk.value, { stream: true });
    }

    expect(combined).toContain(": connected");
    expect(combined).toContain('"type":"tool_start"');
    expect(combined).toContain('"summary":"$ npm test"');

    await reader.cancel();
  });

  it("stop() closes active SSE streams so shutdown does not hang", async () => {
    const server = createServer(true);
    servers.push(server);
    await server.start();

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/watch/ws_live123/watch-token/events`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE reader");

    await reader.read();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
