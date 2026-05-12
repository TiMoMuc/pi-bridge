import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { EventsWatcher, type EventsWatcherDeps, type ScheduledEvent } from "../src/events.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

describe("EventsWatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "events-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates events directory if it does not exist", async () => {
    const eventsDir = path.join(tmpDir, "nonexistent", "events");
    const watcher = new EventsWatcher({
      eventsDir,
      onFire: () => {},
    });

    watcher.start();
    await watcher.reconcileNow();
    await watcher.stop();

    await expect(fs.stat(eventsDir)).resolves.toBeTruthy();
  });

  it("fires an immediate event written after start", async () => {
    const fired: ScheduledEvent[] = [];
    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: ({ event }) => fired.push(event),
    });

    watcher.start();

    await fs.writeFile(
      path.join(tmpDir, "test-immediate.json"),
      JSON.stringify({
        type: "immediate",
        text: "Hello from immediate",
      }),
    );

    await watcher.reconcileNow();
    await watcher.stop();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.type).toBe("immediate");
    expect(fired[0]?.text).toBe("Hello from immediate");
  });

  it("deletes immediate event file after firing", async () => {
    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: () => {},
    });

    watcher.start();

    const filePath = path.join(tmpDir, "delete-me.json");
    await fs.writeFile(filePath, JSON.stringify({ type: "immediate", text: "x" }));

    await watcher.reconcileNow();
    await watcher.stop();

    expect(await pathExists(filePath)).toBe(false);
  });

  it("does not fire stale immediate events (created before start)", async () => {
    const filePath = path.join(tmpDir, "stale.json");
    await fs.writeFile(filePath, JSON.stringify({ type: "immediate", text: "stale" }));
    const stale = new Date("2000-01-01T00:00:00.000Z");
    await fs.utimes(filePath, stale, stale);

    const fired: ScheduledEvent[] = [];
    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: ({ event }) => fired.push(event),
    });

    watcher.start();
    await watcher.reconcileNow();
    await watcher.stop();

    expect(fired).toHaveLength(0);
  });

  it("does not fire one-shot events in the past", async () => {
    const fired: ScheduledEvent[] = [];

    await fs.writeFile(
      path.join(tmpDir, "past.json"),
      JSON.stringify({
        type: "one-shot",
        text: "past event",
        at: "2000-01-01T00:00:00.000Z",
      }),
    );

    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: ({ event }) => fired.push(event),
    });

    watcher.start();
    await watcher.reconcileNow();
    await watcher.stop();

    expect(fired).toHaveLength(0);
  });

  it("schedules a periodic event with croner", async () => {
    const fired: ScheduledEvent[] = [];

    await fs.writeFile(
      path.join(tmpDir, "periodic.json"),
      JSON.stringify({
        type: "periodic",
        text: "periodic check",
        schedule: "0 20 * * *",
        timezone: "UTC",
      }),
    );

    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: ({ event }) => fired.push(event),
    });

    watcher.start();
    await watcher.reconcileNow();
    await watcher.stop();

    expect(fired).toHaveLength(0);
    expect(await pathExists(path.join(tmpDir, "periodic.json"))).toBe(true);
  });

  it("deletes invalid event files", async () => {
    const filePath = path.join(tmpDir, "bad.json");
    await fs.writeFile(filePath, "not json at all");

    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: () => {},
    });

    watcher.start();
    await watcher.reconcileNow();
    await watcher.stop();

    expect(await pathExists(filePath)).toBe(false);
  });

  it("accepts legacy sender fields but ignores them", async () => {
    const fired: ScheduledEvent[] = [];
    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: ({ event }) => fired.push(event),
    });

    watcher.start();
    await fs.writeFile(
      path.join(tmpDir, "legacy.json"),
      JSON.stringify({ type: "immediate", sender: "PHONE", text: "legacy sender payload" }),
    );
    await watcher.reconcileNow();
    await watcher.stop();

    expect(fired).toEqual([{ type: "immediate", text: "legacy sender payload" }]);
  });

  it("stop() waits for in-flight file handling", async () => {
    const fired: ScheduledEvent[] = [];
    const readStarted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const delayedReadFile = (async (filePath, encoding) => {
      readStarted.resolve();
      await releaseRead.promise;
      return fs.readFile(filePath, encoding as BufferEncoding);
    }) as EventsWatcherDeps["readFile"];
    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: ({ event }) => fired.push(event),
    }, {
      readFile: delayedReadFile,
    });

    watcher.start();
    await fs.writeFile(
      path.join(tmpDir, "slow.json"),
      JSON.stringify({ type: "immediate", text: "slow" }),
    );

    const reconcilePromise = watcher.reconcileNow();
    await readStarted.promise;

    let stopped = false;
    const stopPromise = watcher.stop().then(() => {
      stopped = true;
    });

    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseRead.resolve();
    await reconcilePromise;
    await stopPromise;

    expect(fired).toEqual([{ type: "immediate", text: "slow" }]);
  });

  it("stop() is safe to call multiple times", async () => {
    const watcher = new EventsWatcher({
      eventsDir: tmpDir,
      onFire: () => {},
    });

    watcher.start();
    await watcher.stop();
    await watcher.stop();
  });
});
