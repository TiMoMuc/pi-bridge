import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runAdminWorkspace } from "../src/admin-workspace.js";
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prints a dry-run summary for --check", async () => {
    const provisioner = new UserProvisioner(workspaceDir, workspaceDir, blueprintDir, {
      codeServer: config.codeServer,
      calendar: config.calendar,
      workspaceDefaults: config.workspaceDefaults,
      modelDefaults: {
        provider: config.piProvider,
        model: config.piModel,
        thinkingLevel: config.piThinkingLevel,
      },
    });
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
});
