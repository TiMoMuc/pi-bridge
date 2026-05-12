/**
 * File-based cron/scheduling system for workspace event files.
 *
 * Unlike the old edge-triggered watcher, this version treats the directory as
 * the source of truth and reconciles it repeatedly. That makes event delivery
 * resilient to missed filesystem notifications and startup races.
 *
 * How it works:
 *   1. Reconciles eventsDir/ for .json files on start and on a small polling loop
 *   2. Each file is a ScheduledEvent (see type below)
 *   3. immediate events: fire once, then delete the file
 *   4. one-shot events: schedule a timer, then delete the file after firing
 *   5. periodic events: schedule a cron job while the file exists
 */

import { Cron } from "croner";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { readFile as defaultReadFile } from "node:fs/promises";
import { join } from "node:path";

// ============================================================================
// Event Types
// ============================================================================

export interface ImmediateEvent {
  type: "immediate";
  text: string;
}

export interface OneShotEvent {
  type: "one-shot";
  text: string;
  at: string; // ISO 8601 with timezone offset
}

export interface PeriodicEvent {
  type: "periodic";
  text: string;
  schedule: string; // cron syntax
  timezone: string; // IANA timezone
}

export type ScheduledEvent = ImmediateEvent | OneShotEvent | PeriodicEvent;

export interface FiredScheduledEvent {
  filename: string;
  filePath: string;
  rawContent: string;
  event: ScheduledEvent;
}

export interface EventsWatcherOptions {
  eventsDir: string;
  onFire: (fired: FiredScheduledEvent) => void;
}

export interface EventsWatcherDeps {
  now?: () => number;
  readFile?: typeof defaultReadFile;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  sleep?: (ms: number) => Promise<void>;
}

interface TrackedFile {
  fingerprint: string;
}

// ============================================================================
// EventsWatcher
// ============================================================================

const POLL_INTERVAL_MS = 100;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 100;

export class EventsWatcher {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly crons = new Map<string, Cron>();
  private readonly trackedFiles = new Map<string, TrackedFile>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;
  private readonly readFileFn: typeof defaultReadFile;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private stopPromise: Promise<void> | null = null;
  private startTime: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileTask: Promise<void> | null = null;
  private reconcileRequested = false;

  constructor(
    private readonly options: EventsWatcherOptions,
    deps: EventsWatcherDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.readFileFn = deps.readFile ?? defaultReadFile;
    this.setTimeoutFn = deps.setTimeout ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeout ?? clearTimeout;
    this.setIntervalFn = deps.setInterval ?? setInterval;
    this.clearIntervalFn = deps.clearInterval ?? clearInterval;
    this.sleepFn = deps.sleep ?? sleep;
    this.startTime = this.now();
  }

  /** Start watching for events. */
  start(): void {
    const { eventsDir } = this.options;
    this.startTime = this.now();
    this.stopPromise = null;
    this.reconcileRequested = false;

    if (!existsSync(eventsDir)) {
      mkdirSync(eventsDir, { recursive: true });
    }

    console.log(`[events] Watcher starting, dir: ${eventsDir}`);
    this.requestReconcile();
    this.pollTimer = this.setIntervalFn(() => this.requestReconcile(), POLL_INTERVAL_MS);
    console.log(`[events] Watcher started, polling every ${POLL_INTERVAL_MS}ms`);
  }

  /** Stop watching and wait for any in-flight file handling to finish. */
  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      if (this.pollTimer) {
        this.clearIntervalFn(this.pollTimer);
        this.pollTimer = null;
      }

      await this.reconcileTask?.catch(() => undefined);
      await Promise.allSettled(this.inFlight);

      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();

      for (const cron of this.crons.values()) cron.stop();
      this.crons.clear();

      this.trackedFiles.clear();
      this.reconcileRequested = false;
      console.log("[events] Watcher stopped");
    })();

    return this.stopPromise;
  }

  async reconcileNow(): Promise<void> {
    if (this.stopPromise) return;
    this.requestReconcile();
    await this.reconcileTask?.catch(() => undefined);
    await Promise.allSettled(this.inFlight);
  }

  private track(task: Promise<void>): Promise<void> {
    this.inFlight.add(task);
    void task.finally(() => {
      this.inFlight.delete(task);
    });
    return task;
  }

  private requestReconcile(): void {
    if (this.stopPromise) return;
    if (this.reconcileTask) {
      this.reconcileRequested = true;
      return;
    }

    this.reconcileTask = (async () => {
      try {
        do {
          this.reconcileRequested = false;
          await this.reconcileDirectory();
        } while (this.reconcileRequested && !this.stopPromise);
      } catch (err) {
        console.error("[events] Reconcile loop failed:", err);
      } finally {
        this.reconcileTask = null;
      }
    })();
  }

  private async reconcileDirectory(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(this.options.eventsDir)
        .filter((filename) => filename.endsWith(".json"))
        .sort();
    } catch (err) {
      console.warn("[events] Failed to read events directory:", err);
      return;
    }

    const currentFiles = new Set(files);
    for (const filename of this.trackedFiles.keys()) {
      if (!currentFiles.has(filename)) {
        console.log(`[events] File deleted: ${filename}`);
        this.forgetFile(filename);
      }
    }

    for (const filename of files) {
      const task = this.track(this.reconcileFile(filename));
      try {
        await task;
      } catch (err) {
        console.error(`[events] Failed to reconcile ${filename}:`, err);
      }
    }
  }

  private async reconcileFile(filename: string): Promise<void> {
    const filePath = join(this.options.eventsDir, filename);

    let event: ScheduledEvent | null = null;
    let rawContent = "";
    let lastError: Error | null = null;

    for (let i = 0; i < MAX_RETRIES; i += 1) {
      try {
        const content = await this.readFileFn(filePath, "utf-8");
        rawContent = content;
        event = this.parseEvent(content, filename);
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (isErrnoCode(lastError, "ENOENT")) {
          this.forgetFile(filename);
          return;
        }
        if (i < MAX_RETRIES - 1) {
          await this.sleepFn(RETRY_BASE_MS * 2 ** i);
        }
      }
    }

    if (!event) {
      console.warn(
        `[events] Failed to parse after ${MAX_RETRIES} retries: ${filename}`,
        lastError?.message,
      );
      this.deleteFile(filename);
      return;
    }

    const previous = this.trackedFiles.get(filename);
    if (previous?.fingerprint === rawContent) {
      return;
    }

    this.forgetFile(filename);

    if (this.processEvent(filename, filePath, rawContent, event)) {
      this.trackedFiles.set(filename, { fingerprint: rawContent });
    }
  }

  private parseEvent(content: string, filename: string): ScheduledEvent {
    const data = JSON.parse(content) as Record<string, unknown>;

    if (!data.type || !data.text) {
      throw new Error(`Missing required fields (type, text) in ${filename}`);
    }

    const eventType = typeof data.type === "string" ? data.type : "";

    switch (eventType) {
      case "immediate":
        return {
          type: "immediate",
          text: data.text as string,
        };

      case "one-shot":
        if (!data.at) throw new Error(`Missing 'at' field for one-shot event in ${filename}`);
        return {
          type: "one-shot",
          text: data.text as string,
          at: data.at as string,
        };

      case "periodic":
        if (!data.schedule)
          throw new Error(`Missing 'schedule' field for periodic event in ${filename}`);
        if (!data.timezone)
          throw new Error(`Missing 'timezone' field for periodic event in ${filename}`);
        return {
          type: "periodic",
          text: data.text as string,
          schedule: data.schedule as string,
          timezone: data.timezone as string,
        };

      default:
        throw new Error(`Unknown event type '${eventType}' in ${filename}`);
    }
  }

  private processEvent(
    filename: string,
    filePath: string,
    rawContent: string,
    event: ScheduledEvent,
  ): boolean {
    switch (event.type) {
      case "immediate":
        return this.handleImmediate(filename, filePath, rawContent, event);
      case "one-shot":
        return this.handleOneShot(filename, filePath, rawContent, event);
      case "periodic":
        return this.handlePeriodic(filename, filePath, rawContent, event);
    }
  }

  private handleImmediate(
    filename: string,
    filePath: string,
    rawContent: string,
    event: ImmediateEvent,
  ): boolean {
    try {
      const stat = statSync(filePath);
      if (stat.mtimeMs < this.startTime) {
        console.log(`[events] Stale immediate event, deleting: ${filename}`);
        this.deleteFile(filename);
        return false;
      }
    } catch {
      this.forgetFile(filename);
      return false;
    }

    console.log(`[events] Executing immediate event: ${filename}`);
    this.options.onFire({ filename, filePath, rawContent, event });
    this.deleteFile(filename);
    return false;
  }

  private handleOneShot(
    filename: string,
    filePath: string,
    rawContent: string,
    event: OneShotEvent,
  ): boolean {
    const atTime = new Date(event.at).getTime();
    const now = this.now();

    if (atTime <= now) {
      console.log(`[events] One-shot event in the past, deleting: ${filename}`);
      this.deleteFile(filename);
      return false;
    }

    const delay = atTime - now;
    console.log(`[events] Scheduling one-shot: ${filename} in ${Math.round(delay / 1000)}s`);

    const timer = this.setTimeoutFn(() => {
      this.timers.delete(filename);
      console.log(`[events] Executing one-shot event: ${filename}`);
      this.options.onFire({ filename, filePath, rawContent, event });
      this.deleteFile(filename);
    }, delay);

    this.timers.set(filename, timer);
    return true;
  }

  private handlePeriodic(
    filename: string,
    filePath: string,
    rawContent: string,
    event: PeriodicEvent,
  ): boolean {
    try {
      const cron = new Cron(event.schedule, { timezone: event.timezone }, () => {
        console.log(`[events] Executing periodic event: ${filename}`);
        this.options.onFire({ filename, filePath, rawContent, event });
      });

      this.crons.set(filename, cron);
      const next = cron.nextRun();
      console.log(
        `[events] Scheduled periodic: ${filename}, next: ${next?.toISOString() ?? "unknown"}`,
      );
      return true;
    } catch (err) {
      console.warn(
        `[events] Invalid cron schedule for ${filename}: ${event.schedule}`,
        String(err),
      );
      this.deleteFile(filename);
      return false;
    }
  }

  private cancelScheduled(filename: string): void {
    const timer = this.timers.get(filename);
    if (timer) {
      this.clearTimeoutFn(timer);
      this.timers.delete(filename);
    }

    const cron = this.crons.get(filename);
    if (cron) {
      cron.stop();
      this.crons.delete(filename);
    }
  }

  private forgetFile(filename: string): void {
    this.cancelScheduled(filename);
    this.trackedFiles.delete(filename);
  }

  private deleteFile(filename: string): void {
    const filePath = join(this.options.eventsDir, filename);
    try {
      unlinkSync(filePath);
    } catch (err) {
      if (err instanceof Error && !isErrnoCode(err, "ENOENT")) {
        console.warn(`[events] Failed to delete: ${filename}`, String(err));
      }
    }
    this.forgetFile(filename);
  }
}

function isErrnoCode(err: Error, code: string): boolean {
  return "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
