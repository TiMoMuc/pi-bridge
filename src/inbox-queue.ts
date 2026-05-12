import * as fs from "node:fs/promises";
import * as path from "node:path";
import { bridgeInboxDir } from "./workspace-paths.js";
import type { InboundMessage } from "./transport.js";

export interface PendingInboundEntry {
  id: string;
  createdAt: string;
  correlationId: string;
  workspaceKey: string;
  message: InboundMessage;
}

export class DurableIngressQueue {
  private readonly rootDir: string;

  constructor(bridgeDataDir: string) {
    this.rootDir = bridgeInboxDir(bridgeDataDir);
  }

  async enqueue(entry: Omit<PendingInboundEntry, "id" | "createdAt">): Promise<PendingInboundEntry> {
    const pending: PendingInboundEntry = {
      id: createQueueEntryId("inbox"),
      createdAt: new Date().toISOString(),
      ...entry,
    };
    const filePath = this.entryPath(pending.workspaceKey, pending.id);
    await writeJsonAtomically(filePath, pending);
    return pending;
  }

  async delete(workspaceKey: string, id: string): Promise<void> {
    await fs.rm(this.entryPath(workspaceKey, id), { force: true });
  }

  async list(): Promise<PendingInboundEntry[]> {
    const entries = await this.readAll();
    return entries.sort(compareByCreatedAt);
  }

  private async readAll(): Promise<PendingInboundEntry[]> {
    const workspaces = await listDirs(this.rootDir);
    const entries = await Promise.all(workspaces.flatMap((workspaceKey) => {
      const workspaceDir = path.join(this.rootDir, workspaceKey);
      return listJsonFiles(workspaceDir).then((files) => files.map(async (fileName) => {
        const raw = await fs.readFile(path.join(workspaceDir, fileName), "utf8");
        return JSON.parse(raw) as PendingInboundEntry;
      }));
    }));
    return Promise.all(entries.flat());
  }

  private entryPath(workspaceKey: string, id: string): string {
    return path.join(this.rootDir, workspaceKey, `${id}.json`);
  }
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
