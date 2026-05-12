import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getLogger, initializeLogger, resetLoggerForTests } from "../src/logger.js";

describe("logger", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "logger-test-"));
    initializeLogger(tmpDir);
  });

  afterEach(async () => {
    resetLoggerForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes persistent JSONL records under admin/logs with redacted identifiers", async () => {
    const logger = getLogger();
    logger.info("bridge", "inbound-accepted", "Accepted inbound message", {
      correlationId: "inbound_123",
      workspaceKey: "ws_a7b3c9",
      bindingId: "+15551234567",
    });
    await logger.flush();

    const logsDir = path.join(tmpDir, "admin", "logs");
    const files = await fs.readdir(logsDir);
    expect(files).toHaveLength(1);

    const raw = await fs.readFile(path.join(logsDir, files[0]), "utf8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]) as {
      component: string;
      event: string;
      bindingId: string;
      workspaceKey: string;
      correlationId: string;
    };
    expect(record.component).toBe("bridge");
    expect(record.event).toBe("inbound-accepted");
    expect(record.workspaceKey).toBe("ws_a7b3c9");
    expect(record.correlationId).toBe("inbound_123");
    expect(record.bindingId).toMatch(/^redacted:/);
    expect(record.bindingId).not.toContain("15551234567");
  });
});
