import { spawn } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Executor } from "../src/sandbox.js";
import {
  loadConstitution,
  resetConstitutionCache,
  loadInterfaceProtocol,
  loadInterfaceProtocols,
  loadTransportInterfaceProtocol,
  resetInterfaceProtocolCache,
} from "../src/runner.js";

describe("loadConstitution", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    resetConstitutionCache();
  });

  afterEach(async () => {
    resetConstitutionCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads CONSTITUTION.md from system dir", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, "CONSTITUTION.md"), "# Test Constitution\nBe helpful.");

    const result = await loadConstitution(systemDir);
    expect(result).toBe("# Test Constitution\nBe helpful.");
  });

  it("returns empty string when CONSTITUTION.md is missing", async () => {
    const systemDir = path.join(tmpDir, "nonexistent");
    const result = await loadConstitution(systemDir);
    expect(result).toBe("");
  });

  it("caches the result after first load", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, "CONSTITUTION.md"), "original");

    const first = await loadConstitution(systemDir);
    expect(first).toBe("original");

    // Modify file — should still return cached value
    await fs.writeFile(path.join(systemDir, "CONSTITUTION.md"), "modified");
    const second = await loadConstitution(systemDir);
    expect(second).toBe("original");
  });

  it("resetConstitutionCache allows re-reading", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, "CONSTITUTION.md"), "original");

    await loadConstitution(systemDir);
    resetConstitutionCache();

    await fs.writeFile(path.join(systemDir, "CONSTITUTION.md"), "modified");
    const result = await loadConstitution(systemDir);
    expect(result).toBe("modified");
  });
});

describe("loadInterfaceProtocol", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    resetInterfaceProtocolCache();
  });

  afterEach(async () => {
    resetInterfaceProtocolCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads the bridge-global interface protocol from system dir", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(
      path.join(systemDir, "interface-protocol.md"),
      "# Interface Protocol\nBridge-global mechanics.",
    );

    const result = await loadInterfaceProtocol(systemDir);
    expect(result).toBe("# Interface Protocol\nBridge-global mechanics.");
  });

  it("loads only the requested transport addendum", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(
      path.join(systemDir, "interface-protocol-signal.md"),
      "# Signal Addendum\nSignal-only rules.",
    );
    await fs.writeFile(
      path.join(systemDir, "interface-protocol-nextcloud.md"),
      "# Nextcloud Addendum\nNextcloud-only rules.",
    );

    const result = await loadTransportInterfaceProtocol(systemDir, "signal");
    expect(result).toBe("# Signal Addendum\nSignal-only rules.");
  });

  it("returns bridge-global plus active transport protocol layers in order", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, "interface-protocol.md"), "global");
    await fs.writeFile(path.join(systemDir, "interface-protocol-signal.md"), "signal");
    await fs.writeFile(path.join(systemDir, "interface-protocol-nextcloud.md"), "nextcloud");

    const result = await loadInterfaceProtocols(systemDir, "nextcloud");
    expect(result).toEqual(["global", "nextcloud"]);
  });

  it("returns empty string when interface-protocol.md is missing", async () => {
    const systemDir = path.join(tmpDir, "nonexistent");
    const result = await loadInterfaceProtocol(systemDir);
    expect(result).toBe("");
  });

  it("returns empty string when the active transport addendum is missing", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });

    const result = await loadTransportInterfaceProtocol(systemDir, "signal");
    expect(result).toBe("");
  });

  it("caches the result after first load", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, "interface-protocol.md"), "original");

    const first = await loadInterfaceProtocol(systemDir);
    expect(first).toBe("original");

    await fs.writeFile(path.join(systemDir, "interface-protocol.md"), "modified");
    const second = await loadInterfaceProtocol(systemDir);
    expect(second).toBe("original");
  });

  it("resetInterfaceProtocolCache allows re-reading", async () => {
    const systemDir = path.join(tmpDir, "system");
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(path.join(systemDir, "interface-protocol.md"), "original");

    await loadInterfaceProtocol(systemDir);
    resetInterfaceProtocolCache();

    await fs.writeFile(path.join(systemDir, "interface-protocol.md"), "modified");
    const result = await loadInterfaceProtocol(systemDir);
    expect(result).toBe("modified");
  });
});

// ---------------------------------------------------------------------------
// createSenderSession — forceNew flag
//
// We spy on SessionManager.open and SessionManager.create (static methods) to
// confirm which code path is taken, without needing real Anthropic API calls.
// createAgentSession is stubbed out so the session never actually runs.
// ---------------------------------------------------------------------------

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const createAgentSession = vi.fn(async () => ({
    session: {
      subscribe: vi.fn(),
      agent: { setSystemPrompt: vi.fn() },
      prompt: vi.fn(async () => {}),
    },
  }));
  return { ...actual, createAgentSession };
});

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return {
    ...actual,
    getModel: vi.fn((provider: string, model: string) => (
      provider.includes("invalid") || model.includes("invalid")
        ? undefined
        : { id: `${provider}/${model}` }
    )),
  };
});

function makeNoopExecutor(): Executor {
  return {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
  };
}

function makeWorkspaceMappedLocalExecutor(workspaceRoot: string): Executor {
  const mapWorkspace = (value: string | undefined): string | undefined =>
    value?.replaceAll("/workspace", workspaceRoot);

  return {
    exec: async (command, options) => runLocalShell(
      mapWorkspace(command) ?? command,
      { ...options, cwd: mapWorkspace(options?.cwd) },
      "text",
    ) as Promise<{ stdout: string; stderr: string; code: number }>,
    execBinary: async (command, options) => runLocalShell(
      mapWorkspace(command) ?? command,
      { ...options, cwd: mapWorkspace(options?.cwd) },
      "binary",
    ) as Promise<{ stdout: Buffer; stderr: string; code: number }>,
  };
}

function runLocalShell(
  command: string,
  options: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
  },
  mode: "text" | "binary",
): Promise<{ stdout: string; stderr: string; code: number } | { stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.on("error", reject);
    child.stdout?.on("data", (data: Buffer) => stdoutChunks.push(Buffer.from(data)));
    child.stderr?.on("data", (data: Buffer) => stderrChunks.push(Buffer.from(data)));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (mode === "binary") {
        resolve({ stdout, stderr, code: code ?? 0 });
        return;
      }
      resolve({ stdout: stdout.toString("utf8"), stderr, code: code ?? 0 });
    });
  });
}

describe("createSenderSession — forceNew flag", () => {
  let tmpDir: string;
  let config: import("../src/config.js").Config;
  // Spy handles stored here so assertions never touch the unbound method directly
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let openSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let createSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listSpy: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-reset-test-"));
    resetConstitutionCache();
    resetInterfaceProtocolCache();

    config = {
      signalPhoneNumber: "+10000000000",
      signalCliUrl: "http://localhost:8080",
      bridgeDataDir: tmpDir,
      projectsDir: tmpDir,
      blueprintDir: path.join(tmpDir, "blueprint"),
      systemDir: path.join(tmpDir, "system"),
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

    await fs.mkdir(path.join(tmpDir, "system"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "+10000000000", "work"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "+10000000000", "sessions"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "+10000000000", "skills"), { recursive: true });

    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    // Mock return values so the real file I/O doesn't throw on our placeholder files.
    // We only care which path was taken (open vs. create), not what they return —
    // createAgentSession is already stubbed out above.
    //
    // list is also mocked: we control whether sessions "exist" per test, because
    // SessionManager.list applies its own filename format checks that would filter
    // out our test placeholder files.
    listSpy = vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    openSpy = vi.spyOn(SessionManager, "open").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-argument
    );
    createSpy = vi.spyOn(SessionManager, "create").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any, // eslint-disable-line @typescript-eslint/no-unsafe-argument
    );
  });

  afterEach(async () => {
    resetConstitutionCache();
    resetInterfaceProtocolCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("default (no forceNew) restores existing session if one exists", async () => {
    const { createSenderSession } = await import("../src/runner.js");

    const fakePath = "/fake/sessions/2026-01-01T00-00-00-000Z_aabbccdd.jsonl";
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    listSpy.mockResolvedValue([{ path: fakePath }]);

    await createSenderSession("+10000000000", config, { executor: makeNoopExecutor() });

    expect(openSpy).toHaveBeenCalledWith(fakePath);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("forceNew:true skips restore and calls SessionManager.create", async () => {
    const { createSenderSession } = await import("../src/runner.js");

    // Even with a session available, forceNew must bypass it
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    listSpy.mockResolvedValue([{ path: "/fake/sessions/old.jsonl" }]);

    await createSenderSession("+10000000000", config, { forceNew: true, executor: makeNoopExecutor() });

    expect(openSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalled();
  });

  it("sequential forceNew calls each invoke SessionManager.create, never open", async () => {
    const { createSenderSession } = await import("../src/runner.js");

    await createSenderSession("+10000000000", config, { forceNew: true, executor: makeNoopExecutor() });
    await createSenderSession("+10000000000", config, { forceNew: true, executor: makeNoopExecutor() });

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("createSenderSession — ResourceLoader shape", () => {
  let tmpDir: string;
  let config: import("../src/config.js").Config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "resourceloader-test-"));
    resetConstitutionCache();
    resetInterfaceProtocolCache();

    config = {
      signalPhoneNumber: "+10000000000",
      signalCliUrl: "http://localhost:8080",
      bridgeDataDir: tmpDir,
      projectsDir: tmpDir,
      blueprintDir: path.join(tmpDir, "blueprint"),
      systemDir: path.join(tmpDir, "system"),
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

    await fs.mkdir(path.join(tmpDir, "system"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "system", "CONSTITUTION.md"),
      "# Constitution\nTest values.",
    );
    await fs.writeFile(
      path.join(tmpDir, "system", "interface-protocol.md"),
      "# Interface Protocol\nBridge-global mechanics.",
    );
    await fs.writeFile(
      path.join(tmpDir, "system", "interface-protocol-signal.md"),
      "# Signal Protocol\nSignal-only mechanics.",
    );
    await fs.writeFile(
      path.join(tmpDir, "system", "interface-protocol-nextcloud.md"),
      "# Nextcloud Protocol\nNextcloud-only mechanics.",
    );

    const userDir = path.join(tmpDir, "users", "+10000000000");
    await fs.mkdir(path.join(userDir, "work"), { recursive: true });
    await fs.mkdir(path.join(userDir, "sessions"), { recursive: true });
    await fs.mkdir(path.join(userDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(userDir, "AGENTS.md"), "# My Notes\nUser likes coffee.");

    const { SessionManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    vi.spyOn(SessionManager, "list").mockResolvedValue([]);
    vi.spyOn(SessionManager, "open").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      {} as any,
    );
    vi.spyOn(SessionManager, "create").mockReturnValue(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      {} as any,
    );
  });

  afterEach(async () => {
    resetConstitutionCache();
    resetInterfaceProtocolCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("passes constitution plus the workspace primary transport protocol layers and AGENTS.md content", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    await createSenderSession("+10000000000", config, { executor: makeNoopExecutor() });

    const call = createAgentSessionMock.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("missing createAgentSession call");

    const rl = call.resourceLoader;
    expect(rl).toBeDefined();
    if (!rl) throw new Error("missing resource loader");

    // Layer 1: Constitution via getSystemPrompt
    expect(rl.getSystemPrompt()).toBe("# Constitution\nTest values.");

    // Layer 2: bridge-global interface protocol + workspace primary transport addendum
    const append = rl.getAppendSystemPrompt();
    expect(append).toEqual([
      "# Interface Protocol\nBridge-global mechanics.",
      "# Signal Protocol\nSignal-only mechanics.",
      "# My Notes\nUser likes coffee.",
    ]);

    // AGENTS.md content is appended without exposing its filesystem path
    const agentsResult = rl.getAgentsFiles();
    expect(agentsResult.agentsFiles).toHaveLength(0);
  });

  it("returns undefined for getSystemPrompt when constitution is empty", async () => {
    resetConstitutionCache();
    // Remove constitution file
    await fs.rm(path.join(tmpDir, "system", "CONSTITUTION.md"));

    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    await createSenderSession("+10000000000", config, { executor: makeNoopExecutor() });

    const call = createAgentSessionMock.mock.calls[
      createAgentSessionMock.mock.calls.length - 1
    ]?.[0];
    expect(call?.resourceLoader).toBeDefined();
    if (!call?.resourceLoader) throw new Error("missing resource loader");

    expect(call.resourceLoader.getSystemPrompt()).toBeUndefined();
  });

  it("returns only the enabled transport addendum when the bridge-global protocol is missing", async () => {
    resetInterfaceProtocolCache();
    await fs.rm(path.join(tmpDir, "system", "interface-protocol.md"));

    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    await createSenderSession("+10000000000", config, { executor: makeNoopExecutor() });

    const call = createAgentSessionMock.mock.calls[
      createAgentSessionMock.mock.calls.length - 1
    ]?.[0];
    expect(call?.resourceLoader).toBeDefined();
    if (!call?.resourceLoader) throw new Error("missing resource loader");

    expect(call.resourceLoader.getAppendSystemPrompt()).toEqual([
      "# Signal Protocol\nSignal-only mechanics.",
      "# My Notes\nUser likes coffee.",
    ]);
  });

  it("loads only the workspace primary transport addendum when multiple transports are globally enabled", async () => {
    resetInterfaceProtocolCache();
    config.nextcloud.baseUrl = "https://cloud.example.com";
    config.nextcloud.botSecret = "super-secret";

    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    await createSenderSession("+10000000000", config, {
      executor: makeNoopExecutor(),
      workspaceRecord: {
        createdAt: "2026-05-04T00:00:00.000Z",
        lastSeen: "2026-05-04T00:00:00.000Z",
        status: "active",
        workspacePath: "users/+10000000000",
        primaryTransport: "nextcloud",
        transports: {
          signal: { sender: "+10000000000" },
          nextcloud: { roomToken: "room-abc" },
        },
      },
    });

    const call = createAgentSessionMock.mock.calls[
      createAgentSessionMock.mock.calls.length - 1
    ]?.[0];
    expect(call?.resourceLoader).toBeDefined();
    if (!call?.resourceLoader) throw new Error("missing resource loader");

    expect(call.resourceLoader.getAppendSystemPrompt()).toEqual([
      "# Interface Protocol\nBridge-global mechanics.",
      "# Nextcloud Protocol\nNextcloud-only mechanics.",
      "# My Notes\nUser likes coffee.",
    ]);
  });

  it("uses an explicit PI selection override instead of the global default", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);

    const runner = await createSenderSession("+10000000000", config, {
      executor: makeNoopExecutor(),
      piSelection: {
        provider: "openai",
        model: "gpt-4o",
        thinkingLevel: "minimal",
      },
    });

    expect(runner.modelProvider).toBe("openai");
    expect(runner.modelName).toBe("gpt-4o");
    expect(runner.thinkingLevel).toBe("minimal");
    expect(createAgentSessionMock.mock.calls.at(-1)?.[0]).toMatchObject({
      thinkingLevel: "minimal",
    });
  });

  it("appends orient preload output to the prompt on new sessions", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    const execMock = vi.fn(async () => ({ stdout: "# Workspace Orientation\n\nOrient output", stderr: "", code: 0 }));
    const executor: Executor = { exec: execMock };

    await createSenderSession("+10000000000", config, {
      executor,
      workspaceRecord: {
        createdAt: "2026-05-04T00:00:00.000Z",
        lastSeen: "2026-05-04T00:00:00.000Z",
        status: "active",
        workspacePath: "users/+10000000000",
        primaryTransport: "signal",
        transports: { signal: { sender: "+10000000000" } },
        boot: { enabled: true },
      },
    });

    expect(execMock).toHaveBeenCalledWith("python /workspace/.agent/orient.py", expect.objectContaining({ cwd: "/workspace" }));

    const call = createAgentSessionMock.mock.calls.at(-1)?.[0];
    expect(call?.resourceLoader).toBeDefined();
    if (!call?.resourceLoader) throw new Error("missing resource loader");
    expect(call.resourceLoader.getAppendSystemPrompt()).toEqual([
      "# Interface Protocol\nBridge-global mechanics.",
      "# Signal Protocol\nSignal-only mechanics.",
      "# My Notes\nUser likes coffee.",
      "# Workspace Orientation\n\nOrient output",
    ]);
  });

  it("falls back to the legacy boot script when orient.py is unavailable", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    const execMock = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "command not found", code: 127 })
      .mockResolvedValueOnce({ stdout: "fallback output", stderr: "", code: 0 });
    const executor: Executor = { exec: execMock };

    await createSenderSession("+10000000000", config, {
      executor,
      workspaceRecord: {
        createdAt: "2026-05-04T00:00:00.000Z",
        lastSeen: "2026-05-04T00:00:00.000Z",
        status: "active",
        workspacePath: "users/+10000000000",
        primaryTransport: "signal",
        transports: { signal: { sender: "+10000000000" } },
        boot: { enabled: true },
      },
    });

    expect(execMock).toHaveBeenNthCalledWith(1, "python /workspace/.agent/orient.py", expect.objectContaining({ cwd: "/workspace" }));
    expect(execMock).toHaveBeenNthCalledWith(2, "python /workspace/.agent/boot.py", expect.objectContaining({ cwd: "/workspace" }));

    const call = createAgentSessionMock.mock.calls.at(-1)?.[0];
    expect(call?.resourceLoader).toBeDefined();
    if (!call?.resourceLoader) throw new Error("missing resource loader");
    expect(call.resourceLoader.getAppendSystemPrompt().at(-1)).toBe("fallback output");
  });

  it("does not run boot preloading when restoring an existing session", async () => {
    const { createSenderSession, } = await import("../src/runner.js");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const execMock = vi.fn(async () => ({ stdout: "boot output", stderr: "", code: 0 }));
    const executor: Executor = { exec: execMock };

    vi.spyOn(SessionManager, "list").mockResolvedValue([
      {
        path: "/fake/sessions/existing.jsonl",
        id: "existing",
        cwd: "/workspace",
        created: new Date("2026-05-04T00:00:00.000Z"),
        modified: new Date("2026-05-04T00:00:00.000Z"),
        messageCount: 1,
        firstMessage: "hello",
        allMessagesText: "hello",
      },
    ]);

    await createSenderSession("+10000000000", config, {
      executor,
      workspaceRecord: {
        createdAt: "2026-05-04T00:00:00.000Z",
        lastSeen: "2026-05-04T00:00:00.000Z",
        status: "active",
        workspacePath: "users/+10000000000",
        primaryTransport: "signal",
        transports: { signal: { sender: "+10000000000" } },
        boot: { enabled: true },
      },
    });

    expect(execMock).not.toHaveBeenCalled();
  });

  it("does not run boot preloading when boot is explicitly disabled", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const execMock = vi.fn(async () => ({ stdout: "boot output", stderr: "", code: 0 }));
    const executor: Executor = { exec: execMock };

    await createSenderSession("+10000000000", config, {
      executor,
      workspaceRecord: {
        createdAt: "2026-05-04T00:00:00.000Z",
        lastSeen: "2026-05-04T00:00:00.000Z",
        status: "active",
        workspacePath: "users/+10000000000",
        primaryTransport: "signal",
        transports: { signal: { sender: "+10000000000" } },
        boot: { enabled: false },
      },
    });

    expect(execMock).not.toHaveBeenCalled();
  });

  it("does not auto-load workspace skills into the prompt context", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);

    const skillDir = path.join(tmpDir, "users", "+10000000000", "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\n---\n\nUse me when needed.\n",
    );

    await createSenderSession("+10000000000", config, {
      executor: makeNoopExecutor(),
      workspaceRecord: {
        createdAt: "2026-05-04T00:00:00.000Z",
        lastSeen: "2026-05-04T00:00:00.000Z",
        status: "active",
        workspacePath: "users/+10000000000",
        primaryTransport: "signal",
        transports: { signal: { sender: "+10000000000" } },
      },
    });

    const call = createAgentSessionMock.mock.calls.at(-1)?.[0];
    expect(call?.resourceLoader).toBeDefined();
    if (!call?.resourceLoader) throw new Error("missing resource loader");
    expect(call.resourceLoader.getSkills()).toEqual({ skills: [], diagnostics: [] });
  });

  it("registers wait() through customTools alongside sandbox-backed overrides", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    type WaitTool = {
      name: string;
      execute: (
        toolCallId: string,
        params: Record<string, never>,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{ terminate?: boolean; details?: { silent?: boolean } }>;
    };

    await createSenderSession("+10000000000", config, { executor: makeNoopExecutor() });

    const call = createAgentSessionMock.mock.calls.at(-1)?.[0] as {
      customTools: WaitTool[];
    };
    const customTools = call.customTools;

    expect(customTools.map((tool: { name: string }) => tool.name)).toEqual(["wait", "read", "bash", "edit", "write"]);

    const waitTool = customTools[0];
    expect(waitTool).toBeDefined();
    if (!waitTool) throw new Error("wait tool missing");

    const result = await waitTool.execute("call-1", {}, undefined, undefined, {});
    expect(result).toMatchObject({ terminate: true, details: { silent: true } });
  });

  it("surfaces waitCalled in run results and resets it on the next run", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    const fakeSessionManager = {
      getEntries: vi.fn(() => []),
      getSessionFile: vi.fn(() => "/fake/sessions/run.jsonl"),
    };
    let subscriber: ((event: unknown) => void) | undefined;
    const customSession = {
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        subscriber = fn;
      }),
      prompt: vi
        .fn()
        .mockImplementationOnce(async () => {
          subscriber?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Working on it" }],
              stopReason: "tool_use",
            },
          });
          subscriber?.({
            type: "tool_execution_start",
            toolCallId: "wait-1",
            toolName: "wait",
            args: {},
          });
          subscriber?.({
            type: "tool_execution_end",
            toolCallId: "wait-1",
            toolName: "wait",
            isError: false,
            result: {
              content: [{ type: "text", text: "The current turn ended silently." }],
              details: { silent: true },
              terminate: true,
            },
          });
        })
        .mockImplementationOnce(async () => {
          subscriber?.({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done" }],
              stopReason: "stop",
            },
          });
        }),
      messages: [],
      systemPrompt: "",
    };

    vi.spyOn(SessionManager, "create").mockReturnValue(
      fakeSessionManager as never,
    );
    createAgentSessionMock.mockImplementationOnce(async () => ({
      session: customSession as never,
    } as never));

    const runner = await createSenderSession("+10000000000", config, { forceNew: true, executor: makeNoopExecutor() });

    const first = await runner.run({ sender: "+10000000000" }, { text: "hello" });
    expect(first).toMatchObject({
      response: "Working on it",
      waitCalled: true,
      sessionFile: "/fake/sessions/run.jsonl",
    });

    const second = await runner.run({ sender: "+10000000000" }, { text: "hello again" });
    expect(second).toMatchObject({
      response: "Done",
      waitCalled: false,
      sessionFile: "/fake/sessions/run.jsonl",
    });
  });

  it("continues from a synthetic read() tool result without a user message", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const { SessionManager } = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);

    const state = { messages: [] as unknown[] };
    const sessionEntries: Array<{ type: string; id: string; message: unknown }> = [];
    const fakeSessionManager = {
      getEntries: vi.fn(() => sessionEntries),
      getSessionFile: vi.fn(() => "/fake/sessions/run.jsonl"),
      appendMessage: vi.fn((message: unknown) => {
        sessionEntries.push({ type: "message", id: `m${sessionEntries.length + 1}`, message });
      }),
    };

    let subscriber: ((event: unknown) => void) | undefined;
    const continueMock = vi.fn(async () => {
      subscriber?.({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Handled scheduled event" }],
          stopReason: "stop",
        },
      });
    });

    const customSession = {
      subscribe: vi.fn((fn: (event: unknown) => void) => {
        subscriber = fn;
      }),
      prompt: vi.fn(async () => {}),
      get messages() {
        return state.messages;
      },
      agent: {
        state: {
          get messages() {
            return state.messages;
          },
          set messages(value: unknown[]) {
            state.messages = value;
          },
        },
        continue: continueMock,
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-5",
      },
      systemPrompt: "",
    };

    vi.spyOn(SessionManager, "create").mockReturnValue(fakeSessionManager as never);
    createAgentSessionMock.mockImplementationOnce(async () => ({ session: customSession as never } as never));

    const runner = await createSenderSession("+10000000000", config, { forceNew: true, executor: makeNoopExecutor() });
    const result = await runner.runSyntheticRead(
      { sender: "+10000000000" },
      { path: "events/lifecycle.json", content: '{"type":"periodic","text":"check in"}' },
    );

    expect(continueMock).toHaveBeenCalledTimes(1);
    expect(fakeSessionManager.appendMessage).toHaveBeenCalledTimes(2);
    expect(result.userMessageId).toBeUndefined();
    expect(result.response).toBe("Handled scheduled event");
    expect(result.waitCalled).toBe(false);

    const [assistantCall, toolResult] = state.messages as Array<Record<string, unknown>>;
    expect(assistantCall?.role).toBe("assistant");
    expect(assistantCall?.stopReason).toBe("toolUse");
    expect(Array.isArray(assistantCall?.content)).toBe(true);
    const toolCall = (assistantCall?.content as Array<Record<string, unknown>>)[0];
    expect(toolCall).toMatchObject({ type: "toolCall", name: "read", arguments: { path: "events/lifecycle.json" } });
    expect(toolResult).toMatchObject({ role: "toolResult", toolName: "read" });
  });

  it("registers sandboxed read/bash/edit/write overrides through customTools", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    const execMock = vi.fn(async () => ({ stdout: "", stderr: "", code: 0 }));
    const executor: Executor = { exec: execMock };
    type SandboxTool = {
      name: string;
      execute: (
        toolCallId: string,
        params: { command: string },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<unknown>;
    };

    await createSenderSession("+10000000000", config, { executor });

    const call = createAgentSessionMock.mock.calls[0]?.[0] as {
      customTools: SandboxTool[];
    };
    const customTools = call.customTools;

    expect(customTools.map((tool: { name: string }) => tool.name)).toEqual([
      "wait",
      "read",
      "bash",
      "edit",
      "write",
    ]);

    const bashTool = customTools.find((tool: { name: string }) => tool.name === "bash");
    expect(bashTool).toBeDefined();
    if (!bashTool) throw new Error("sandbox bash override missing");

    await bashTool.execute("call-1", { command: "pwd" }, undefined, undefined, {});

    expect(execMock).toHaveBeenCalledWith("pwd", expect.objectContaining({ cwd: "/workspace" }));
  });

  it("returns image blocks through the session-visible sandbox read override", async () => {
    const { createSenderSession } = await import("../src/runner.js");
    const codingAgent = await import("@earendil-works/pi-coding-agent");
    const createAgentSessionMock = vi.mocked(codingAgent.createAgentSession);
    const workspaceRoot = path.join(tmpDir, "users", "+10000000000");
    await fs.copyFile(
      path.join(process.cwd(), "test", "fixtures", "tool-contract", "sample.png"),
      path.join(workspaceRoot, "sample.png"),
    );
    type ReadTool = {
      name: string;
      execute: (
        toolCallId: string,
        params: { path: string },
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown,
      ) => Promise<{ content?: Array<{ type: string; text?: string }> }>;
    };

    await createSenderSession("+10000000000", config, {
      executor: makeWorkspaceMappedLocalExecutor(workspaceRoot),
    });

    const rawCall = createAgentSessionMock.mock.calls.at(-1)?.[0] as unknown;
    if (!rawCall || typeof rawCall !== "object") {
      throw new Error("missing createAgentSession call");
    }
    const customTools = (rawCall as { customTools?: unknown }).customTools;
    if (!Array.isArray(customTools)) {
      throw new Error("missing custom tools");
    }
    const readTool = (customTools as ReadTool[]).find((tool) => tool.name === "read");
    expect(readTool).toBeDefined();
    if (!readTool) throw new Error("sandbox read override missing");

    const result = await readTool.execute("call-1", { path: "sample.png" }, undefined, undefined, {}) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const content = Array.isArray(result.content) ? result.content : [];

    expect(content.map((part) => part.type)).toEqual(["text", "image"]);
    expect(content[0]?.type).toBe("text");
    expect(content[0]?.text).toContain("Read image file [image/png]");
  });
});
