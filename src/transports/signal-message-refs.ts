import * as fs from "node:fs/promises";
import * as path from "node:path";
import { signalMessageRefsPath } from "../workspace-paths.js";

type MessageRefDirection = "inbound" | "outbound";
type MessageRefRole = "user" | "assistant";

export interface SignalMessageRefRecord {
  recordedAt: string;
  conversation: string;
  direction: MessageRefDirection;
  role: MessageRefRole;
  signalAuthor: string;
  signalAuthorNumber?: string;
  signalAuthorUuid?: string;
  signalTimestamp: number;
  sessionFile: string;
  sessionMessageId: string;
  textPreview: string;
  groupId?: string;
  chunkIndex?: number;
  chunkCount?: number;
}

export class SignalMessageRefStore {
  private readonly filePath: string;

  constructor(bridgeDataDir: string) {
    this.filePath = signalMessageRefsPath(bridgeDataDir);
  }

  async append(record: Omit<SignalMessageRefRecord, "recordedAt">): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const line = JSON.stringify({ recordedAt: new Date().toISOString(), ...record }) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
  }

  async findBySignalMessage(
    signalAuthor: string,
    signalTimestamp: number,
  ): Promise<SignalMessageRefRecord | null> {
    const records = await this.readAll();
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i];
      if (record.signalAuthor === signalAuthor && record.signalTimestamp === signalTimestamp) {
        return record;
      }
    }
    return null;
  }

  async findBySessionMessageId(sessionMessageId: string): Promise<SignalMessageRefRecord[]> {
    const records = await this.readAll();
    return records.filter((record) => record.sessionMessageId === sessionMessageId);
  }

  private async readAll(): Promise<SignalMessageRefRecord[]> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      return raw
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SignalMessageRefRecord);
    } catch {
      return [];
    }
  }
}

export function previewText(text: string, maxLen = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + "…";
}
