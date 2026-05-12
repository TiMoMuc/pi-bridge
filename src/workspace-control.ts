import * as fs from "node:fs/promises";
import type { Config } from "./config.js";
import { CodeServerManager } from "./code-server.js";
import { UserEventsManager } from "./events-manager.js";
import type { UserProvisioner, WorkspaceRecord } from "./provisioner.js";
import { SessionRouter } from "./session-router.js";
import { legacyWorkspacePath } from "./workspace-paths.js";

export interface WorkspaceControlSummaryRow {
  workspaceKey: string;
  transport: string;
  codeServerEnabled: boolean;
  codeServerReady: boolean;
  calendarEnabled: boolean;
  calendarReady: boolean;
  model: string;
}

export interface WorkspaceControlReconcileResult {
  shapeUpdated: string[];
  codeServerStarted: string[];
  codeServerStopped: string[];
  calendarPrepared: string[];
  calendarRemoved: string[];
  piSelectionChanged: string[];
  runnersReset: string[];
  runnersSkippedActive: string[];
  missingDirs: string[];
}

export interface WorkspaceDesiredStateApplyResult {
  codeServerStarted: boolean;
  codeServerStopped: boolean;
  calendarPrepared: boolean;
  calendarRemoved: boolean;
}

export async function summarizeWorkspaceControlState(
  provisioner: UserProvisioner,
): Promise<WorkspaceControlSummaryRow[]> {
  await provisioner.initialize();
  return Object.entries(provisioner.listWorkspaces())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workspaceKey, record]) => ({
      workspaceKey,
      transport: record.primaryTransport,
      codeServerEnabled: record.codeServer?.enabled === true,
      codeServerReady: !!record.codeServer?.password && !!record.codeServer?.port,
      calendarEnabled: record.calendar?.enabled === true,
      calendarReady: !!record.calendar?.token,
      model: `${record.piProvider ?? "(default)"}/${record.piModel ?? "(default)"} @ ${record.piThinkingLevel ?? "(default)"}`,
    }));
}

export async function applyWorkspaceDesiredState(params: {
  workspaceKey: string;
  record: WorkspaceRecord;
  provisioner: UserProvisioner;
  codeServerManager: CodeServerManager;
}): Promise<WorkspaceDesiredStateApplyResult> {
  const { workspaceKey, record, provisioner, codeServerManager } = params;
  const result: WorkspaceDesiredStateApplyResult = {
    codeServerStarted: false,
    codeServerStopped: false,
    calendarPrepared: false,
    calendarRemoved: false,
  };

  if (record.codeServer?.enabled) {
    const access = await provisioner.ensureCodeServerAccess(workspaceKey);
    if (access?.password && access.port) {
      await codeServerManager.ensureRunning(workspaceKey, record.workspacePath ?? legacyWorkspacePath(workspaceKey), {
        password: access.password,
        port: access.port,
      }, record.primaryTransport);
      result.codeServerStarted = true;
    }
  } else {
    await codeServerManager.stop(workspaceKey);
    result.codeServerStopped = true;
  }

  if (record.calendar?.enabled) {
    const calendar = await provisioner.ensureCalendarAccess(workspaceKey);
    if (calendar?.token) {
      result.calendarPrepared = true;
    }
  } else {
    result.calendarRemoved = true;
  }

  return result;
}

export async function reconcileWorkspaceControlPlane(params: {
  config: Config;
  provisioner: UserProvisioner;
  eventsManager: UserEventsManager;
  codeServerManager: CodeServerManager;
  router: SessionRouter;
  resetRunners: boolean;
}): Promise<WorkspaceControlReconcileResult> {
  const { provisioner, eventsManager, codeServerManager, router, resetRunners } = params;

  await provisioner.reload();
  const shapeUpdated = await provisioner.reconcileDesiredStateShape();
  await provisioner.reload();

  const codeServerStarted: string[] = [];
  const codeServerStopped: string[] = [];
  const calendarPrepared: string[] = [];
  const calendarRemoved: string[] = [];
  const missingDirs: string[] = [];

  const workspaces = Object.entries(provisioner.listWorkspaces()).sort(([a], [b]) => a.localeCompare(b));

  for (const [workspaceKey, record] of workspaces) {
    if (record.status === "pending") {
      await codeServerManager.stop(workspaceKey);
      continue;
    }

    const workspaceRoot = provisioner.getWorkspaceRoot(workspaceKey);
    const exists = workspaceRoot ? await directoryExists(workspaceRoot) : false;
    if (!exists) {
      if (!record.provisionedAt) {
        const provisioned = await provisioner.provisionPendingWorkspace(workspaceKey);
        eventsManager.startForUser(workspaceKey);
        const applied = await applyWorkspaceDesiredState({
          workspaceKey,
          record: provisioned,
          provisioner,
          codeServerManager,
        });
        if (applied.codeServerStarted) codeServerStarted.push(workspaceKey);
        if (applied.codeServerStopped) codeServerStopped.push(workspaceKey);
        if (applied.calendarPrepared) calendarPrepared.push(workspaceKey);
        if (applied.calendarRemoved) calendarRemoved.push(workspaceKey);
        continue;
      }

      missingDirs.push(workspaceKey);
      await codeServerManager.stop(workspaceKey);
      continue;
    }

    eventsManager.startForUser(workspaceKey);

    const applied = await applyWorkspaceDesiredState({
      workspaceKey,
      record,
      provisioner,
      codeServerManager,
    });

    if (applied.codeServerStarted) codeServerStarted.push(workspaceKey);
    if (applied.codeServerStopped) codeServerStopped.push(workspaceKey);
    if (applied.calendarPrepared) calendarPrepared.push(workspaceKey);
    if (applied.calendarRemoved) calendarRemoved.push(workspaceKey);
  }

  const runtime = await router.reconcileWorkspacePiSelections(resetRunners);
  return {
    shapeUpdated,
    codeServerStarted,
    codeServerStopped,
    calendarPrepared,
    calendarRemoved,
    piSelectionChanged: runtime.changed,
    runnersReset: runtime.reset,
    runnersSkippedActive: runtime.skippedActive,
    missingDirs,
  };
}

export function formatWorkspaceControlSummary(rows: WorkspaceControlSummaryRow[]): string {
  if (rows.length === 0) {
    return "No workspaces in workspace.json.";
  }

  return rows.map((row) => [
    `${row.workspaceKey} (${row.transport})`,
    `  code-server: ${row.codeServerEnabled ? `enabled${row.codeServerReady ? "" : " (needs credentials)"}` : "disabled"}`,
    `  calendar: ${row.calendarEnabled ? `enabled${row.calendarReady ? "" : " (needs token)"}` : "disabled"}`,
    `  model: ${row.model}`,
  ].join("\n")).join("\n\n");
}

export function formatWorkspaceControlReconcileResult(result: WorkspaceControlReconcileResult): string {
  const lines = [
    `shapeUpdated=${joinOrNone(result.shapeUpdated)}`,
    `codeServerStarted=${joinOrNone(result.codeServerStarted)}`,
    `codeServerStopped=${joinOrNone(result.codeServerStopped)}`,
    `calendarPrepared=${joinOrNone(result.calendarPrepared)}`,
    `calendarRemoved=${joinOrNone(result.calendarRemoved)}`,
    `piSelectionChanged=${joinOrNone(result.piSelectionChanged)}`,
    `runnersReset=${joinOrNone(result.runnersReset)}`,
    `runnersSkippedActive=${joinOrNone(result.runnersSkippedActive)}`,
    `missingDirs=${joinOrNone(result.missingDirs)}`,
  ];
  return lines.join("\n");
}

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
