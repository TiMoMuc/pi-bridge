import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableIngressQueue } from "../src/inbox-queue.js";
import type { InboundMessage } from "../src/transport.js";

function makeMessage(text: string): InboundMessage {
  return {
    sender: "+15551234567",
    text,
    attachments: [],
    meta: {
      transport: "signal",
      senderId: "+15551234567",
    },
  };
}

describe("DurableIngressQueue", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "inbox-queue-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stores and removes pending inbound entries", async () => {
    const queue = new DurableIngressQueue(tmpDir);

    const first = await queue.enqueue({
      correlationId: "inbound_a",
      workspaceKey: "ws_a",
      message: makeMessage("hello"),
    });
    const second = await queue.enqueue({
      correlationId: "inbound_b",
      workspaceKey: "ws_b",
      message: makeMessage("world"),
    });

    const pending = await queue.list();
    expect(pending.map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(pending.map((entry) => entry.workspaceKey)).toEqual(["ws_a", "ws_b"]);

    await queue.delete("ws_a", first.id);
    const remaining = await queue.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(second.id);
  });
});
