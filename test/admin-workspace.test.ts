import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAdminWorkspace } from "../src/admin-workspace.js";
import { DurableIngressQueue } from "../src/inbox-queue.js";
import { initializeLogger, resetLoggerForTests } from "../src/logger.js";
import { DurableOutboundQueue } from "../src/outbox-queue.js";
import { UserProvisioner } from "../src/provisioner.js";
import type { Config } from "../src/config.js";

function makeConfig(workspaceDir: string, blueprintDir: string): Config {
  return {
    signalCliUrl: "http://localhost:8080",
    signalPhoneNumber: "+15551234567",
    anthropicApiKey: "",
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-5",
    piThinkingLevel: "off",
    bridgeAccessMode: "open",
    bridgeDataDir: workspaceDir,
    projectsDir: workspaceDir,
    blueprintDir,
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
      enabled: true,
      bindHost: "0.0.0.0",
      port: 18439,
      publicBaseUrl: "https://cal.mitra-labs.ai",
      refreshInterval: "PT15M",
    },
    sessionWatch: {
      enabled: false,
      bindHost: "127.0.0.1",
      port: 8791,
      publicBaseUrl: undefined,
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

describe("admin-workspace", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let blueprintDir: string;
  let config: Config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "admin-workspace-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    blueprintDir = path.join(tmpDir, "blueprint");
    await fs.mkdir(blueprintDir, { recursive: true });
    await fs.writeFile(path.join(blueprintDir, "AGENTS.md"), "# Agent\n");
    await fs.writeFile(path.join(blueprintDir, "orient.py"), "print('boot')\n");
    await fs.writeFile(path.join(blueprintDir, ".gitignore"), "sessions/\n");
    config = makeConfig(workspaceDir, blueprintDir);
    initializeLogger(workspaceDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetLoggerForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createProvisioner(): UserProvisioner {
    return new UserProvisioner(workspaceDir, workspaceDir, blueprintDir, {
      codeServer: config.codeServer,
      calendar: config.calendar,
      workspaceDefaults: config.workspaceDefaults,
      modelDefaults: {
        provider: config.piProvider,
        model: config.piModel,
        thinkingLevel: config.piThinkingLevel,
      },
    });
  }

  it("prints a dry-run summary for --check", async () => {
    const provisioner = createProvisioner();
    await provisioner.initialize();
    await provisioner.ensureProvisioned("signal", "+15551234567");

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runAdminWorkspace(["reconcile", "--check"], { config, provisioner });

    expect(log).toHaveBeenCalledWith(expect.stringContaining("ws_"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("code-server: disabled"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("model: anthropic/claude-sonnet-4-5 @ off"));
  });

  it("signals the bridge with SIGHUP by default and SIGUSR1 for --reset-runners", async () => {
    const signalProcess = vi.fn();
    await runAdminWorkspace(["reconcile"], { config, signalProcess });
    await runAdminWorkspace(["reconcile", "--reset-runners"], { config, signalProcess });

    expect(signalProcess).toHaveBeenNthCalledWith(1, 1, "SIGHUP");
    expect(signalProcess).toHaveBeenNthCalledWith(2, 1, "SIGUSR1");
  });

  it("refuses destructive delete unless --confirm exactly matches the workspace key", async () => {
    await expect(
      runAdminWorkspace(["delete", "ws_a7b3c9"], { config }),
    ).rejects.toThrow("--confirm must exactly match ws_a7b3c9");

    await expect(
      runAdminWorkspace(["delete", "ws_a7b3c9", "--confirm", "ws_other"], { config }),
    ).rejects.toThrow("--confirm must exactly match ws_a7b3c9");
  });

  it("fails clearly for unknown workspaces", async () => {
    const signalProcess = vi.fn();

    await expect(
      runAdminWorkspace(["delete", "ws_missing", "--confirm", "ws_missing"], { config, signalProcess }),
    ).rejects.toThrow("Unknown workspace: ws_missing");

    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("deletes a workspace destructively through the registry owner, queue cleanup, runtime teardown calls, and bridge reload", async () => {
    const provisioner = createProvisioner();
    await provisioner.initialize();

    const deleted = await provisioner.ensureProvisioned("signal", "+15551234567");
    const retained = await provisioner.ensureProvisioned("signal", "+15550000000");
    const deletedRoot = provisioner.getWorkspaceRoot(deleted.workspaceKey)!;
    const retainedRoot = provisioner.getWorkspaceRoot(retained.workspaceKey)!;
    await fs.writeFile(path.join(deletedRoot, "delete-me.txt"), "goodbye\n");
    await fs.writeFile(path.join(retainedRoot, "keep-me.txt"), "hello\n");

    const inbox = new DurableIngressQueue(workspaceDir);
    await inbox.enqueue({
      correlationId: "in_deleted",
      workspaceKey: deleted.workspaceKey,
      message: {
        sender: "+15551234567",
        text: "delete me",
        attachments: [],
        meta: {
          transport: "signal",
          senderId: "+15551234567",
        },
      },
    });
    await inbox.enqueue({
      correlationId: "in_retained",
      workspaceKey: retained.workspaceKey,
      message: {
        sender: "+15550000000",
        text: "keep me",
        attachments: [],
        meta: {
          transport: "signal",
          senderId: "+15550000000",
        },
      },
    });

    const outbox = new DurableOutboundQueue(workspaceDir, {
      resolveTransport: () => undefined,
    });
    await outbox.enqueue({
      correlationId: "out_deleted",
      workspaceKey: deleted.workspaceKey,
      transportName: "signal",
      recipient: "+15551234567",
      chunks: [{ text: "delete me", options: { target: "+15551234567" } }],
    });
    await outbox.enqueue({
      correlationId: "out_retained",
      workspaceKey: retained.workspaceKey,
      transportName: "signal",
      recipient: "+15550000000",
      chunks: [{ text: "keep me", options: { target: "+15550000000" } }],
    });

    const sandboxManager = {
      remove: vi.fn(async () => {}),
    };
    const codeServerManager = {
      destroy: vi.fn(async () => {}),
    };
    const capabilityManager = {
      applyWorkspaceCapabilities: vi.fn(async () => ({
        attached: [],
        detached: ["pdfApi"],
        missing: [],
        networkCreated: false,
        networkRemoved: true,
      })),
    };
    const signalProcess = vi.fn();

    await runAdminWorkspace([
      "delete",
      deleted.workspaceKey,
      "--confirm",
      deleted.workspaceKey,
    ], {
      config,
      provisioner,
      sandboxManager: sandboxManager as never,
      codeServerManager: codeServerManager as never,
      capabilityManager: capabilityManager as never,
      inbox,
      outbox,
      signalProcess,
    });

    expect(sandboxManager.remove).toHaveBeenCalledWith(deleted.workspaceKey);
    expect(codeServerManager.destroy).toHaveBeenCalledWith(deleted.workspaceKey);
    expect(capabilityManager.applyWorkspaceCapabilities).toHaveBeenCalledWith(deleted.workspaceKey);
    expect(signalProcess).toHaveBeenCalledWith(1, "SIGHUP");

    expect(provisioner.getWorkspace(deleted.workspaceKey)).toBeUndefined();
    expect(provisioner.lookup("signal", "+15551234567")).toBeUndefined();
    expect(provisioner.getWorkspace(retained.workspaceKey)?.workspacePath).toBe(retained.record.workspacePath);
    expect(provisioner.lookup("signal", "+15550000000")).toBe(retained.workspaceKey);

    await expect(fs.access(deletedRoot)).rejects.toThrow();
    await expect(fs.access(path.join(retainedRoot, "keep-me.txt"))).resolves.toBeUndefined();

    const inboxEntries = await inbox.list();
    expect(inboxEntries.map((entry) => entry.workspaceKey)).toEqual([retained.workspaceKey]);

    const outboxEntries = await outbox.list();
    expect(outboxEntries.map((entry) => entry.workspaceKey)).toEqual([retained.workspaceKey]);

    const registry = JSON.parse(
      await fs.readFile(path.join(workspaceDir, "admin", "workspace.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(registry)).toEqual([retained.workspaceKey]);
  });
});
