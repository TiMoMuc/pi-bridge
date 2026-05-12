import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UserEventsManager } from "../src/events-manager.js";
import type { Config } from "../src/config.js";
import type { FiredScheduledEvent } from "../src/events.js";
import { workspacePaths } from "../src/workspace-paths.js";

function makeConfig(workspaceDir: string): Config {
  return {
    signalCliUrl: "http://localhost:8080",
    signalPhoneNumber: "+10000000000",
    anthropicApiKey: "",
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-5",
    piThinkingLevel: "off",
    bridgeAccessMode: "open",
    bridgeDataDir: workspaceDir,
    projectsDir: workspaceDir,
    blueprintDir: "/app/__blueprint__",
    systemDir: "/app/system",
    adminPhone: undefined,
    sandboxImage: "pi-bridge-sandbox:latest",
    sandboxMemory: 536870912,
    sandboxCpus: 1000000000,
    sandboxNetwork: "none",
    sandboxCwd: ".",
    projectsHostDir: "",
    codeServer: {
      image: "pi-bridge-code-server:latest",
      bindHost: "127.0.0.1",
      portStart: 18440,
      extensionsMode: "append",
      extensions: ["ms-vscode.live-server"],
    },
    calendar: {
      enabled: false,
      bindHost: "0.0.0.0",
      port: 8789,
      publicBaseUrl: undefined,
      refreshInterval: "PT15M",
    },
    workspaceDefaults: {
      codeServerEnabled: false,
      calendarEnabled: false,
      bootEnabled: true,
    },
    nextcloud: {
      baseUrl: "",
      botSecret: "",
      webhookHost: "0.0.0.0",
      webhookPort: 8788,
      webhookPath: "/nextcloud-talk-webhook",
      apiUser: "",
      apiPassword: "",
    },
  };
}

describe("UserEventsManager", () => {
  let tmpDir: string;
  let config: Config;
  let dispatched: Array<{ sender: string }>;
  let handled: Array<{ sender: string; fired: FiredScheduledEvent }>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "events-mgr-test-"));
    config = makeConfig(tmpDir);
    dispatched = [];
    handled = [];
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createManager(): UserEventsManager {
    return new UserEventsManager(
      (sender, fn) => {
        dispatched.push({ sender });
        void fn();
      },
      async (sender, fired) => {
        handled.push({ sender, fired });
      },
      (workspaceKey) => workspacePaths(config.projectsDir, `users/${workspaceKey}`),
    );
  }

  it("injects sender from startForUser context when an event fires", async () => {
    const mgr = createManager();
    const workspaceRoot = path.join(tmpDir, "users", "ws_a7b3c9");
    const eventsDir = path.join(workspaceRoot, ".events");
    const sessionsDir = path.join(workspaceRoot, ".bridge", "sessions");
    await fs.mkdir(eventsDir, { recursive: true });
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "existing.jsonl"), "{}\n");

    mgr.startForUser("ws_a7b3c9");

    await fs.writeFile(
      path.join(eventsDir, "now.json"),
      JSON.stringify({ type: "immediate", text: "hello from event" }),
    );

    await mgr.reconcileForUser("ws_a7b3c9");

    expect(dispatched).toEqual([{ sender: "ws_a7b3c9" }]);
    expect(handled).toHaveLength(1);
    expect(handled[0]?.sender).toBe("ws_a7b3c9");
    expect(handled[0]?.fired.filename).toBe("now.json");
    expect(handled[0]?.fired.filePath).toBe(path.join(eventsDir, "now.json"));
    expect(handled[0]?.fired.rawContent).toContain("hello from event");
    expect(handled[0]?.fired.event).toEqual({ type: "immediate", text: "hello from event" });

    await mgr.stopAll();
  });

  it("skips events when no existing session file is present", async () => {
    const mgr = createManager();
    const eventsDir = path.join(tmpDir, "users", "ws_cold", ".events");
    await fs.mkdir(eventsDir, { recursive: true });

    mgr.startForUser("ws_cold");
    await fs.writeFile(
      path.join(eventsDir, "now.json"),
      JSON.stringify({ type: "immediate", text: "should be skipped" }),
    );

    await mgr.reconcileForUser("ws_cold");
    expect(dispatched).toEqual([]);
    expect(handled).toEqual([]);

    await mgr.stopAll();
  });

  it("knownSenders returns users who have been started", async () => {
    const mgr = createManager();
    const eventsDir1 = path.join(tmpDir, "users", "ws_a1", ".events");
    const eventsDir2 = path.join(tmpDir, "users", "ws_b2", ".events");
    await fs.mkdir(eventsDir1, { recursive: true });
    await fs.mkdir(eventsDir2, { recursive: true });

    mgr.startForUser("ws_a1");
    mgr.startForUser("ws_b2");

    const senders = mgr.knownSenders();
    expect(senders).toContain("ws_a1");
    expect(senders).toContain("ws_b2");
    expect(senders).toHaveLength(2);

    await mgr.stopAll();
  });

  it("startForUser is idempotent", async () => {
    const mgr = createManager();
    const eventsDir = path.join(tmpDir, "users", "ws_a7b3c9", ".events");
    await fs.mkdir(eventsDir, { recursive: true });

    mgr.startForUser("ws_a7b3c9");
    mgr.startForUser("ws_a7b3c9");

    expect(mgr.knownSenders()).toHaveLength(1);
    await mgr.stopAll();
  });

  it("stopAll stops per-user watchers and is safe to call multiple times", async () => {
    const mgr = createManager();
    const eventsDir = path.join(tmpDir, "users", "ws_a7b3c9", ".events");
    await fs.mkdir(eventsDir, { recursive: true });
    mgr.startForUser("ws_a7b3c9");

    await mgr.stopAll();
    await mgr.stopAll();
  });
});
