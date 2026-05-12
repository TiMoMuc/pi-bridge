import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bridgeLogsDir } from "./workspace-paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  correlationId?: string;
  workspaceKey?: string;
  event?: string;
  [key: string]: unknown;
}

export interface LogRecord extends LogFields {
  timestamp: string;
  level: LogLevel;
  component: string;
  message: string;
}

const REDACTED_FIELD_NAMES = new Set([
  "authSender",
  "bindingId",
  "groupId",
  "phoneNumber",
  "recipient",
  "roomToken",
  "sender",
  "senderId",
  "senderNumber",
  "senderUuid",
  "target",
  "transportRecipient",
]);

class BridgeLogger {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly logsDir?: string) {}

  debug(component: string, event: string, message: string, fields: LogFields = {}): void {
    this.log("debug", component, event, message, fields);
  }

  info(component: string, event: string, message: string, fields: LogFields = {}): void {
    this.log("info", component, event, message, fields);
  }

  warn(component: string, event: string, message: string, fields: LogFields = {}): void {
    this.log("warn", component, event, message, fields);
  }

  error(component: string, event: string, message: string, fields: LogFields = {}): void {
    this.log("error", component, event, message, fields);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private log(level: LogLevel, component: string, event: string, message: string, fields: LogFields): void {
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      component,
      message,
      ...sanitizeFields({ event, ...fields }),
    };

    this.writeStdout(record);
    if (!this.logsDir) return;

    this.writeChain = this.writeChain
      .then(async () => {
        await fs.mkdir(this.logsDir!, { recursive: true });
        const filePath = path.join(this.logsDir!, `bridge-${record.timestamp.slice(0, 10)}.jsonl`);
        await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
      })
      .catch((err) => {
        const text = err instanceof Error ? err.message : String(err);
        console.error(`[logger] Failed to append persistent log: ${text}`);
      });
  }

  private writeStdout(record: LogRecord): void {
    const prefix = `[${record.component}]`;
    const correlation = typeof record.correlationId === "string" ? ` [${record.correlationId}]` : "";
    const workspace = typeof record.workspaceKey === "string" ? ` (${record.workspaceKey})` : "";
    const details = summarizeFields(record);
    const line = `${prefix}${correlation}${workspace} ${record.message}${details ? ` ${details}` : ""}`;

    if (record.level === "warn") {
      console.warn(line);
      return;
    }
    if (record.level === "error") {
      console.error(line);
      return;
    }
    console.log(line);
  }
}

let currentLogger = new BridgeLogger();

export function initializeLogger(bridgeDataDir: string | undefined): BridgeLogger {
  currentLogger = new BridgeLogger(bridgeDataDir ? bridgeLogsDir(bridgeDataDir) : undefined);
  return currentLogger;
}

export function getLogger(): BridgeLogger {
  return currentLogger;
}

export function resetLoggerForTests(): void {
  currentLogger = new BridgeLogger();
}

export function createCorrelationId(prefix = "run"): string {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${suffix}`;
}

export function redactIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `redacted:${digest}`;
}

function summarizeFields(record: LogRecord): string {
  const entries = Object.entries(record)
    .filter(([key, value]) => !HIDDEN_STDOUT_FIELDS.has(key) && value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return entries.length > 0 ? entries.join(" ") : "";
}

const HIDDEN_STDOUT_FIELDS = new Set(["timestamp", "level", "component", "message"]);

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function sanitizeFields(fields: LogFields): LogFields {
  const sanitized: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    sanitized[key] = sanitizeValue(key, value);
  }
  return sanitized;
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (REDACTED_FIELD_NAMES.has(key) && typeof value === "string") {
    return redactIdentifier(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(key, item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, sanitizeValue(childKey, childValue)]),
    );
  }

  return value;
}
