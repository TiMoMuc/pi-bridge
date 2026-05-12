import { describe, it, expect, afterEach } from "vitest";
import { SessionWatchServer, type SessionWatchEvent } from "../src/session-watch.js";

function createServer(enabled = true): SessionWatchServer {
  return new SessionWatchServer({
    enabled,
    bindHost: "127.0.0.1",
    port: 0,
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
        }
        : undefined
    ),
  });
}

describe("SessionWatchServer", () => {
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
    const ok = await fetch(`http://127.0.0.1:${port}/watch/ws_live123`);
    const missing = await fetch(`http://127.0.0.1:${port}/watch/ws_missing`);

    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    expect(await ok.text()).toContain("Live Session Watch: ws_live123");
    expect(missing.status).toBe(404);
  });

  it("streams live SSE events for a workspace", async () => {
    const server = createServer(true);
    servers.push(server);
    await server.start();

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/watch/ws_live123/events`);
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
    const response = await fetch(`http://127.0.0.1:${port}/watch/ws_live123/events`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing SSE reader");

    await reader.read();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
