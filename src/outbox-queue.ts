import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger, type LogFields } from "./logger.js";
import { bridgeOutboxDir } from "./workspace-paths.js";
import type { PreparedOutboundChunk } from "./outbound-delivery.js";
import type { Transport, TransportName, TransportRunRefs } from "./transport.js";

export interface PendingOutboundEntry {
  id: string;
  createdAt: string;
  correlationId: string;
  workspaceKey: string;
  transportName: TransportName;
  recipient: string;
  chunks: PreparedOutboundChunk[];
  nextChunkIndex: number;
  messageRefConversation?: string;
  refs?: TransportRunRefs;
}

interface OutboundQueueOptions {
  resolveTransport: (transportName: TransportName) => Transport | undefined;
}

export class DurableOutboundQueue {
  private readonly rootDir: string;
  private readonly chains = new Map<string, Promise<void>>();

  constructor(bridgeDataDir: string, private readonly options: OutboundQueueOptions) {
    this.rootDir = bridgeOutboxDir(bridgeDataDir);
  }

  async enqueue(entry: Omit<PendingOutboundEntry, "id" | "createdAt" | "nextChunkIndex">): Promise<PendingOutboundEntry> {
    const pending: PendingOutboundEntry = {
      id: createQueueEntryId("outbox"),
      createdAt: new Date().toISOString(),
      nextChunkIndex: 0,
      ...entry,
    };
    await this.writeEntry(pending);
    getLogger().info("outbox", "queued", "Outbound message queued durably", baseLogFields(pending));
    await this.processWorkspace(pending.workspaceKey);
    return pending;
  }

  async recoverPending(): Promise<void> {
    const entries = await this.list();
    if (entries.length > 0) {
      getLogger().info("outbox", "recovery-start", `Recovering ${entries.length} pending outbox entr${entries.length === 1 ? "y" : "ies"}`, {
        pendingCount: entries.length,
      });
    }
    for (const workspaceKey of new Set(entries.map((entry) => entry.workspaceKey))) {
      await this.processWorkspace(workspaceKey);
    }
  }

  async list(): Promise<PendingOutboundEntry[]> {
    const workspaces = await listDirs(this.rootDir);
    const entries = await Promise.all(workspaces.flatMap((workspaceKey) => {
      const workspaceDir = path.join(this.rootDir, workspaceKey);
      return listJsonFiles(workspaceDir).then((files) => files.map(async (fileName) => {
        const raw = await fs.readFile(path.join(workspaceDir, fileName), "utf8");
        return JSON.parse(raw) as PendingOutboundEntry;
      }));
    }));
    return Promise.all(entries.flat()).then((items) => items.sort(compareByCreatedAt));
  }

  async processWorkspace(workspaceKey: string): Promise<void> {
    const current = this.chains.get(workspaceKey) ?? Promise.resolve();
    const next = current.then(async () => {
      while (true) {
        const entry = await this.firstPendingForWorkspace(workspaceKey);
        if (!entry) return;
        const ok = await this.processEntry(entry);
        if (!ok) return;
      }
    }).catch(() => undefined);
    this.chains.set(workspaceKey, next);
    await next;
  }

  private async processEntry(entry: PendingOutboundEntry): Promise<boolean> {
    const logger = getLogger();
    const transport = this.options.resolveTransport(entry.transportName);
    if (!transport) {
      logger.warn("outbox", "transport-unavailable", `Queued outbound message is waiting for ${entry.transportName}`, {
        correlationId: entry.correlationId,
        workspaceKey: entry.workspaceKey,
        transportName: entry.transportName,
        entryId: entry.id,
      });
      return false;
    }

    for (let index = entry.nextChunkIndex; index < entry.chunks.length; index += 1) {
      const chunk = entry.chunks[index];
      try {
        const sendResult = await transport.send(entry.recipient, chunk.text, chunk.options);
        if (entry.transportName === "signal" && entry.messageRefConversation && supportsMessageReferences(transport) && entry.refs) {
          await transport.recordOutboundMessageRef(
            entry.messageRefConversation,
            entry.refs,
            chunk.text,
            sendResult,
            index,
            entry.chunks.length,
          );
        }
        entry.nextChunkIndex = index + 1;
        if (entry.nextChunkIndex >= entry.chunks.length) {
          await this.delete(entry.workspaceKey, entry.id);
          logger.info("outbox", "delivered", "Queued outbound message delivered", baseLogFields(entry));
          return true;
        }
        await this.writeEntry(entry);
      } catch (err) {
        logger.error("outbox", "send-failed", "Queued outbound message send failed", {
          ...baseLogFields(entry),
          error: err,
        });
        await this.writeEntry(entry);
        return false;
      }
    }

    await this.delete(entry.workspaceKey, entry.id);
    return true;
  }

  private async firstPendingForWorkspace(workspaceKey: string): Promise<PendingOutboundEntry | undefined> {
    const workspaceDir = path.join(this.rootDir, workspaceKey);
    const files = await listJsonFiles(workspaceDir);
    if (files.length === 0) return undefined;
    const items = await Promise.all(files.map(async (fileName) => {
      const raw = await fs.readFile(path.join(workspaceDir, fileName), "utf8");
      return JSON.parse(raw) as PendingOutboundEntry;
    }));
    items.sort(compareByCreatedAt);
    return items[0];
  }

  private async writeEntry(entry: PendingOutboundEntry): Promise<void> {
    const filePath = this.entryPath(entry.workspaceKey, entry.id);
    await writeJsonAtomically(filePath, entry);
  }

  private async delete(workspaceKey: string, id: string): Promise<void> {
    await fs.rm(this.entryPath(workspaceKey, id), { force: true });
  }

  private entryPath(workspaceKey: string, id: string): string {
    return path.join(this.rootDir, workspaceKey, `${id}.json`);
  }
}

interface MessageRefTransport extends Transport {
  recordOutboundMessageRef(
    sender: string,
    refs: TransportRunRefs,
    textPreview: string,
    sendResult: { timestamp?: number },
    chunkIndex: number,
    chunkCount: number,
  ): Promise<void>;
}

function supportsMessageReferences(transport: Transport): transport is MessageRefTransport {
  return "recordOutboundMessageRef" in transport;
}

function baseLogFields(entry: PendingOutboundEntry): LogFields {
  return {
    correlationId: entry.correlationId,
    workspaceKey: entry.workspaceKey,
    entryId: entry.id,
    transportName: entry.transportName,
    recipient: entry.recipient,
    nextChunkIndex: entry.nextChunkIndex,
    chunkCount: entry.chunks.length,
  };
}

function createQueueEntryId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function compareByCreatedAt(a: { createdAt: string }, b: { createdAt: string }): number {
  return a.createdAt.localeCompare(b.createdAt);
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

async function listDirs(rootDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}
