import * as http from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { calendarPublicUrl } from "./calendar.js";
import { codeServerStatusUrl } from "./code-server.js";
import type { AdminUiConfig, Config } from "./config.js";
import type { EditableWorkspaceRecordInput, UserProvisioner, WorkspaceRecord } from "./provisioner.js";
import { resolveWorkspacePiSelection, SessionRouter } from "./session-router.js";
import {
  formatWorkspaceControlReconcileResult,
  summarizeWorkspaceControlState,
  type WorkspaceControlReconcileResult,
} from "./workspace-control.js";
import { sessionWatchLocalUrl, sessionWatchPublicUrl } from "./session-watch.js";
import type { SandboxAdminRunResult } from "./sandbox-admin.js";

const HEALTH_PATH = "/healthz";
const ADMIN_ROUTE_PREFIX = "/admin";
const ADMIN_API_PREFIX = `${ADMIN_ROUTE_PREFIX}/api`;

interface WorkspaceListItem {
  workspaceKey: string;
  displayName: string;
  workspacePath: string;
  status: "active" | "pending";
  transport: string;
  bindingPreview: string;
  surfaces: string[];
  searchText: string;
}

interface WorkspaceUiDetail {
  workspaceKey: string;
  displayName: string;
  label?: string;
  workspacePath: string;
  status: "active" | "pending";
  lastSeen: string;
  provisionedAt?: string;
  canEditWorkspacePath: boolean;
  canEditStatus: boolean;
  signal?: {
    kind: "sender" | "group";
    value: string;
    userWhitelist: string[];
  };
  nextcloud?: {
    roomToken: string;
    userWhitelist: string[];
  };
  model: {
    provider: string;
    model: string;
    thinkingLevel: string;
  };
  desiredState: {
    codeServerEnabled: boolean;
    calendarEnabled: boolean;
    sessionWatchEnabled: boolean;
    bootEnabled: boolean;
  };
  capabilities: {
    pdfApiEnabled: boolean;
    spreadsheetRecalcEnabled: boolean;
    geminiSearchEnabled: boolean;
  };
  access: {
    sessionSummary: string;
    effectiveModelSummary: string;
    lastSeen: string;
    codeServerUrl?: string;
    codeServerPassword?: string;
    calendarUrl?: string;
    sessionWatchUrl?: string;
  };
}

interface WorkspaceUiState {
  workspaces: WorkspaceListItem[];
  selectedWorkspaceKey?: string;
  selected?: WorkspaceUiDetail;
}

interface ActionResponse {
  ok: boolean;
  level: "info" | "success" | "error";
  message: string;
  state?: WorkspaceUiState;
  details?: string;
  sandboxAdmin?: SandboxAdminRunResult;
}

interface AdminUiDeps {
  provisioner: UserProvisioner;
  router: SessionRouter;
  saveWorkspace: (workspaceKey: string, input: EditableWorkspaceRecordInput) => Promise<WorkspaceRecord>;
  checkState: (selectedWorkspaceKey?: string) => Promise<WorkspaceUiState>;
  reconcile: (resetRunners: boolean, selectedWorkspaceKey?: string) => Promise<{
    state: WorkspaceUiState;
    result: WorkspaceControlReconcileResult;
  }>;
  deleteWorkspace: (workspaceKey: string) => Promise<WorkspaceRecord>;
  runSandboxAdmin: (workspaceKey: string, command: string) => Promise<SandboxAdminRunResult>;
}

export class AdminUiServer {
  private server: http.Server | undefined;
  private listenReady: Promise<void> | undefined;

  constructor(
    private readonly adminConfig: AdminUiConfig,
    private readonly deps: AdminUiDeps,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;

    this.listenReady = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.adminConfig.port, this.adminConfig.bindHost, () => {
        this.server = server;
        resolve();
      });
    });

    await this.listenReady;
  }

  address(): string | AddressInfo | null {
    return this.server?.address() ?? null;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = undefined;
    this.listenReady = undefined;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname;

      if (method === "GET" && pathname === HEALTH_PATH) {
        this.sendText(res, 200, "ok");
        return;
      }

      if (!this.isAuthorized(req)) {
        res.writeHead(401, {
          "Content-Type": "text/plain; charset=utf-8",
          "WWW-Authenticate": 'Basic realm="pi-bridge-admin", charset="UTF-8"',
          "Cache-Control": "no-store",
        });
        res.end("authentication required");
        return;
      }

      if (method === "GET" && (pathname === ADMIN_ROUTE_PREFIX || pathname === `${ADMIN_ROUTE_PREFIX}/`)) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(renderAdminPage());
        return;
      }

      if (method === "GET" && pathname === `${ADMIN_API_PREFIX}/state`) {
        const selectedWorkspaceKey = normalizeOptionalString(url.searchParams.get("workspaceKey") ?? undefined);
        const state = await this.deps.checkState(selectedWorkspaceKey);
        this.sendJson(res, 200, {
          ok: true,
          level: "info",
          message: "Loaded workspace control-plane state.",
          state,
        } satisfies ActionResponse);
        return;
      }

      if (method === "POST" && pathname === `${ADMIN_API_PREFIX}/check`) {
        const body = await readJsonBody(req);
        const selectedWorkspaceKey = normalizeOptionalString(asOptionalString(body?.workspaceKey));
        const state = await this.deps.checkState(selectedWorkspaceKey);
        this.sendJson(res, 200, {
          ok: true,
          level: "info",
          message: "Refreshed control-plane summary from current workspace.json state.",
          state,
        } satisfies ActionResponse);
        return;
      }

      if (method === "POST" && pathname === `${ADMIN_API_PREFIX}/reconcile`) {
        const body = await readJsonBody(req);
        const selectedWorkspaceKey = normalizeOptionalString(asOptionalString(body?.workspaceKey));
        const resetRunners = body?.resetRunners === true;
        const { state, result } = await this.deps.reconcile(resetRunners, selectedWorkspaceKey);
        this.sendJson(res, 200, {
          ok: true,
          level: "success",
          message: resetRunners
            ? "Reconcile + reset inactive runners completed."
            : "Reconcile completed.",
          state,
          details: formatWorkspaceControlReconcileResult(result),
        } satisfies ActionResponse);
        return;
      }

      const updateRoute = parseWorkspaceRoute(pathname, "PUT");
      if (method === "PUT" && updateRoute?.kind === "workspace") {
        const body = await readJsonBody(req);
        const input = parseEditableWorkspaceInput(body);
        await this.deps.saveWorkspace(updateRoute.workspaceKey, input);
        const state = await this.deps.checkState(updateRoute.workspaceKey);
        this.sendJson(res, 200, {
          ok: true,
          level: "success",
          message: `Saved ${updateRoute.workspaceKey} to workspace.json.`,
          state,
        } satisfies ActionResponse);
        return;
      }

      const postRoute = parseWorkspaceRoute(pathname, "POST");
      if (method === "POST" && postRoute?.kind === "sandbox-admin") {
        const body = await readJsonBody(req);
        const command = normalizeOptionalString(asOptionalString(body?.command));
        if (!command) {
          this.sendJson(res, 400, {
            ok: false,
            level: "error",
            message: "Sandbox admin command must not be empty.",
          } satisfies ActionResponse);
          return;
        }

        const result = await this.deps.runSandboxAdmin(postRoute.workspaceKey, command);
        this.sendJson(res, 200, {
          ok: true,
          level: result.exitCode === 0 ? "success" : "error",
          message: result.exitCode === 0
            ? `Sandbox admin command completed for ${postRoute.workspaceKey}.`
            : `Sandbox admin command exited ${result.exitCode} for ${postRoute.workspaceKey}.`,
          sandboxAdmin: result,
        } satisfies ActionResponse);
        return;
      }

      if (method === "POST" && postRoute?.kind === "delete") {
        const body = await readJsonBody(req);
        const confirm = asOptionalString(body?.confirm);
        if (confirm !== postRoute.workspaceKey) {
          this.sendJson(res, 400, {
            ok: false,
            level: "error",
            message: `Refusing destructive delete: confirmation must exactly match ${postRoute.workspaceKey}.`,
          } satisfies ActionResponse);
          return;
        }

        const deleted = await this.deps.deleteWorkspace(postRoute.workspaceKey);
        const state = await this.deps.checkState();
        this.sendJson(res, 200, {
          ok: true,
          level: "success",
          message: `Deleted ${postRoute.workspaceKey} (${deleted.workspacePath}) destructively.`,
          state,
        } satisfies ActionResponse);
        return;
      }

      this.sendText(res, 404, "not found");
    } catch (err) {
      this.sendJson(res, err instanceof SyntaxError ? 400 : 500, {
        ok: false,
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      } satisfies ActionResponse);
    }
  }

  private isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers["authorization"];
    if (!header || !header.startsWith("Basic ")) {
      return false;
    }

    let decoded = "";
    try {
      decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    } catch {
      return false;
    }

    const separator = decoded.indexOf(":");
    if (separator === -1) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return safeEquals(username, this.adminConfig.username) && safeEquals(password, this.adminConfig.password);
  }

  private sendJson(res: http.ServerResponse, status: number, body: ActionResponse): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
  }

  private sendText(res: http.ServerResponse, status: number, body: string): void {
    res.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }
}

export async function buildWorkspaceUiState(
  config: Config,
  provisioner: UserProvisioner,
  router: SessionRouter,
  selectedWorkspaceKey?: string,
): Promise<WorkspaceUiState> {
  const rows = await summarizeWorkspaceControlState(provisioner);
  const records = provisioner.listWorkspaces();

  const workspaces = rows.map((row) => {
    const record = records[row.workspaceKey];
    const displayName = workspaceDisplayName(record, row.workspaceKey);
    const bindingPreview = describeBinding(record);
    const surfaces = [
      row.codeServerEnabled ? "code-server" : undefined,
      row.calendarEnabled ? "calendar" : undefined,
      row.sessionWatchEnabled ? "watch" : undefined,
    ].filter((value): value is string => Boolean(value));

    return {
      workspaceKey: row.workspaceKey,
      displayName,
      workspacePath: record.workspacePath,
      status: record.status,
      transport: row.transport,
      bindingPreview,
      surfaces,
      searchText: [
        displayName,
        row.workspaceKey,
        record.workspacePath,
        record.status,
        row.transport,
        bindingPreview,
      ].join(" ").toLowerCase(),
    } satisfies WorkspaceListItem;
  });

  const resolvedSelectedKey = selectedWorkspaceKey && records[selectedWorkspaceKey]
    ? selectedWorkspaceKey
    : workspaces[0]?.workspaceKey;

  return {
    workspaces,
    selectedWorkspaceKey: resolvedSelectedKey,
    selected: resolvedSelectedKey
      ? buildWorkspaceUiDetail(config, router, resolvedSelectedKey, records[resolvedSelectedKey])
      : undefined,
  };
}

function buildWorkspaceUiDetail(
  config: Config,
  router: SessionRouter,
  workspaceKey: string,
  record: WorkspaceRecord,
): WorkspaceUiDetail {
  const runner = router.getCachedRunner(workspaceKey);
  const piSelection = resolveWorkspacePiSelection({
    provider: config.piProvider,
    model: config.piModel,
    thinkingLevel: config.piThinkingLevel,
  }, record);

  const provider = runner?.modelProvider ?? piSelection.provider;
  const model = runner?.modelName ?? piSelection.model;
  const thinkingLevel = runner?.thinkingLevel ?? piSelection.thinkingLevel;
  const sessionSummary = runner
    ? `active · ${runner.messageCount} messages`
    : "inactive";

  const detail: WorkspaceUiDetail = {
    workspaceKey,
    displayName: workspaceDisplayName(record, workspaceKey),
    label: record.label,
    workspacePath: record.workspacePath,
    status: record.status,
    lastSeen: record.lastSeen,
    provisionedAt: record.provisionedAt,
    canEditWorkspacePath: !record.provisionedAt,
    canEditStatus: !record.provisionedAt,
    signal: record.transports.signal
      ? {
        kind: record.transports.signal.groupId ? "group" : "sender",
        value: record.transports.signal.groupId ?? record.transports.signal.sender ?? "",
        userWhitelist: record.transports.signal.userWhitelist ?? [],
      }
      : undefined,
    nextcloud: record.transports.nextcloud
      ? {
        roomToken: record.transports.nextcloud.roomToken,
        userWhitelist: record.transports.nextcloud.userWhitelist ?? [],
      }
      : undefined,
    model: {
      provider: record.piProvider ?? "",
      model: record.piModel ?? "",
      thinkingLevel: record.piThinkingLevel ?? "",
    },
    desiredState: {
      codeServerEnabled: record.codeServer?.enabled === true,
      calendarEnabled: record.calendar?.enabled === true,
      sessionWatchEnabled: record.sessionWatch?.enabled === true,
      bootEnabled: record.boot?.enabled !== false,
    },
    capabilities: {
      pdfApiEnabled: record.capabilities?.pdfApi?.enabled === true,
      spreadsheetRecalcEnabled: record.capabilities?.spreadsheetRecalc?.enabled === true,
      geminiSearchEnabled: record.capabilities?.geminiSearch?.enabled === true,
    },
    access: {
      sessionSummary,
      effectiveModelSummary: `${model} (${provider}) · thinking: ${thinkingLevel}`,
      lastSeen: record.lastSeen,
      codeServerUrl: record.codeServer?.enabled && record.codeServer.port
        ? codeServerStatusUrl(config.codeServer, workspaceKey, record.codeServer.port)
        : undefined,
      codeServerPassword: record.codeServer?.enabled ? record.codeServer.password : undefined,
      calendarUrl: record.calendar?.enabled && record.calendar.token
        ? (config.calendar.publicBaseUrl
          ? calendarPublicUrl(config.calendar.publicBaseUrl, workspaceKey, record.calendar.token)
          : undefined)
        : undefined,
      sessionWatchUrl: record.sessionWatch?.enabled && record.sessionWatch.token
        ? (config.sessionWatch?.enabled
          ? (config.sessionWatch.publicBaseUrl
            ? sessionWatchPublicUrl(config.sessionWatch.publicBaseUrl, workspaceKey, record.sessionWatch.token)
            : sessionWatchLocalUrl(config.sessionWatch.bindHost, config.sessionWatch.port, workspaceKey, record.sessionWatch.token))
          : undefined)
        : undefined,
    },
  };

  return detail;
}

function workspaceDisplayName(record: WorkspaceRecord, workspaceKey: string): string {
  return record.label ?? record.workspacePath ?? workspaceKey;
}

function describeBinding(record: WorkspaceRecord): string {
  const parts: string[] = [];
  if (record.transports.signal?.sender) {
    parts.push(record.transports.signal.sender);
  }
  if (record.transports.signal?.groupId) {
    parts.push(record.transports.signal.groupId);
  }
  if (record.transports.nextcloud?.roomToken) {
    parts.push(record.transports.nextcloud.roomToken);
  }
  return parts.join(" · ");
}

function parseWorkspaceRoute(pathname: string, method: "PUT" | "POST"):
  | { kind: "workspace"; workspaceKey: string }
  | { kind: "delete"; workspaceKey: string }
  | { kind: "sandbox-admin"; workspaceKey: string }
  | undefined {
  const prefix = `${ADMIN_API_PREFIX}/workspaces/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  if (!rest) return undefined;

  if (method === "PUT" && !rest.includes("/")) {
    return { kind: "workspace", workspaceKey: decodeURIComponent(rest) };
  }

  if (method === "POST" && rest.endsWith("/sandbox-admin")) {
    const workspaceKey = rest.slice(0, -"/sandbox-admin".length);
    if (!workspaceKey || workspaceKey.includes("/")) return undefined;
    return { kind: "sandbox-admin", workspaceKey: decodeURIComponent(workspaceKey) };
  }

  if (method === "POST" && rest.endsWith("/delete")) {
    const workspaceKey = rest.slice(0, -"/delete".length);
    if (!workspaceKey || workspaceKey.includes("/")) return undefined;
    return { kind: "delete", workspaceKey: decodeURIComponent(workspaceKey) };
  }

  return undefined;
}

function parseEditableWorkspaceInput(value: unknown): EditableWorkspaceRecordInput {
  const raw = isRecord(value) ? value : {};
  const signalRaw = isRecord(raw.signal) ? raw.signal : undefined;
  const nextcloudRaw = isRecord(raw.nextcloud) ? raw.nextcloud : undefined;
  const capabilitiesRaw = isRecord(raw.capabilities) ? raw.capabilities : undefined;

  return {
    label: asOptionalString(raw.label),
    status: raw.status === "active" || raw.status === "pending"
      ? raw.status
      : undefined,
    workspacePath: asOptionalString(raw.workspacePath),
    signal: signalRaw
      ? {
        sender: asOptionalString(signalRaw.sender),
        groupId: asOptionalString(signalRaw.groupId),
        userWhitelist: parseStringArray(signalRaw.userWhitelist),
      }
      : undefined,
    nextcloud: nextcloudRaw
      ? {
        roomToken: asOptionalString(nextcloudRaw.roomToken),
        userWhitelist: parseStringArray(nextcloudRaw.userWhitelist),
      }
      : undefined,
    piProvider: asOptionalString(raw.piProvider),
    piModel: asOptionalString(raw.piModel),
    piThinkingLevel: asOptionalString(raw.piThinkingLevel),
    codeServerEnabled: asOptionalBoolean(raw.codeServerEnabled),
    calendarEnabled: asOptionalBoolean(raw.calendarEnabled),
    sessionWatchEnabled: asOptionalBoolean(raw.sessionWatchEnabled),
    bootEnabled: asOptionalBoolean(raw.bootEnabled),
    capabilities: capabilitiesRaw
      ? {
        pdfApi: { enabled: isRecord(capabilitiesRaw.pdfApi) && capabilitiesRaw.pdfApi.enabled === true },
        spreadsheetRecalc: { enabled: isRecord(capabilitiesRaw.spreadsheetRecalc) && capabilitiesRaw.spreadsheetRecalc.enabled === true },
        geminiSearch: { enabled: isRecord(capabilitiesRaw.geminiSearch) && capabilitiesRaw.geminiSearch.enabled === true },
      }
      : undefined,
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => `${entry}`.trim())
    .filter(Boolean);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk);
      continue;
    }
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
      continue;
    }
    throw new Error("Unsupported request body chunk");
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, unknown>;
}

function renderAdminPage(): string {
  const stateRoute = JSON.stringify(`${ADMIN_API_PREFIX}/state`);
  const checkRoute = JSON.stringify(`${ADMIN_API_PREFIX}/check`);
  const reconcileRoute = JSON.stringify(`${ADMIN_API_PREFIX}/reconcile`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Workspace Control Plane</title>
  <style>
    :root {
      --accent: #8abeb7;
      --border: #5f87ff;
      --borderAccent: #00d7ff;
      --success: #b5bd68;
      --error: #cc6666;
      --warning: #f0c674;
      --muted: #808080;
      --dim: #666666;
      --text: #e5e5e7;
      --body-bg: #18181e;
      --container-bg: #1e1e24;
      --panel-bg: #23232b;
      --input-bg: #111217;
      --selected-bg: #2b3243;
      --line-height: 18px;
      --sidebar-width: 320px;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
      font-size: 12px;
      line-height: var(--line-height);
      color: var(--text);
      background: var(--body-bg);
    }

    button, input, select, textarea {
      font: inherit;
      color: var(--text);
      border-radius: 4px;
      border: 1px solid #363847;
      background: var(--input-bg);
    }

    button {
      cursor: pointer;
      padding: 8px 10px;
      background: #202636;
    }

    button:hover { border-color: var(--border); }
    button.primary { background: #203247; border-color: var(--border); }
    button.success { background: #223627; border-color: #3b6d3b; }
    button.danger { background: #3b2323; border-color: #7b3d3d; }
    button.ghost { background: transparent; }
    button.info-button {
      min-width: 28px;
      padding: 8px 0;
      font-weight: 700;
    }
    button:disabled { opacity: 0.55; cursor: not-allowed; }

    input, select, textarea {
      width: 100%;
      padding: 8px 10px;
      min-height: 34px;
    }

    textarea {
      min-height: 76px;
      resize: vertical;
    }

    .app {
      display: grid;
      grid-template-columns: var(--sidebar-width) 1fr;
      min-height: 100vh;
    }

    .app.sidebar-hidden {
      grid-template-columns: 1fr;
    }

    .app.sidebar-hidden .sidebar {
      display: none;
    }

    .sidebar {
      border-right: 1px solid #2e2f39;
      background: var(--container-bg);
      min-width: 0;
    }

    .main {
      min-width: 0;
      background: var(--body-bg);
    }

    .sidebar-inner,
    .main-inner {
      padding: 16px;
    }

    .card {
      background: var(--container-bg);
      border-radius: 6px;
      padding: 14px;
      margin-bottom: 14px;
      border: 1px solid transparent;
    }

    .card h1,
    .card h2,
    .card h3 {
      margin: 0 0 10px 0;
      font-size: 12px;
      color: var(--borderAccent);
    }

    .toolbar,
    .row,
    .field-grid,
    .workspace-meta,
    .surface-grid,
    .status-meta,
    .check-grid,
    .footer-actions,
    .binding-grid {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }

    .toolbar { justify-content: space-between; }
    .toolbar-left, .toolbar-right { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

    .field-grid,
    .surface-grid,
    .binding-grid,
    .check-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(240px, 1fr));
      gap: 12px;
    }

    .field label,
    .checkbox-card strong {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-weight: 600;
    }

    .field.readonly input,
    .field.readonly textarea {
      color: var(--muted);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid #45475a;
      color: var(--muted);
      white-space: nowrap;
    }

    .pill.ok { color: var(--success); border-color: var(--success); }
    .pill.warn { color: var(--warning); border-color: var(--warning); }
    .pill.error { color: var(--error); border-color: var(--error); }
    .pill.info { color: var(--borderAccent); border-color: var(--borderAccent); }

    .muted { color: var(--muted); }
    .dim { color: var(--dim); }

    .search {
      margin-bottom: 12px;
    }

    .workspace-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .workspace-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 10px;
      background: var(--panel-bg);
      border: 1px solid transparent;
      border-radius: 6px;
    }

    .workspace-item.active {
      background: var(--selected-bg);
      border-color: var(--border);
    }

    .workspace-item .top {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
    }

    .overview-note {
      color: var(--dim);
      margin-top: 6px;
    }

    .checkbox-card {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: center;
      padding: 10px;
      background: var(--panel-bg);
      border-radius: 6px;
      border: 1px solid #2e2f39;
    }

    .checkbox-card input {
      width: auto;
      min-height: auto;
      padding: 0;
    }

    .status-panel {
      border-color: #2e2f39;
      background: linear-gradient(to bottom, rgba(30,30,36,0.98), rgba(24,24,30,0.98));
    }

    .status-panel.success { border-color: #3b6d3b; }
    .status-panel.error { border-color: #7b3d3d; }
    .status-message {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .status-details {
      margin-top: 10px;
      padding: 10px;
      border-radius: 6px;
      background: var(--panel-bg);
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--muted);
    }

    .sticky-footer {
      position: sticky;
      bottom: 0;
      padding-top: 6px;
      background: linear-gradient(to top, rgba(24,24,30,0.98), rgba(24,24,30,0.88));
    }

    .empty {
      padding: 12px;
      border: 1px dashed #45475a;
      border-radius: 6px;
      color: var(--muted);
    }

    .hint {
      color: var(--warning);
      margin-top: 8px;
    }

    .output-block {
      margin-top: 10px;
      padding: 10px;
      border-radius: 6px;
      background: var(--panel-bg);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .output-meta {
      color: var(--muted);
      margin-top: 10px;
      margin-bottom: 8px;
    }

    @media (max-width: 980px) {
      .app,
      .app.sidebar-hidden {
        grid-template-columns: 1fr;
      }

      .sidebar {
        border-right: none;
        border-bottom: 1px solid #2e2f39;
      }

      .field-grid,
      .surface-grid,
      .binding-grid,
      .check-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="app" id="app">
    <aside class="sidebar">
      <div class="sidebar-inner">
        <div class="card">
          <h2>Workspaces</h2>
          <div class="search">
            <input id="search" type="search" placeholder="Search key, label, path, binding…">
          </div>
          <div id="workspace-list" class="workspace-list"></div>
        </div>
      </div>
    </aside>

    <main class="main">
      <div class="main-inner">
        <div class="card">
          <div class="toolbar">
            <div class="toolbar-left">
              <button id="toggle-sidebar" class="ghost" title="Hide or show the workspace list.">Hide workspace list</button>
              <span class="pill info">workspace.json is canonical</span>
            </div>
            <div class="toolbar-right muted">Small built-in operator surface</div>
          </div>
        </div>

        <div id="workspace-detail"></div>

        <div class="sticky-footer">
          <div class="card status-panel" id="status-panel">
            <div class="toolbar">
              <div class="toolbar-left">
                <strong>Status</strong>
                <span id="dirty-pill" class="pill">saved</span>
              </div>
              <div class="toolbar-right status-meta muted">
                <span>Use <strong>Save</strong> for registry truth.</span>
                <span>Use <strong>Reconcile + Reset Inactive Runners</strong> after model changes if needed.</span>
              </div>
            </div>
            <div id="status-message" class="status-message muted">Loading workspace control-plane state…</div>
            <div id="status-details" class="status-details" style="display:none"></div>
            <div class="footer-actions" style="margin-top: 12px; justify-content: space-between; align-items: flex-start;">
              <div class="toolbar-left">
                <button id="reset-form" title="Discard unsaved edits for the selected workspace and reload it from current workspace.json.">Reset form</button>
                <button id="save-workspace" class="primary" title="Write the selected workspace changes into workspace.json only.">Save to workspace.json</button>
                <button id="save-and-reconcile" class="success" title="Save the selected workspace and then apply current desired state through reconcile.">Save + Reconcile</button>
              </div>
              <div class="toolbar-left">
                <button id="check-state" title="Refresh the current control-plane summary without mutating runtime state.">Check</button>
                <button id="reconcile" title="Apply current workspace.json desired state across known workspaces.">Reconcile</button>
                <button id="reconcile-reset" title="Apply desired state, then reset affected inactive cached runners into fresh sessions when their runtime shape drifted. Active workspaces are skipped.">Reconcile + Reset Inactive Runners</button>
                <button id="reconcile-help" class="ghost info-button" title="Rule of thumb:&#10;- Reconcile for metadata and access-surface changes: labels, whitelists, code-server, calendar, session-watch, boot&#10;- Reconcile + Reset Inactive Runners for live runtime-shape changes: provider/model/thinking and capability or network changes like pdfApi, spreadsheetRecalc, or geminiSearch">i</button>
                <button id="delete-workspace" class="danger" title="Delete the selected workspace destructively after typed confirmation.">Delete workspace…</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <script>
    const stateRoute = ${stateRoute};
    const checkRoute = ${checkRoute};
    const reconcileRoute = ${reconcileRoute};
    const appEl = document.getElementById("app");
    const workspaceListEl = document.getElementById("workspace-list");
    const workspaceDetailEl = document.getElementById("workspace-detail");
    const statusPanelEl = document.getElementById("status-panel");
    const statusMessageEl = document.getElementById("status-message");
    const statusDetailsEl = document.getElementById("status-details");
    const dirtyPillEl = document.getElementById("dirty-pill");
    const searchEl = document.getElementById("search");
    const toggleSidebarEl = document.getElementById("toggle-sidebar");

    let uiState = null;
    let selectedWorkspaceKey = null;
    let sidebarHidden = false;
    let dirty = false;
    let lastSandboxAdminResult = null;
    let sandboxAdminDraft = '';

    function setStatus(message, level = "info", details = "") {
      statusPanelEl.classList.remove("success", "error");
      if (level === "success") statusPanelEl.classList.add("success");
      if (level === "error") statusPanelEl.classList.add("error");
      statusMessageEl.textContent = message;
      statusMessageEl.className = "status-message" + (level === "error" ? "" : " muted");
      if (details) {
        statusDetailsEl.style.display = "block";
        statusDetailsEl.textContent = details;
      } else {
        statusDetailsEl.style.display = "none";
        statusDetailsEl.textContent = "";
      }
    }

    function setDirty(nextDirty) {
      dirty = nextDirty;
      dirtyPillEl.textContent = dirty ? "unsaved changes" : "saved";
      dirtyPillEl.className = dirty ? "pill warn" : "pill ok";
    }

    function currentDetail() {
      return uiState && uiState.selectedWorkspaceKey && uiState.selected
        ? uiState.selected
        : null;
    }

    function currentSelectedKey() {
      return uiState && uiState.selectedWorkspaceKey ? uiState.selectedWorkspaceKey : undefined;
    }

    async function apiJson(url, options = {}) {
      const response = await fetch(url, {
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
        ...options,
      });
      const body = await response.json();
      if (!response.ok || body.ok === false) {
        throw new Error(body.message || "request failed");
      }
      return body;
    }

    async function loadState(workspaceKey, statusMessage) {
      const url = new URL(stateRoute, window.location.origin);
      if (workspaceKey) {
        url.searchParams.set("workspaceKey", workspaceKey);
      }
      const result = await apiJson(url.toString(), { method: "GET" });
      uiState = result.state;
      selectedWorkspaceKey = uiState && uiState.selectedWorkspaceKey ? uiState.selectedWorkspaceKey : null;
      lastSandboxAdminResult = null;
      sandboxAdminDraft = '';
      render();
      setDirty(false);
      setStatus(statusMessage || result.message, "info", result.details || "");
    }

    function parseWhitelist(text) {
      return text
        .split(/[,\\n]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    }

    function collectPayload() {
      const detail = currentDetail();
      if (!detail) {
        throw new Error("No workspace selected.");
      }

      const payload = {
        label: valueOf("label"),
        status: detail.canEditStatus ? valueOf("status") : detail.status,
        workspacePath: detail.canEditWorkspacePath ? valueOf("workspacePath") : detail.workspacePath,
        piProvider: valueOf("piProvider"),
        piModel: valueOf("piModel"),
        piThinkingLevel: valueOf("piThinkingLevel"),
        codeServerEnabled: checkedOf("codeServerEnabled"),
        calendarEnabled: checkedOf("calendarEnabled"),
        sessionWatchEnabled: checkedOf("sessionWatchEnabled"),
        bootEnabled: checkedOf("bootEnabled"),
        capabilities: {
          pdfApi: { enabled: checkedOf("capability-pdfApi") },
          spreadsheetRecalc: { enabled: checkedOf("capability-spreadsheetRecalc") },
          geminiSearch: { enabled: checkedOf("capability-geminiSearch") },
        },
      };

      if (detail.signal) {
        payload.signal = {
          sender: detail.signal.kind === "sender" ? valueOf("signalValue") : undefined,
          groupId: detail.signal.kind === "group" ? valueOf("signalValue") : undefined,
          userWhitelist: parseWhitelist(valueOf("signalWhitelist")),
        };
      }
      if (detail.nextcloud) {
        payload.nextcloud = {
          roomToken: valueOf("nextcloudRoomToken"),
          userWhitelist: parseWhitelist(valueOf("nextcloudWhitelist")),
        };
      }

      return payload;
    }

    function valueOf(id) {
      const el = document.getElementById(id);
      return el ? el.value : "";
    }

    function checkedOf(id) {
      const el = document.getElementById(id);
      return !!el && !!el.checked;
    }

    function render() {
      renderWorkspaceList();
      renderWorkspaceDetail();
      attachUiHandlers();
    }

    function renderWorkspaceList() {
      const items = (uiState && uiState.workspaces) || [];
      const query = (searchEl.value || "").trim().toLowerCase();
      const filtered = !query
        ? items
        : items.filter((item) => item.searchText.includes(query));

      if (filtered.length === 0) {
        workspaceListEl.innerHTML = '<div class="empty">No workspaces match this search.</div>';
        return;
      }

      workspaceListEl.innerHTML = filtered.map((item) => {
        const active = item.workspaceKey === currentSelectedKey();
        return '<button class="workspace-item' + (active ? ' active' : '') + '" data-workspace-key="' + escapeAttr(item.workspaceKey) + '">'
          + '<div class="top"><strong>' + escapeHtml(item.displayName) + '</strong><span class="pill ' + (item.status === 'active' ? 'ok' : 'warn') + '">' + escapeHtml(item.status) + '</span></div>'
          + '<div class="muted">' + escapeHtml(item.workspaceKey) + '</div>'
          + '<div class="dim">' + escapeHtml(item.workspacePath) + '</div>'
          + '<div class="overview-note">' + escapeHtml(item.transport) + (item.bindingPreview ? ' · ' + escapeHtml(item.bindingPreview) : '') + (item.surfaces.length ? ' · ' + escapeHtml(item.surfaces.join(' · ')) : '') + '</div>'
          + '</button>';
      }).join("");
    }

    function renderWorkspaceDetail() {
      const detail = currentDetail();
      if (!detail) {
        workspaceDetailEl.innerHTML = '<div class="card"><div class="empty">No workspaces are currently registered.</div></div>';
        return;
      }

      const signalSection = detail.signal
        ? '<div class="card"><h2>Signal binding</h2><div class="binding-grid">'
          + '<div class="field"><label>' + (detail.signal.kind === 'group' ? 'Group ID' : 'Sender') + '</label><input id="signalValue" value="' + escapeAttr(detail.signal.value) + '"></div>'
          + '<div class="field"><label>User whitelist</label><textarea id="signalWhitelist" placeholder="Comma or newline separated">' + escapeHtml(detail.signal.userWhitelist.join('\\n')) + '</textarea></div>'
          + '</div></div>'
        : '';

      const nextcloudSection = detail.nextcloud
        ? '<div class="card"><h2>Nextcloud binding</h2><div class="binding-grid">'
          + '<div class="field"><label>Room token</label><input id="nextcloudRoomToken" value="' + escapeAttr(detail.nextcloud.roomToken) + '"></div>'
          + '<div class="field"><label>User whitelist</label><textarea id="nextcloudWhitelist" placeholder="Comma or newline separated">' + escapeHtml(detail.nextcloud.userWhitelist.join('\\n')) + '</textarea></div>'
          + '</div></div>'
        : '';

      const sandboxAdminSection = renderSandboxAdminSection(detail);

      workspaceDetailEl.innerHTML = ''
        + '<div class="card">'
        + '  <div class="toolbar">'
        + '    <div>'
        + '      <h1>' + escapeHtml(detail.displayName) + '</h1>'
        + '      <div class="workspace-meta muted">' + escapeHtml(detail.workspaceKey) + ' · ' + escapeHtml(detail.status) + '</div>'
        + '    </div>'
        + '    <div class="toolbar-right">'
        + '      <span class="pill ' + (detail.provisionedAt ? 'ok' : 'warn') + '">' + (detail.provisionedAt ? 'provisioned' : 'not yet provisioned') + '</span>'
        + '    </div>'
        + '  </div>'
        + '</div>'

        + '<div class="card">'
        + '  <h2>Identity</h2>'
        + '  <div class="field-grid">'
        + '    <div class="field"><label>Label</label><input id="label" value="' + escapeAttr(detail.label || '') + '"></div>'
        + '    <div class="field readonly"><label>Workspace key</label><input value="' + escapeAttr(detail.workspaceKey) + '" readonly></div>'
        + '    <div class="field' + (detail.canEditWorkspacePath ? '' : ' readonly') + '"><label>Workspace path</label><input id="workspacePath" value="' + escapeAttr(detail.workspacePath) + '" ' + (detail.canEditWorkspacePath ? '' : 'readonly') + '></div>'
        + '    <div class="field' + (detail.canEditStatus ? '' : ' readonly') + '"><label>Status</label>'
        + '      <select id="status" ' + (detail.canEditStatus ? '' : 'disabled') + '>'
        + '        <option value="active" ' + (detail.status === 'active' ? 'selected' : '') + '>active</option>'
        + '        <option value="pending" ' + (detail.status === 'pending' ? 'selected' : '') + '>pending</option>'
        + '      </select>'
        + '    </div>'
        + '  </div>'
        + '  <div class="hint">Workspace path and status stay read-only after provisioning in v1.</div>'
        + '</div>'

        + signalSection
        + nextcloudSection

        + '<div class="card">'
        + '  <h2>Model</h2>'
        + '  <div class="field-grid">'
        + '    <div class="field"><label>Provider</label><input id="piProvider" value="' + escapeAttr(detail.model.provider) + '" placeholder="Use bridge default when blank"></div>'
        + '    <div class="field"><label>Model</label><input id="piModel" value="' + escapeAttr(detail.model.model) + '" placeholder="Use bridge default when blank"></div>'
        + '    <div class="field"><label>Thinking level</label><select id="piThinkingLevel">'
        + renderThinkingOptions(detail.model.thinkingLevel)
        + '    </select></div>'
        + '  </div>'
        + '</div>'

        + '<div class="card">'
        + '  <h2>Desired state</h2>'
        + '  <div class="check-grid">'
        + renderCheckboxCard('codeServerEnabled', 'Code server', detail.desiredState.codeServerEnabled)
        + renderCheckboxCard('calendarEnabled', 'Calendar', detail.desiredState.calendarEnabled)
        + renderCheckboxCard('sessionWatchEnabled', 'Session watch', detail.desiredState.sessionWatchEnabled)
        + renderCheckboxCard('bootEnabled', 'Boot preload', detail.desiredState.bootEnabled)
        + '  </div>'
        + '</div>'

        + '<div class="card">'
        + '  <h2>Capabilities</h2>'
        + '  <div class="check-grid">'
        + renderCheckboxCard('capability-pdfApi', 'pdfApi', detail.capabilities.pdfApiEnabled)
        + renderCheckboxCard('capability-spreadsheetRecalc', 'spreadsheetRecalc', detail.capabilities.spreadsheetRecalcEnabled)
        + renderCheckboxCard('capability-geminiSearch', 'geminiSearch', detail.capabilities.geminiSearchEnabled)
        + '  </div>'
        + '</div>'

        + '<div class="card">'
        + '  <h2>Current access surfaces</h2>'
        + '  <div class="surface-grid">'
        + renderReadonlyField('Effective model', detail.access.effectiveModelSummary)
        + renderReadonlyField('Session', detail.access.sessionSummary)
        + renderReadonlyField('Last seen', detail.access.lastSeen)
        + renderReadonlyField('Code server URL', detail.access.codeServerUrl || '(not available)')
        + renderReadonlyField('Code server password', detail.access.codeServerPassword || '(not available)')
        + renderReadonlyField('Calendar feed', detail.access.calendarUrl || '(not available)')
        + renderReadonlyField('Session watch', detail.access.sessionWatchUrl || '(not available)')
        + '  </div>'
        + '</div>'

        + sandboxAdminSection;
    }

    function renderSandboxAdminSection(detail) {
      const result = lastSandboxAdminResult && lastSandboxAdminResult.workspaceKey === detail.workspaceKey
        ? lastSandboxAdminResult
        : null;
      const output = result
        ? '<div class="output-meta">'
          + escapeHtml(result.timestamp) + ' · exit=' + escapeHtml(String(result.exitCode)) + ' · network=' + escapeHtml(result.network) + ' · user=' + escapeHtml(result.user) + ' · cwd=' + escapeHtml(result.cwd)
          + (result.disconnectFailed ? ' · disconnect failed' : '')
          + '</div>'
          + '<div class="output-block">' + escapeHtml(formatSandboxAdminOutput(result)) + '</div>'
        : '<div class="empty" style="margin-top: 10px;">No sandbox admin run in this page view yet.</div>';
      const placeholder = detail.provisionedAt
        ? 'apt-get update && apt-get install -y poppler-utils'
        : 'Workspace is not provisioned yet.';

      return ''
        + '<div class="card">'
        + '  <div class="toolbar">'
        + '    <div class="toolbar-left">'
        + '      <h2>Temporary sandbox admin</h2>'
        + '      <span class="pill warn">imperative</span>'
        + '      <span class="pill warn">not in workspace.json</span>'
        + '    </div>'
        + '    <div class="toolbar-right muted">operator-only · temporary network attach → exec → disconnect</div>'
        + '  </div>'
        + '  <div class="hint">Use this only for short-lived sandbox intervention on the selected workspace. Advanced options stay on the CLI path: <code>admin-workspace.js sandbox</code>. Package installs here are not durable desired state and may disappear when the sandbox is later recreated.</div>'
        + '  <div class="field" style="margin-top: 12px;">'
        + '    <label>Command</label>'
        + '    <textarea id="sandboxAdminCommand" placeholder="' + escapeAttr(placeholder) + '" ' + (detail.provisionedAt ? '' : 'disabled') + '>' + escapeHtml(sandboxAdminDraft) + '</textarea>'
        + '  </div>'
        + '  <div class="toolbar" style="margin-top: 12px;">'
        + '    <div class="toolbar-left">'
        + '      <button id="run-sandbox-admin" class="danger" ' + (detail.provisionedAt ? '' : 'disabled') + '>Run sandbox command</button>'
        + '    </div>'
        + '    <div class="toolbar-right muted">last output is ephemeral to this page view · history is still appended server-side</div>'
        + '  </div>'
        + '  <div style="margin-top: 12px;">'
        + '    <strong>Last run output</strong>'
        + output
        + '  </div>'
        + '</div>';
    }

    function formatSandboxAdminOutput(result) {
      const parts = [];
      if (result.stdout) {
        parts.push('$ stdout\n' + result.stdout.trimEnd());
      }
      if (result.stderr) {
        parts.push('$ stderr\n' + result.stderr.trimEnd());
      }
      if (parts.length === 0) {
        parts.push('(no stdout/stderr)');
      }
      return parts.join('\n\n');
    }

    function renderThinkingOptions(current) {
      const options = [
        { value: '', label: '(default)' },
        { value: 'off', label: 'off' },
        { value: 'minimal', label: 'minimal' },
        { value: 'low', label: 'low' },
        { value: 'medium', label: 'medium' },
        { value: 'high', label: 'high' },
        { value: 'xhigh', label: 'xhigh' },
      ];
      return options.map((option) =>
        '<option value="' + escapeAttr(option.value) + '" ' + (current === option.value ? 'selected' : '') + '>' + escapeHtml(option.label) + '</option>'
      ).join('');
    }

    function renderCheckboxCard(id, label, checked) {
      return '<label class="checkbox-card"><div><strong>' + escapeHtml(label) + '</strong></div><input type="checkbox" id="' + escapeAttr(id) + '" ' + (checked ? 'checked' : '') + '></label>';
    }

    function renderReadonlyField(label, value) {
      return '<div class="field readonly"><label>' + escapeHtml(label) + '</label><input value="' + escapeAttr(value) + '" readonly></div>';
    }

    function attachUiHandlers() {
      document.querySelectorAll('[data-workspace-key]').forEach((button) => {
        button.addEventListener('click', async () => {
          const nextKey = button.getAttribute('data-workspace-key');
          if (!nextKey) return;
          selectedWorkspaceKey = nextKey;
          await loadState(selectedWorkspaceKey, 'Loaded selected workspace.');
        });
      });

      ['label', 'workspacePath', 'status', 'signalValue', 'signalWhitelist', 'nextcloudRoomToken', 'nextcloudWhitelist', 'piProvider', 'piModel', 'piThinkingLevel', 'codeServerEnabled', 'calendarEnabled', 'sessionWatchEnabled', 'bootEnabled', 'capability-pdfApi', 'capability-spreadsheetRecalc', 'capability-geminiSearch']
        .forEach((id) => {
          const el = document.getElementById(id);
          if (!el) return;
          el.addEventListener('input', () => setDirty(true));
          el.addEventListener('change', () => setDirty(true));
        });

      const sandboxAdminButton = document.getElementById('run-sandbox-admin');
      if (sandboxAdminButton) {
        sandboxAdminButton.addEventListener('click', async () => {
          try {
            const key = currentSelectedKey();
            if (!key) throw new Error('No workspace selected.');
            const command = valueOf('sandboxAdminCommand').trim();
            if (!command) throw new Error('Sandbox admin command must not be empty.');
            sandboxAdminDraft = command;
            sandboxAdminButton.disabled = true;
            const result = await apiJson('/admin/api/workspaces/' + encodeURIComponent(key) + '/sandbox-admin', {
              method: 'POST',
              body: JSON.stringify({ command }),
            });
            lastSandboxAdminResult = result.sandboxAdmin || null;
            render();
            setStatus(result.message, result.level, result.details || '');
          } catch (err) {
            setStatus(err instanceof Error ? err.message : String(err), 'error');
          } finally {
            sandboxAdminButton.disabled = false;
          }
        });
      }
    }

    searchEl.addEventListener('input', () => renderWorkspaceList());

    toggleSidebarEl.addEventListener('click', () => {
      sidebarHidden = !sidebarHidden;
      appEl.classList.toggle('sidebar-hidden', sidebarHidden);
      toggleSidebarEl.textContent = sidebarHidden ? 'Show workspace list' : 'Hide workspace list';
    });

    document.getElementById('reset-form').addEventListener('click', async () => {
      const key = currentSelectedKey();
      await loadState(key, 'Discarded unsaved edits and reloaded the selected workspace.');
    });

    document.getElementById('save-workspace').addEventListener('click', async () => {
      try {
        const key = currentSelectedKey();
        if (!key) throw new Error('No workspace selected.');
        const result = await apiJson('/admin/api/workspaces/' + encodeURIComponent(key), {
          method: 'PUT',
          body: JSON.stringify(collectPayload()),
        });
        uiState = result.state;
        render();
        setDirty(false);
        setStatus(result.message, result.level, result.details || '');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
    });

    document.getElementById('save-and-reconcile').addEventListener('click', async () => {
      try {
        const key = currentSelectedKey();
        if (!key) throw new Error('No workspace selected.');
        await apiJson('/admin/api/workspaces/' + encodeURIComponent(key), {
          method: 'PUT',
          body: JSON.stringify(collectPayload()),
        });
        const result = await apiJson(reconcileRoute, {
          method: 'POST',
          body: JSON.stringify({ workspaceKey: key, resetRunners: false }),
        });
        uiState = result.state;
        render();
        setDirty(false);
        setStatus(result.message, result.level, result.details || '');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
    });

    document.getElementById('check-state').addEventListener('click', async () => {
      try {
        const result = await apiJson(checkRoute, {
          method: 'POST',
          body: JSON.stringify({ workspaceKey: currentSelectedKey() }),
        });
        uiState = result.state;
        render();
        setStatus(result.message, result.level, result.details || '');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
    });

    document.getElementById('reconcile').addEventListener('click', async () => {
      try {
        const result = await apiJson(reconcileRoute, {
          method: 'POST',
          body: JSON.stringify({ workspaceKey: currentSelectedKey(), resetRunners: false }),
        });
        uiState = result.state;
        render();
        setDirty(false);
        setStatus(result.message, result.level, result.details || '');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
    });

    document.getElementById('reconcile-reset').addEventListener('click', async () => {
      try {
        const result = await apiJson(reconcileRoute, {
          method: 'POST',
          body: JSON.stringify({ workspaceKey: currentSelectedKey(), resetRunners: true }),
        });
        uiState = result.state;
        render();
        setDirty(false);
        setStatus(result.message, result.level, result.details || '');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
    });

    document.getElementById('delete-workspace').addEventListener('click', async () => {
      try {
        const key = currentSelectedKey();
        if (!key) throw new Error('No workspace selected.');
        const confirm = window.prompt('Type the workspace key to confirm destructive delete:', '');
        if (confirm === null) {
          setStatus('Delete cancelled.', 'info');
          return;
        }
        const result = await apiJson('/admin/api/workspaces/' + encodeURIComponent(key) + '/delete', {
          method: 'POST',
          body: JSON.stringify({ confirm }),
        });
        uiState = result.state;
        render();
        setDirty(false);
        setStatus(result.message, result.level, result.details || '');
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err), 'error');
      }
    });

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function escapeAttr(value) {
      return escapeHtml(value == null ? '' : String(value));
    }

    loadState().catch((err) => {
      setStatus(err instanceof Error ? err.message : String(err), 'error');
    });
  </script>
</body>
</html>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
