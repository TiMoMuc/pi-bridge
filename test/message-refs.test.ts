import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SignalMessageRefStore, previewText } from "../src/transports/signal-message-refs.js";

describe("SignalMessageRefStore", () => {
  let tmpDir: string;
  let store: SignalMessageRefStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "message-ref-store-test-"));
    store = new SignalMessageRefStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends and looks up a record by Signal identity", async () => {
    await store.append({
      conversation: "+491738140746",
      direction: "inbound",
      role: "user",
      signalAuthor: "+491738140746",
      signalTimestamp: 1774113184994,
      sessionFile: "/workspace/users/+491738140746/sessions/test.jsonl",
      sessionMessageId: "abcd1234",
      textPreview: "Hello from Signal",
    });

    const found = await store.findBySignalMessage("+491738140746", 1774113184994);
    expect(found?.sessionMessageId).toBe("abcd1234");
    expect(found?.textPreview).toBe("Hello from Signal");
  });

  it("returns all records for a session message id", async () => {
    await store.append({
      conversation: "+491738140746",
      direction: "outbound",
      role: "assistant",
      signalAuthor: "+10000000000",
      signalTimestamp: 1,
      sessionFile: "/workspace/users/+491738140746/sessions/test.jsonl",
      sessionMessageId: "assist1",
      textPreview: "Chunk one",
      chunkIndex: 0,
      chunkCount: 2,
    });
    await store.append({
      conversation: "+491738140746",
      direction: "outbound",
      role: "assistant",
      signalAuthor: "+10000000000",
      signalTimestamp: 2,
      sessionFile: "/workspace/users/+491738140746/sessions/test.jsonl",
      sessionMessageId: "assist1",
      textPreview: "Chunk two",
      chunkIndex: 1,
      chunkCount: 2,
    });

    const found = await store.findBySessionMessageId("assist1");
    expect(found).toHaveLength(2);
    expect(found.map((entry) => entry.signalTimestamp)).toEqual([1, 2]);
  });
});

describe("previewText", () => {
  it("normalizes whitespace and truncates long text", () => {
    expect(previewText("hello\n\nworld")).toBe("hello world");
    expect(previewText("a".repeat(100), 10)).toBe("aaaaaaaaa…");
  });
});
