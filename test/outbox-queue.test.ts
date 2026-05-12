import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DurableOutboundQueue } from "../src/outbox-queue.js";
import { initializeLogger, resetLoggerForTests } from "../src/logger.js";
import type { Transport } from "../src/transport.js";

function makeTransport(sendImpl?: Transport["send"]): Transport {
  return {
    name: "signal",
    maxMessageLength: 4000,
    send: sendImpl ?? (async () => ({})),
    fetchAttachment: async () => Buffer.from(""),
    waitUntilReady: async () => {},
    listen: () => {},
    stop: () => {},
  } as Transport;
}

describe("DurableOutboundQueue", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outbox-queue-test-"));
    initializeLogger(tmpDir);
  });

  afterEach(async () => {
    resetLoggerForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("sends queued chunks immediately and removes the queue entry on success", async () => {
    const send = vi.fn(async () => ({ timestamp: 1 }));
    const queue = new DurableOutboundQueue(tmpDir, {
      resolveTransport: () => makeTransport(send),
    });

    await queue.enqueue({
      correlationId: "out_123",
      workspaceKey: "ws_a7b3c9",
      transportName: "signal",
      recipient: "+15551234567",
      chunks: [
        { text: "hello", options: { target: "+15551234567" } },
        { text: "world", options: { target: "+15551234567" } },
      ],
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(await queue.list()).toEqual([]);
  });

  it("persists nextChunkIndex and resumes on recovery after a partial send failure", async () => {
    const send = vi.fn(async (_recipient: string, message: string) => {
      if (message === "world") {
        throw new Error("network lost");
      }
      return { timestamp: 1 };
    });
    const queue = new DurableOutboundQueue(tmpDir, {
      resolveTransport: () => makeTransport(send),
    });

    await queue.enqueue({
      correlationId: "out_456",
      workspaceKey: "ws_a7b3c9",
      transportName: "signal",
      recipient: "+15551234567",
      chunks: [
        { text: "hello", options: { target: "+15551234567" } },
        { text: "world", options: { target: "+15551234567" } },
      ],
    });

    const [pending] = await queue.list();
    expect(pending?.nextChunkIndex).toBe(1);

    send.mockImplementation(async () => ({ timestamp: 2 }));
    await queue.recoverPending();

    expect(await queue.list()).toEqual([]);
    expect(send).toHaveBeenCalledTimes(3);
  });
});
