import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../src/config.js";
import {
  applyWorkspaceDesiredState,
  formatWorkspaceControlReconcileResult,
  reconcileWorkspaceControlPlane,
  summarizeWorkspaceControlState,
} from "../src/workspace-control.js";

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

describe("workspace-control", () => {
  let tmpDir: string;
  let config: Config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-control-test-"));
    config = makeConfig(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("summarizes workspace state after initializing the provisioner", async () => {
    const provisioner = {
      initialize: vi.fn(async () => {}),
      listWorkspaces: vi.fn(() => ({
        ws_b2: {
          primaryTransport: "nextcloud",
          codeServer: { enabled: false },
          calendar: { enabled: false },
        },
        ws_a1: {
          primaryTransport: "signal",
          codeServer: { enabled: true, password: "secret", port: 18440 },
          calendar: { enabled: true, token: "tok" },
          piProvider: "openai",
          piModel: "gpt-4o",
          piThinkingLevel: "minimal",
        },
      })),
    };

    const rows = await summarizeWorkspaceControlState(provisioner as never);

    expect(provisioner.initialize).toHaveBeenCalledOnce();
    expect(rows).toEqual([
      {
        workspaceKey: "ws_a1",
        transport: "signal",
        codeServerEnabled: true,
        codeServerReady: true,
        calendarEnabled: true,
        calendarReady: true,
        model: "openai/gpt-4o @ minimal",
      },
      {
        workspaceKey: "ws_b2",
        transport: "nextcloud",
        codeServerEnabled: false,
        codeServerReady: false,
        calendarEnabled: false,
        calendarReady: false,
        model: "(default)/(default) @ (default)",
      },
    ]);
  });

  it("applies desired state for one workspace through the shared owner", async () => {
    const provisioner = {
      ensureCodeServerAccess: vi.fn(async () => ({ password: "secret", port: 18440 })),
      ensureCalendarAccess: vi.fn(async () => ({ token: "calendar-token" })),
    };
    const codeServerManager = {
      ensureRunning: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    const result = await applyWorkspaceDesiredState({
      workspaceKey: "ws_live",
      record: {
        status: "active",
        workspacePath: "users/ws_live",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551230001" } },
        codeServer: { enabled: true },
        calendar: { enabled: false },
      } as never,
      provisioner: provisioner as never,
      codeServerManager: codeServerManager as never,
    });

    expect(provisioner.ensureCodeServerAccess).toHaveBeenCalledWith("ws_live");
    expect(codeServerManager.ensureRunning).toHaveBeenCalledWith(
      "ws_live",
      "users/ws_live",
      { password: "secret", port: 18440 },
      "signal",
    );
    expect(codeServerManager.stop).not.toHaveBeenCalled();
    expect(provisioner.ensureCalendarAccess).not.toHaveBeenCalled();
    expect(result).toEqual({
      codeServerStarted: true,
      codeServerStopped: false,
      calendarPrepared: false,
      calendarRemoved: true,
    });
  });

  it("reconciles live, disabled, and missing workspaces into explicit outcome buckets", async () => {
    const liveDir = path.join(tmpDir, "users", "ws_live");
    const disabledDir = path.join(tmpDir, "users", "ws_disabled");
    await fs.mkdir(liveDir, { recursive: true });
    await fs.mkdir(disabledDir, { recursive: true });

    const provisioner = {
      reload: vi.fn(async () => {}),
      reconcileDesiredStateShape: vi.fn(async () => ["ws_shape"]),
      listWorkspaces: vi.fn(() => ({
        ws_live: {
          status: "active",
          workspacePath: "users/ws_live",
          provisionedAt: "2026-01-01T00:00:00.000Z",
          primaryTransport: "signal",
          transports: { signal: { sender: "+15551230001" } },
          codeServer: { enabled: true },
          calendar: { enabled: true },
        },
        ws_disabled: {
          status: "active",
          workspacePath: "users/ws_disabled",
          provisionedAt: "2026-01-01T00:00:00.000Z",
          primaryTransport: "nextcloud",
          transports: { nextcloud: { roomToken: "room-disabled", userWhitelist: [] } },
          codeServer: { enabled: false },
          calendar: { enabled: false },
        },
        ws_missing: {
          status: "active",
          workspacePath: "users/ws_missing",
          provisionedAt: "2026-01-01T00:00:00.000Z",
          primaryTransport: "signal",
          transports: { signal: { sender: "+15551230003" } },
          codeServer: { enabled: true },
          calendar: { enabled: false },
        },
      })),
      getWorkspaceRoot: vi.fn((workspaceKey: string) => {
        if (workspaceKey === "ws_live") return liveDir;
        if (workspaceKey === "ws_disabled") return disabledDir;
        if (workspaceKey === "ws_missing") return path.join(tmpDir, "users", "ws_missing");
        return undefined;
      }),
      ensureCodeServerAccess: vi.fn(async () => ({ password: "secret", port: 18440 })),
      ensureCalendarAccess: vi.fn(async () => ({ token: "calendar-token" })),
    };
    const eventsManager = {
      startForUser: vi.fn(),
    };
    const codeServerManager = {
      ensureRunning: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const router = {
      reconcileWorkspacePiSelections: vi.fn(async () => ({
        changed: ["ws_live"],
        reset: ["ws_live"],
        skippedActive: ["ws_disabled"],
      })),
    };

    const result = await reconcileWorkspaceControlPlane({
      config,
      provisioner: provisioner as never,
      eventsManager: eventsManager as never,
      codeServerManager: codeServerManager as never,
      router: router as never,
      resetRunners: true,
    });

    expect(provisioner.reload).toHaveBeenCalledTimes(2);
    expect(eventsManager.startForUser).toHaveBeenCalledWith("ws_live");
    expect(eventsManager.startForUser).toHaveBeenCalledWith("ws_disabled");
    expect(eventsManager.startForUser).not.toHaveBeenCalledWith("ws_missing");
    expect(provisioner.ensureCodeServerAccess).toHaveBeenCalledWith("ws_live");
    expect(codeServerManager.ensureRunning).toHaveBeenCalledWith(
      "ws_live",
      "users/ws_live",
      { password: "secret", port: 18440 },
      "signal",
    );
    expect(codeServerManager.stop).toHaveBeenCalledWith("ws_disabled");
    expect(codeServerManager.stop).toHaveBeenCalledWith("ws_missing");
    expect(provisioner.ensureCalendarAccess).toHaveBeenCalledWith("ws_live");
    expect(router.reconcileWorkspacePiSelections).toHaveBeenCalledWith(true);
    expect(result).toEqual({
      shapeUpdated: ["ws_shape"],
      codeServerStarted: ["ws_live"],
      codeServerStopped: ["ws_disabled"],
      calendarPrepared: ["ws_live"],
      calendarRemoved: ["ws_disabled"],
      piSelectionChanged: ["ws_live"],
      runnersReset: ["ws_live"],
      runnersSkippedActive: ["ws_disabled"],
      missingDirs: ["ws_missing"],
    });
  });

  it("provisions a manually approved pending workspace on reconcile when provisionedAt is still absent", async () => {
    const missingRoot = path.join(tmpDir, "rooms", "approved-room");
    const provisionedRecord = {
      status: "active",
      workspacePath: "rooms/approved-room",
      provisionedAt: "2026-05-08T07:00:00.000Z",
      primaryTransport: "signal",
      transports: { signal: { sender: "+15551230009" } },
      codeServer: { enabled: false },
      calendar: { enabled: false },
    };

    const provisioner = {
      reload: vi.fn(async () => {}),
      reconcileDesiredStateShape: vi.fn(async () => []),
      listWorkspaces: vi.fn(() => ({
        ws_pending: {
          status: "active",
          workspacePath: "rooms/approved-room",
          primaryTransport: "signal",
          transports: { signal: { sender: "+15551230009" } },
          codeServer: { enabled: false },
          calendar: { enabled: false },
        },
      })),
      getWorkspaceRoot: vi.fn(() => missingRoot),
      provisionPendingWorkspace: vi.fn(async () => provisionedRecord),
      ensureCodeServerAccess: vi.fn(async () => ({ password: "secret", port: 18440 })),
      ensureCalendarAccess: vi.fn(async () => ({ token: "calendar-token" })),
    };
    const eventsManager = {
      startForUser: vi.fn(),
    };
    const codeServerManager = {
      ensureRunning: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const router = {
      reconcileWorkspacePiSelections: vi.fn(async () => ({
        changed: [],
        reset: [],
        skippedActive: [],
      })),
    };

    const result = await reconcileWorkspaceControlPlane({
      config,
      provisioner: provisioner as never,
      eventsManager: eventsManager as never,
      codeServerManager: codeServerManager as never,
      router: router as never,
      resetRunners: false,
    });

    expect(provisioner.provisionPendingWorkspace).toHaveBeenCalledWith("ws_pending");
    expect(eventsManager.startForUser).toHaveBeenCalledWith("ws_pending");
    expect(codeServerManager.stop).toHaveBeenCalledWith("ws_pending");
    expect(result.missingDirs).toEqual([]);
  });

  it("formats the reconcile result as stable operator-facing text", () => {
    expect(formatWorkspaceControlReconcileResult({
      shapeUpdated: ["ws_a1"],
      codeServerStarted: [],
      codeServerStopped: ["ws_b2"],
      calendarPrepared: ["ws_a1"],
      calendarRemoved: [],
      piSelectionChanged: ["ws_a1"],
      runnersReset: [],
      runnersSkippedActive: ["ws_b2"],
      missingDirs: [],
    })).toBe([
      "shapeUpdated=ws_a1",
      "codeServerStarted=none",
      "codeServerStopped=ws_b2",
      "calendarPrepared=ws_a1",
      "calendarRemoved=none",
      "piSelectionChanged=ws_a1",
      "runnersReset=none",
      "runnersSkippedActive=ws_b2",
      "missingDirs=none",
    ].join("\n"));
  });
});
