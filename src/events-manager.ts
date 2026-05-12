/**
 * Manages one EventsWatcher per user.
 *
 * Per-user: watches the user's events/ directory for agent-created cron files.
 * Sender/workspace identity is injected from the manager's owning context, not
 * stored in the event JSON itself.
 *
 * See README.md + AGENTS.md for the current blueprint/runtime shape.
 */

import { existsSync, readdirSync } from "node:fs";
import { EventsWatcher, type FiredScheduledEvent } from "./events.js";
import type { WorkspacePaths } from "./workspace-paths.js";

// Avoid circular import: accept a callback instead of importing SessionRouter
type DispatchFn = (sender: string, fn: () => Promise<void>) => void;

export class UserEventsManager {
  private readonly watchers = new Map<string, EventsWatcher>();

  constructor(
    private readonly dispatch: DispatchFn,
    private readonly handleEvent: (sender: string, fired: FiredScheduledEvent) => Promise<void>,
    private readonly resolveWorkspacePaths: (workspaceKey: string) => WorkspacePaths | undefined,
  ) {}

  /** Start watching a user's events/ directory. Idempotent. */
  startForUser(sender: string): void {
    if (this.watchers.has(sender)) return;

    const paths = this.resolveWorkspacePaths(sender);
    if (!paths) return;
    const eventsDir = paths.eventsDir;

    const watcher = new EventsWatcher({
      eventsDir,
      onFire: (fired) => {
        if (!this.hasExistingSessionFile(sender)) {
          console.log(`[events] Skipping ${fired.filename} for ${sender} (no existing session file)`);
          return;
        }
        this.dispatch(sender, () => this.handleEvent(sender, fired));
      },
    });

    watcher.start();
    this.watchers.set(sender, watcher);
  }

  async stopForUser(sender: string): Promise<void> {
    const w = this.watchers.get(sender);
    if (w) {
      await w.stop();
      this.watchers.delete(sender);
    }
  }

  async stopAll(): Promise<void> {
    for (const sender of [...this.watchers.keys()]) {
      await this.stopForUser(sender);
    }
  }

  /** Get all known senders (for testing/introspection). */
  knownSenders(): string[] {
    return [...this.watchers.keys()];
  }

  async reconcileForUser(sender: string): Promise<void> {
    const watcher = this.watchers.get(sender);
    if (!watcher) return;
    await watcher.reconcileNow();
  }

  private hasExistingSessionFile(sender: string): boolean {
    const paths = this.resolveWorkspacePaths(sender);
    const sessionsDir = paths?.sessionsDir;
    if (!sessionsDir || !existsSync(sessionsDir)) return false;
    try {
      return readdirSync(sessionsDir).some((name) => name.endsWith(".jsonl"));
    } catch {
      return false;
    }
  }
}
