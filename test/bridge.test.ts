import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { HELP_TEXT, deliverRunnerResult, handleInboundMessage, handleMessageImpl, handleScheduledEventImpl } from "../src/bridge.js";
import type { Config } from "../src/config.js";
import type { WorkspaceRecord } from "../src/provisioner.js";
import type { RunResult } from "../src/runner.js";
import type { InboundMessage, Transport, TransportName } from "../src/transport.js";

function makeConfig(workspaceDir: string): Config {
  return {
    signalCliUrl: "http://localhost:8080",
    signalPhoneNumber: "+15550000000",
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
      publicUrlTemplate: undefined,
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

function makeTransport(name: "signal" | "nextcloud"): Transport & {
  send: ReturnType<typeof vi.fn>;
} {
  return {
    name,
    maxMessageLength: 4_000,
    send: vi.fn(async () => ({})),
    fetchAttachment: async () => Buffer.from(""),
    waitUntilReady: async () => {},
    listen: () => {},
    stop: () => {},
  };
}

function makeRecord(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    createdAt: "2026-05-05T00:00:00.000Z",
    lastSeen: "2026-05-05T00:00:00.000Z",
    status: "active",
    workspacePath: "users/ws_new",
    primaryTransport: "signal",
    transports: {
      signal: { sender: "+15551234567", userWhitelist: [] },
    },
    ...overrides,
  } as WorkspaceRecord;
}

describe("bridge orchestration", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    config = makeConfig(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("dispatches an inbound message to the resolved workspace", async () => {
    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const record = makeRecord();
    const provisioner = {
      lookup: vi.fn(() => "ws_a7b3c9"),
      getWorkspace: vi.fn(() => record),
      updateLastSeen: vi.fn(async () => {}),
    };

    let handled: unknown[] = [];
    let dispatchPromise = Promise.resolve();
    const router = {
      dispatch: vi.fn((workspaceKey: string, fn: () => Promise<void>) => {
        dispatchPromise = fn();
        handled[0] = workspaceKey;
      }),
    };

    const inbound: InboundMessage = {
      sender: "+15551234567",
      text: "hello",
      attachments: [],
      meta: {
        transport: "signal",
        senderId: "+15551234567",
      },
    };

    await handleInboundMessage(
      inbound,
      config,
      transportMap,
      provisioner as never,
      router as never,
      {} as never,
      { applyWorkspaceCapabilities: vi.fn(async () => ({ attached: [], detached: [], missing: [], networkCreated: false, networkRemoved: false })) } as never,
      async (...args: unknown[]) => {
        handled = args;
      },
    );
    await dispatchPromise;

    expect(provisioner.updateLastSeen).toHaveBeenCalledWith("ws_a7b3c9");
    expect(router.dispatch).toHaveBeenCalledOnce();
    expect(handled[0]).toBe("ws_a7b3c9");
    expect(handled[1]).toBe("hello");
    expect(handled[2]).toEqual([]);
    expect(handled[3]).toBe(inbound);
  });

  it("provisions an unknown binding and applies workspace desired state before dispatch", async () => {
    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const record = makeRecord({
      codeServer: { enabled: true },
      calendar: { enabled: true },
    });
    const provisioner = {
      lookup: vi.fn(() => undefined),
      getWorkspace: vi.fn(() => undefined),
      ensureProvisioned: vi.fn(async () => ({ workspaceKey: "ws_new", record, isNew: true })),
      ensureCodeServerAccess: vi.fn(async () => ({ password: "secret", port: 18440 })),
      ensureCalendarAccess: vi.fn(async () => ({ enabled: true, token: "calendar-token" })),
      updateLastSeen: vi.fn(async () => {}),
    };
    const codeServerManager = {
      ensureRunning: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    let handled: unknown[] = [];
    let dispatchPromise = Promise.resolve();
    const router = {
      dispatch: vi.fn((workspaceKey: string, fn: () => Promise<void>) => {
        dispatchPromise = fn();
        handled[0] = workspaceKey;
      }),
    };

    const inbound: InboundMessage = {
      sender: "+15551234567",
      text: "hello",
      attachments: [],
      meta: {
        transport: "signal",
        senderId: "+15551234567",
      },
    };

    await handleInboundMessage(
      inbound,
      config,
      transportMap,
      provisioner as never,
      router as never,
      codeServerManager as never,
      { applyWorkspaceCapabilities: vi.fn(async () => ({ attached: [], detached: [], missing: [], networkCreated: false, networkRemoved: false })) } as never,
      async (...args: unknown[]) => {
        handled = args;
      },
    );
    await dispatchPromise;

    expect(provisioner.ensureProvisioned).toHaveBeenCalledWith("signal", "+15551234567", {
      defaultCodeServerEnabled: false,
      defaultCalendarEnabled: false,
      binding: { sender: "+15551234567" },
    });
    expect(provisioner.ensureCodeServerAccess).toHaveBeenCalledWith("ws_new");
    expect(codeServerManager.ensureRunning).toHaveBeenCalledWith(
      "ws_new",
      "users/ws_new",
      { password: "secret", port: 18440 },
      "signal",
    );
    expect(provisioner.ensureCalendarAccess).toHaveBeenCalledWith("ws_new");
    expect(provisioner.updateLastSeen).toHaveBeenCalledWith("ws_new");
    expect(router.dispatch).toHaveBeenCalledOnce();
    expect(handled[0]).toBe("ws_new");
    expect(handled[1]).toBe("hello");
    expect(handled[2]).toEqual([]);
    expect(handled[3]).toBe(inbound);
  });

  it("handles !help at the transport boundary without invoking the runner", async () => {
    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const router = {
      reset: vi.fn(),
      getOrCreate: vi.fn(),
    };
    const provisioner = {
      getWorkspace: vi.fn(() => makeRecord({
        transports: { signal: { groupId: "group-123", userWhitelist: [] } },
      })),
    };

    await handleMessageImpl(
      "ws_a7b3c9",
      " !help ",
      [],
      config,
      transportMap,
      router as never,
      provisioner as never,
      {} as never,
      {} as never,
    );

    expect(transport.send).toHaveBeenCalledWith("group-123", HELP_TEXT, { target: "group-123" });
    expect(HELP_TEXT).not.toContain("!reset-silent");
    expect(router.getOrCreate).not.toHaveBeenCalled();
  });

  it("renders !status as a workspace dashboard from bridge-owned state", async () => {
    config.codeServer.publicUrlTemplate = "https://code-{workspaceKey}.example.com/";
    config.calendar.publicBaseUrl = "https://cal.example.com";
    config.sessionWatch = {
      enabled: true,
      bindHost: "0.0.0.0",
      port: 8791,
      publicBaseUrl: "https://watch.example.com/base",
    };

    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const router = {
      getCachedRunner: vi.fn(() => ({
        modelProvider: "anthropic",
        modelName: "claude-sonnet-4-5",
        thinkingLevel: "high",
        messageCount: 14,
      })),
    };
    const provisioner = {
      getWorkspace: vi.fn(() => makeRecord({
        label: "my-project",
        codeServer: { enabled: true, password: "abc123xyz", port: 18440 },
        calendar: { enabled: true, token: "feed-token" },
        sessionWatch: { enabled: true, token: "watch-token" },
      })),
    };

    await handleMessageImpl(
      "ws_a7b3c9",
      "!status",
      [],
      config,
      transportMap,
      router as never,
      provisioner as never,
      {} as never,
      {} as never,
    );

    expect(transport.send).toHaveBeenCalledWith(
      "+15551234567",
      [
        "Workspace: my-project (ws_a7b3c9)",
        "Workspace path: users/ws_new",
        "Model: claude-sonnet-4-5 (anthropic) · thinking: high",
        "Session: active · 14 messages",
        "",
        "Code editor: https://code-ws_a7b3c9.example.com/",
        "  Password: abc123xyz",
        "",
        "Calendar subscription:",
        "  https://cal.example.com/calendar/ws_a7b3c9/feed-token.ics",
        "",
        "Session watch:",
        "  https://watch.example.com/base/watch/ws_a7b3c9/watch-token",
      ].join("\n"),
      { target: undefined },
    );
  });

  it("falls back to workspace-configured model info in !status when no runner is cached", async () => {
    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const router = {
      getCachedRunner: vi.fn(() => undefined),
    };
    const provisioner = {
      getWorkspace: vi.fn(() => makeRecord({
        workspacePath: "projects/acme",
        piProvider: "openai",
        piModel: "gpt-4o",
        piThinkingLevel: "minimal",
      })),
    };

    await handleMessageImpl(
      "ws_a7b3c9",
      "!status",
      [],
      config,
      transportMap,
      router as never,
      provisioner as never,
      {} as never,
      {} as never,
    );

    expect(transport.send).toHaveBeenCalledWith(
      "+15551234567",
      [
        "Workspace: projects/acme (ws_a7b3c9)",
        "Workspace path: projects/acme",
        "Model: gpt-4o (openai) · thinking: minimal",
        "Session: inactive",
      ].join("\n"),
      { target: undefined },
    );
  });

  it("commits one inbound workspace snapshot after a completed run", async () => {
    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const record = makeRecord();
    const runner = {
      modelName: "claude-sonnet-4-5",
      userDir: tmpDir,
      agentWorkspaceRoot: tmpDir,
      run: vi.fn(async () => ({ response: "Done.", waitCalled: false })),
    };
    const router = {
      getOrCreate: vi.fn(async () => runner),
    };
    const provisioner = {
      getWorkspace: vi.fn(() => record),
    };
    const workspaceGit = {
      commitCompletedRun: vi.fn(async () => true),
    };

    await handleMessageImpl(
      "ws_a7b3c9",
      "hello",
      [],
      config,
      transportMap,
      router as never,
      provisioner as never,
      {} as never,
      {} as never,
      undefined,
      { workspaceGit: workspaceGit as never },
    );

    expect(workspaceGit.commitCompletedRun).toHaveBeenCalledWith("users/ws_new", "inbound");
  });

  it("commits one scheduled workspace snapshot after a completed run", async () => {
    const transport = makeTransport("signal");
    const transportMap = new Map<TransportName, Transport>([["signal", transport]]);
    const record = makeRecord();
    const runner = {
      runSyntheticRead: vi.fn(async () => ({ response: "", waitCalled: true })),
    };
    const router = {
      getOrCreate: vi.fn(async () => runner),
    };
    const provisioner = {
      getWorkspace: vi.fn(() => record),
    };
    const workspaceGit = {
      commitCompletedRun: vi.fn(async () => true),
    };

    await handleScheduledEventImpl(
      "ws_a7b3c9",
      {
        filename: "review.json",
        rawContent: '{"type":"periodic"}',
        event: { type: "periodic", text: "Review", schedule: "0 9 * * *" },
      } as never,
      config,
      transportMap,
      router as never,
      provisioner as never,
      { workspaceGit: workspaceGit as never },
    );

    expect(workspaceGit.commitCompletedRun).toHaveBeenCalledWith("users/ws_new", "scheduled");
  });

  it("suppresses outbound sends when wait() ended the turn silently", async () => {
    const userDir = path.join(tmpDir, "users", "ws_a7b3c9");
    await fs.mkdir(userDir, { recursive: true });
    const transport = makeTransport("signal");
    const runner = {
      userDir,
      agentWorkspaceRoot: userDir,
    };
    const result: RunResult = {
      response: "Working on it",
      waitCalled: true,
      sessionFile: path.join(userDir, "sessions", "run.jsonl"),
    };

    await deliverRunnerResult({
      workspaceKey: "ws_a7b3c9",
      sourceText: "hello",
      result,
      runner: runner as never,
      transport,
      transportRecipient: "+15551234567",
      replyTarget: undefined,
      outboundTransportName: "signal",
    });

    expect(transport.send).not.toHaveBeenCalled();
  });
});
