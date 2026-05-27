import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { AgentRunner } from "../src/runner.js";
import { resolveWorkspacePiSelection, SessionRouter } from "../src/session-router.js";

function makeCreateSessionStub() {
  return vi.fn(async (
    workspaceKey: string,
    config: Config,
    options: {
      executor: unknown;
      piSelection?: { provider: string; model: string; thinkingLevel: Config["piThinkingLevel"] };
    },
  ) => ({
    sender: workspaceKey,
    modelProvider: options.piSelection?.provider ?? config.piProvider,
    modelName: options.piSelection?.model ?? config.piModel,
    thinkingLevel: options.piSelection?.thinkingLevel ?? config.piThinkingLevel,
    userDir: "/tmp/user",
    agentWorkspaceRoot: "/workspace",
  } as unknown as AgentRunner));
}

describe("resolveWorkspacePiSelection", () => {
  it("uses the workspace override when provider and model are both valid", () => {
    expect(resolveWorkspacePiSelection({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
    }, {
      piProvider: "openai",
      piModel: "gpt-4o",
    })).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      thinkingLevel: "off",
      modelSource: "workspace",
      thinkingSource: "default",
    });
  });

  it("allows a workspace thinking override without provider or model overrides", () => {
    expect(resolveWorkspacePiSelection({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
    }, {
      piThinkingLevel: "medium",
    })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "medium",
      modelSource: "default",
      thinkingSource: "workspace",
    });
  });

  it("falls back to the default when the workspace model override is incomplete", () => {
    expect(resolveWorkspacePiSelection({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
    }, {
      piProvider: "openai",
    })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
      modelSource: "default",
      modelFallbackReason: "incomplete",
    });
  });

  it("falls back to the default when the workspace model override is invalid", () => {
    expect(resolveWorkspacePiSelection({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
    }, {
      piProvider: "invalid-provider",
      piModel: "invalid-model",
    })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
      modelSource: "default",
      modelFallbackReason: "invalid",
    });
  });

  it("falls back to the default when the workspace thinking override is invalid", () => {
    expect(resolveWorkspacePiSelection({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
    }, {
      piThinkingLevel: "turbo",
    })).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
      thinkingSource: "default",
      thinkingFallbackReason: "invalid",
      requestedThinkingLevel: "turbo",
    });
  });
});

describe("SessionRouter PI selection", () => {
  let tmpDir: string;
  let config: Config;
  let sandboxManager: {
    resolveSandboxId: ReturnType<typeof vi.fn>;
    getOrCreateExecutor: ReturnType<typeof vi.fn>;
  };
  let createSession: ReturnType<typeof makeCreateSessionStub>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-router-test-"));
    config = {
      signalPhoneNumber: "+10000000000",
      signalCliUrl: "http://localhost:8080",
      bridgeDataDir: tmpDir,
      projectsDir: path.join(tmpDir, "projects"),
      blueprintDir: "/tmp/blueprint",
      systemDir: "/tmp/system",
      bridgeAccessMode: "open",
      piProvider: "anthropic",
      piModel: "claude-sonnet-4-5",
      piThinkingLevel: "off",
      anthropicApiKey: "test-key",
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

    sandboxManager = {
      resolveSandboxId: vi.fn((workspaceKey: string) => workspaceKey),
      getOrCreateExecutor: vi.fn(async () => ({
        exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
      })),
    };
    createSession = makeCreateSessionStub();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("applies an independent workspace thinking override to the created runner", async () => {
    const provisioner = {
      getWorkspace: vi.fn(() => ({
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
        piThinkingLevel: "minimal",
      })),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });

    const runner = await router.getOrCreate("ws_a7b3c9");

    expect(eventsManager.startForUser).toHaveBeenCalledWith("ws_a7b3c9");
    expect(runner.modelProvider).toBe("anthropic");
    expect(runner.modelName).toBe("claude-sonnet-4-5");
    expect(runner.thinkingLevel).toBe("minimal");
  });

  it("falls back to the default thinking level when the workspace override is invalid", async () => {
    const provisioner = {
      getWorkspace: vi.fn(() => ({
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
        piThinkingLevel: "turbo",
      })),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runner = await router.getOrCreate("ws_a7b3c9");

    expect(runner.modelProvider).toBe("anthropic");
    expect(runner.modelName).toBe("claude-sonnet-4-5");
    expect(runner.thinkingLevel).toBe("off");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Invalid workspace thinking override for ws_a7b3c9"),
    );
  });

  it("resets only runners whose workspace PI selection changed when requested", async () => {
    const state = {
      record: {
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
        piThinkingLevel: "off",
      },
    };
    const provisioner = {
      getWorkspace: vi.fn(() => state.record),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });

    const first = await router.getOrCreate("ws_a7b3c9");
    state.record = {
      ...state.record,
      piThinkingLevel: "minimal",
    };

    const result = await router.reconcileWorkspacePiSelections(true);
    const second = await router.getOrCreate("ws_a7b3c9");

    expect(first.thinkingLevel).toBe("off");
    expect(result.changed).toEqual(["ws_a7b3c9"]);
    expect(result.reset).toEqual(["ws_a7b3c9"]);
    expect(result.skippedActive).toEqual([]);
    expect(second.thinkingLevel).toBe("minimal");
  });

  it("skips active runners during reset-runners reconciliation when only thinking changed", async () => {
    const state = {
      record: {
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
        piThinkingLevel: "off",
      },
    };
    const provisioner = {
      getWorkspace: vi.fn(() => state.record),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });

    const first = await router.getOrCreate("ws_a7b3c9");

    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    router.dispatch("ws_a7b3c9", async () => {
      enteredResolve();
      await release;
    });
    await entered;

    state.record = {
      ...state.record,
      piThinkingLevel: "minimal",
    };

    const result = await router.reconcileWorkspacePiSelections(true);
    const stillCached = await router.getOrCreate("ws_a7b3c9");

    expect(result.changed).toEqual(["ws_a7b3c9"]);
    expect(result.reset).toEqual([]);
    expect(result.skippedActive).toEqual(["ws_a7b3c9"]);
    expect(stillCached).toBe(first);
    expect(stillCached.thinkingLevel).toBe("off");

    releaseResolve();
  });

  it("retires deleted workspaces and skips any queued follow-up dispatches", async () => {
    const provisioner = {
      getWorkspace: vi.fn(() => ({
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
      })),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });

    await router.getOrCreate("ws_a7b3c9");

    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const queued = vi.fn(async () => {});

    router.dispatch("ws_a7b3c9", async () => {
      enteredResolve();
      await release;
    });
    await entered;

    router.dispatch("ws_a7b3c9", queued);
    expect(router.retireDeletedWorkspaces([])).toEqual(["ws_a7b3c9"]);
    expect(router.getCachedRunner("ws_a7b3c9")).toBeUndefined();

    releaseResolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(queued).not.toHaveBeenCalled();
  });

  it("creates workspace mount source directories on the bridge path but mounts the host path into Docker", async () => {
    const bridgeProjectsDir = path.join(tmpDir, "bridge-projects");
    const hostProjectsDir = path.join(tmpDir, "host-projects");
    config.projectsDir = bridgeProjectsDir;
    config.projectsHostDir = hostProjectsDir;

    const workspacePath = "teams/acme";
    await fs.mkdir(path.join(bridgeProjectsDir, workspacePath), { recursive: true });

    const provisioner = {
      getWorkspace: vi.fn(() => ({
        provisionedAt: "2026-05-07T00:00:00.000Z",
        workspacePath,
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
      })),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });

    await router.getOrCreate("ws_a7b3c9");

    expect(sandboxManager.getOrCreateExecutor).toHaveBeenCalledWith(
      "ws_a7b3c9",
      path.join(hostProjectsDir, workspacePath),
      "signal",
      "none",
    );
    await expect(fs.stat(path.join(bridgeProjectsDir, workspacePath, "cowork"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(bridgeProjectsDir, workspacePath, ".bridge"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(bridgeProjectsDir, workspacePath, "upload"))).resolves.toBeTruthy();
    expect(eventsManager.startForUser).toHaveBeenCalledWith("ws_a7b3c9");
  });

  it("fails loudly when a provisioned workspace root is missing", async () => {
    const bridgeProjectsDir = path.join(tmpDir, "bridge-projects");
    const hostProjectsDir = path.join(tmpDir, "host-projects");
    config.projectsDir = bridgeProjectsDir;
    config.projectsHostDir = hostProjectsDir;

    const provisioner = {
      getWorkspace: vi.fn(() => ({
        provisionedAt: "2026-05-07T00:00:00.000Z",
        workspacePath: "teams/missing",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
      })),
    };
    const eventsManager = { startForUser: vi.fn() };
    const router = new SessionRouter(config, provisioner as never, eventsManager as never, sandboxManager as never, undefined, { createSession });

    await expect(router.getOrCreate("ws_a7b3c9")).rejects.toThrow(
      "refusing to recreate it automatically",
    );
    expect(sandboxManager.getOrCreateExecutor).not.toHaveBeenCalled();
    expect(eventsManager.startForUser).not.toHaveBeenCalled();
  });
});
