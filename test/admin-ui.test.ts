import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminUiServer } from "../src/admin-ui.js";
import type { EditableWorkspaceRecordInput, WorkspaceRecord } from "../src/provisioner.js";
import type { SandboxAdminRunResult } from "../src/sandbox-admin.js";
import type { WorkspaceControlReconcileResult } from "../src/workspace-control.js";

const baseState = {
  workspaces: [
    {
      workspaceKey: "ws_a7b3c9",
      displayName: "my-project",
      workspacePath: "clients/acme",
      status: "active" as const,
      transport: "signal",
      bindingPreview: "+15551234567",
      surfaces: ["code-server"],
      searchText: "my-project ws_a7b3c9 clients/acme +15551234567 active signal",
    },
  ],
  selectedWorkspaceKey: "ws_a7b3c9",
  selected: {
    workspaceKey: "ws_a7b3c9",
    displayName: "my-project",
    label: "my-project",
    workspacePath: "clients/acme",
    status: "active" as const,
    lastSeen: "2026-05-27T00:00:00.000Z",
    canEditWorkspacePath: false,
    canEditStatus: false,
    model: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "off",
    },
    desiredState: {
      codeServerEnabled: true,
      calendarEnabled: false,
      sessionWatchEnabled: false,
      bootEnabled: true,
    },
    capabilities: {
      pdfApiEnabled: false,
      spreadsheetRecalcEnabled: false,
    },
    access: {
      sessionSummary: "inactive",
      effectiveModelSummary: "claude-sonnet-4-5 (anthropic) · thinking: off",
      lastSeen: "2026-05-27T00:00:00.000Z",
      codeServerUrl: "https://code.example.com",
      codeServerPassword: "secret",
    },
  },
};

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function makeRecord(): WorkspaceRecord {
  return {
    createdAt: "2026-05-27T00:00:00.000Z",
    lastSeen: "2026-05-27T00:00:00.000Z",
    status: "active",
    workspacePath: "clients/acme",
    primaryTransport: "signal",
    transports: { signal: { sender: "+15551234567", userWhitelist: [] } },
    codeServer: { enabled: true, password: "secret", port: 18440 },
    calendar: { enabled: false },
    sessionWatch: { enabled: false },
    boot: { enabled: true },
    capabilities: {
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    },
  };
}

function makeReconcileResult(): WorkspaceControlReconcileResult {
  return {
    shapeUpdated: [],
    codeServerStarted: ["ws_a7b3c9"],
    codeServerStopped: [],
    calendarPrepared: [],
    calendarRemoved: [],
    sessionWatchPrepared: [],
    sessionWatchRemoved: [],
    capabilityAttached: [],
    capabilityDetached: [],
    capabilityMissing: [],
    piSelectionChanged: [],
    runnersReset: [],
    runnersSkippedActive: [],
    missingDirs: [],
  };
}

function makeSandboxAdminResult(): SandboxAdminRunResult {
  return {
    version: 1,
    timestamp: "2026-05-28T12:00:00.000Z",
    workspaceKey: "ws_a7b3c9",
    sandboxContainer: "pi-sandbox-ws_a7b3c9",
    bridgeContainer: "pi-bridge",
    network: "pi_default",
    cwd: "/workspace",
    user: "0",
    command: "apt-get update",
    exitCode: 0,
    stdout: "ok\n",
    stderr: "",
    attachedHere: true,
    disconnectFailed: false,
    replay: [],
    historyPath: "/bridge-data/admin/sandbox-admin-history.jsonl",
  };
}

describe("AdminUiServer", () => {
  const servers: AdminUiServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
  });

  function createServer(overrides: {
    saveWorkspace?: (workspaceKey: string, input: EditableWorkspaceRecordInput) => Promise<WorkspaceRecord>;
    checkState?: (workspaceKey?: string) => Promise<typeof baseState>;
    reconcile?: (resetRunners: boolean, workspaceKey?: string) => Promise<{ state: typeof baseState; result: WorkspaceControlReconcileResult }>;
    deleteWorkspace?: (workspaceKey: string) => Promise<WorkspaceRecord>;
    runSandboxAdmin?: (workspaceKey: string, command: string) => Promise<SandboxAdminRunResult>;
  } = {}): AdminUiServer {
    const server = new AdminUiServer({
      bindHost: "127.0.0.1",
      port: 0,
      username: "operator",
      password: "secret",
    }, {
      provisioner: {} as never,
      router: {} as never,
      saveWorkspace: overrides.saveWorkspace ?? (async () => makeRecord()),
      checkState: overrides.checkState ?? (async () => baseState),
      reconcile: overrides.reconcile ?? (async () => ({ state: baseState, result: makeReconcileResult() })),
      deleteWorkspace: overrides.deleteWorkspace ?? (async () => makeRecord()),
      runSandboxAdmin: overrides.runSandboxAdmin ?? (async () => makeSandboxAdminResult()),
    });
    servers.push(server);
    return server;
  }

  async function serverUrl(server: AdminUiServer): Promise<string> {
    await server.start();
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("requires HTTP Basic Auth before serving the UI", async () => {
    const server = createServer();
    const baseUrl = await serverUrl(server);

    const unauthenticated = await fetch(`${baseUrl}/admin`);
    const authenticated = await fetch(`${baseUrl}/admin`, {
      headers: { Authorization: basicAuth("operator", "secret") },
    });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("www-authenticate")).toContain("Basic");
    expect(authenticated.status).toBe(200);
    expect(authenticated.headers.get("content-type")).toContain("text/html");
    const page = await authenticated.text();
    expect(page).toContain("workspace.json is canonical");
    expect(page).toContain("Temporary sandbox admin");
  });

  it("returns current UI state from the authenticated JSON endpoint", async () => {
    const checkState = vi.fn(async () => baseState);
    const server = createServer({ checkState });
    const baseUrl = await serverUrl(server);

    const response = await fetch(`${baseUrl}/admin/api/state?workspaceKey=ws_a7b3c9`, {
      headers: { Authorization: basicAuth("operator", "secret") },
    });
    const body = await response.json() as { state: typeof baseState; message: string };

    expect(response.status).toBe(200);
    expect(checkState).toHaveBeenCalledWith("ws_a7b3c9");
    expect(body.state.selectedWorkspaceKey).toBe("ws_a7b3c9");
    expect(body.message).toContain("Loaded workspace control-plane state");
  });

  it("saves editable workspace fields through the shared save callback", async () => {
    const saveWorkspace = vi.fn(async () => makeRecord());
    const checkState = vi.fn(async () => baseState);
    const server = createServer({ saveWorkspace, checkState });
    const baseUrl = await serverUrl(server);

    const response = await fetch(`${baseUrl}/admin/api/workspaces/ws_a7b3c9`, {
      method: "PUT",
      headers: {
        Authorization: basicAuth("operator", "secret"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        label: "renamed",
        piProvider: "openai",
        piModel: "gpt-4o",
        piThinkingLevel: "minimal",
        codeServerEnabled: true,
        calendarEnabled: false,
        sessionWatchEnabled: false,
        bootEnabled: true,
        capabilities: {
          pdfApi: { enabled: true },
          spreadsheetRecalc: { enabled: false },
        },
        signal: {
          sender: "+15551234567",
          userWhitelist: ["+15550000000"],
        },
      }),
    });
    const body = await response.json() as { message: string };

    expect(response.status).toBe(200);
    expect(saveWorkspace).toHaveBeenCalledWith("ws_a7b3c9", expect.objectContaining({
      label: "renamed",
      piProvider: "openai",
      piModel: "gpt-4o",
      piThinkingLevel: "minimal",
      codeServerEnabled: true,
      capabilities: {
        pdfApi: { enabled: true },
        spreadsheetRecalc: { enabled: false },
      },
      signal: {
        sender: "+15551234567",
        groupId: undefined,
        userWhitelist: ["+15550000000"],
      },
    }));
    expect(checkState).toHaveBeenCalledWith("ws_a7b3c9");
    expect(body.message).toContain("Saved ws_a7b3c9");
  });

  it("runs reconcile and returns the formatted reconcile details", async () => {
    const reconcile = vi.fn(async () => ({ state: baseState, result: makeReconcileResult() }));
    const server = createServer({ reconcile });
    const baseUrl = await serverUrl(server);

    const response = await fetch(`${baseUrl}/admin/api/reconcile`, {
      method: "POST",
      headers: {
        Authorization: basicAuth("operator", "secret"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceKey: "ws_a7b3c9", resetRunners: true }),
    });
    const body = await response.json() as { details: string; message: string };

    expect(response.status).toBe(200);
    expect(reconcile).toHaveBeenCalledWith(true, "ws_a7b3c9");
    expect(body.message).toContain("reset inactive runners");
    expect(body.details).toContain("codeServerStarted=ws_a7b3c9");
  });

  it("runs sandbox admin through the shared callback", async () => {
    const runSandboxAdmin = vi.fn(async () => makeSandboxAdminResult());
    const server = createServer({ runSandboxAdmin });
    const baseUrl = await serverUrl(server);

    const response = await fetch(`${baseUrl}/admin/api/workspaces/ws_a7b3c9/sandbox-admin`, {
      method: "POST",
      headers: {
        Authorization: basicAuth("operator", "secret"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command: "apt-get update" }),
    });
    const body = await response.json() as { sandboxAdmin: SandboxAdminRunResult; message: string };

    expect(response.status).toBe(200);
    expect(runSandboxAdmin).toHaveBeenCalledWith("ws_a7b3c9", "apt-get update");
    expect(body.message).toContain("Sandbox admin command completed");
    expect(body.sandboxAdmin.exitCode).toBe(0);
  });

  it("requires typed confirmation for destructive delete", async () => {
    const deleteWorkspace = vi.fn(async () => makeRecord());
    const server = createServer({ deleteWorkspace });
    const baseUrl = await serverUrl(server);

    const response = await fetch(`${baseUrl}/admin/api/workspaces/ws_a7b3c9/delete`, {
      method: "POST",
      headers: {
        Authorization: basicAuth("operator", "secret"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "ws_other" }),
    });
    const body = await response.json() as { message: string };

    expect(response.status).toBe(400);
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(body.message).toContain("exactly match ws_a7b3c9");
  });
});
