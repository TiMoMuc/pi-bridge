import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Config } from "./config.js";
import { CodeServerManager } from "./code-server.js";
import { UserEventsManager } from "./events-manager.js";
import type { UserProvisioner, WorkspaceRecord } from "./provisioner.js";
import { SessionRouter } from "./session-router.js";
import { legacyWorkspacePath, WORKSPACE_BRIDGE_DIRNAME } from "./workspace-paths.js";
import {
  resolveSandboxNetworkName,
  type WorkspaceCapabilityName,
  WorkspaceCapabilityManager,
} from "./workspace-capabilities.js";
import type { SandboxManager } from "./sandbox.js";

export interface WorkspaceControlSummaryRow {
  workspaceKey: string;
  transport: string;
  codeServerEnabled: boolean;
  codeServerReady: boolean;
  calendarEnabled: boolean;
  calendarReady: boolean;
  sessionWatchEnabled: boolean;
  sessionWatchReady: boolean;
  model: string;
}

export interface WorkspaceControlReconcileResult {
  shapeUpdated: string[];
  codeServerStarted: string[];
  codeServerStopped: string[];
  calendarPrepared: string[];
  calendarRemoved: string[];
  sessionWatchPrepared: string[];
  sessionWatchRemoved: string[];
  capabilityAttached: string[];
  capabilityDetached: string[];
  capabilityMissing: string[];
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
  sessionWatchPrepared: boolean;
  sessionWatchRemoved: boolean;
  capabilitiesAttached: WorkspaceCapabilityName[];
  capabilitiesDetached: WorkspaceCapabilityName[];
  capabilitiesMissing: WorkspaceCapabilityName[];
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
      sessionWatchEnabled: record.sessionWatch?.enabled === true,
      sessionWatchReady: !!record.sessionWatch?.token,
      model: `${record.piProvider ?? "(default)"}/${record.piModel ?? "(default)"} @ ${record.piThinkingLevel ?? "(default)"}`,
    }));
}

export async function applyWorkspaceDesiredState(params: {
  workspaceKey: string;
  record: WorkspaceRecord;
  provisioner: UserProvisioner;
  codeServerManager: CodeServerManager;
  capabilityManager: WorkspaceCapabilityManager;
}): Promise<WorkspaceDesiredStateApplyResult> {
  const { workspaceKey, record, provisioner, codeServerManager, capabilityManager } = params;
  const result: WorkspaceDesiredStateApplyResult = {
    codeServerStarted: false,
    codeServerStopped: false,
    calendarPrepared: false,
    calendarRemoved: false,
    sessionWatchPrepared: false,
    sessionWatchRemoved: false,
    capabilitiesAttached: [],
    capabilitiesDetached: [],
    capabilitiesMissing: [],
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

  if (record.sessionWatch?.enabled) {
    const sessionWatch = await provisioner.ensureSessionWatchAccess(workspaceKey);
    if (sessionWatch?.token) {
      result.sessionWatchPrepared = true;
    }
  } else {
    result.sessionWatchRemoved = true;
  }

  const workspaceRoot = provisioner.getWorkspaceRoot(workspaceKey);
  const workspaceBridgeDir = workspaceRoot ? path.join(workspaceRoot, WORKSPACE_BRIDGE_DIRNAME) : undefined;
  const capabilityResult = await capabilityManager.applyWorkspaceCapabilities(workspaceKey, record.capabilities, workspaceBridgeDir);
  result.capabilitiesAttached = capabilityResult.attached;
  result.capabilitiesDetached = capabilityResult.detached;
  result.capabilitiesMissing = capabilityResult.missing;

  return result;
}

export async function reconcileWorkspaceControlPlane(params: {
  config: Config;
  provisioner: UserProvisioner;
  eventsManager: UserEventsManager;
  codeServerManager: CodeServerManager;
  capabilityManager: WorkspaceCapabilityManager;
  sandboxManager: SandboxManager;
  router: SessionRouter;
  resetRunners: boolean;
}): Promise<WorkspaceControlReconcileResult> {
  const { provisioner, eventsManager, codeServerManager, capabilityManager, sandboxManager, router, resetRunners, config } = params;

  await provisioner.reload();
  const shapeUpdated = await provisioner.reconcileDesiredStateShape();
  await provisioner.reload();

  const codeServerStarted: string[] = [];
  const codeServerStopped: string[] = [];
  const calendarPrepared: string[] = [];
  const calendarRemoved: string[] = [];
  const sessionWatchPrepared: string[] = [];
  const sessionWatchRemoved: string[] = [];
  const capabilityAttached: string[] = [];
  const capabilityDetached: string[] = [];
  const capabilityMissing: string[] = [];
  const missingDirs: string[] = [];
  const runnersReset: string[] = [];
  const runnersSkippedActive = new Set<string>();

  const workspaces = Object.entries(provisioner.listWorkspaces()).sort(([a], [b]) => a.localeCompare(b));
  await retireDeletedWorkspaceRuntimeState({
    knownWorkspaceKeys: workspaces.map(([workspaceKey]) => workspaceKey),
    eventsManager,
    router,
  });

  for (const [workspaceKey, record] of workspaces) {
    if (record.status === "pending") {
      await codeServerManager.stop(workspaceKey);
      await capabilityManager.applyWorkspaceCapabilities(workspaceKey);
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
          capabilityManager,
        });
        if (applied.codeServerStarted) codeServerStarted.push(workspaceKey);
        if (applied.codeServerStopped) codeServerStopped.push(workspaceKey);
        if (applied.calendarPrepared) calendarPrepared.push(workspaceKey);
        if (applied.calendarRemoved) calendarRemoved.push(workspaceKey);
        if (applied.sessionWatchPrepared) sessionWatchPrepared.push(workspaceKey);
        if (applied.sessionWatchRemoved) sessionWatchRemoved.push(workspaceKey);
        capabilityAttached.push(...formatCapabilityChanges(workspaceKey, applied.capabilitiesAttached));
        capabilityDetached.push(...formatCapabilityChanges(workspaceKey, applied.capabilitiesDetached));
        capabilityMissing.push(...formatCapabilityChanges(workspaceKey, applied.capabilitiesMissing));
        await maybeResetRunnerForCapabilitySurface({
          workspaceKey,
          record: provisioned,
          config,
          sandboxManager,
          router,
          resetRunners,
          runnersReset,
          runnersSkippedActive,
        });
        continue;
      }

      missingDirs.push(workspaceKey);
      await codeServerManager.stop(workspaceKey);
      await capabilityManager.applyWorkspaceCapabilities(workspaceKey);
      continue;
    }

    eventsManager.startForUser(workspaceKey);

    const applied = await applyWorkspaceDesiredState({
      workspaceKey,
      record,
      provisioner,
      codeServerManager,
      capabilityManager,
    });

    if (applied.codeServerStarted) codeServerStarted.push(workspaceKey);
    if (applied.codeServerStopped) codeServerStopped.push(workspaceKey);
    if (applied.calendarPrepared) calendarPrepared.push(workspaceKey);
    if (applied.calendarRemoved) calendarRemoved.push(workspaceKey);
    if (applied.sessionWatchPrepared) sessionWatchPrepared.push(workspaceKey);
    if (applied.sessionWatchRemoved) sessionWatchRemoved.push(workspaceKey);
    capabilityAttached.push(...formatCapabilityChanges(workspaceKey, applied.capabilitiesAttached));
    capabilityDetached.push(...formatCapabilityChanges(workspaceKey, applied.capabilitiesDetached));
    capabilityMissing.push(...formatCapabilityChanges(workspaceKey, applied.capabilitiesMissing));
    await maybeResetRunnerForCapabilitySurface({
      workspaceKey,
      record,
      config,
      sandboxManager,
      router,
      resetRunners,
      runnersReset,
      runnersSkippedActive,
    });
  }

  const runtime = await router.reconcileWorkspacePiSelections(resetRunners);
  for (const workspaceKey of runtime.reset) {
    if (!runnersReset.includes(workspaceKey)) {
      runnersReset.push(workspaceKey);
    }
  }
  for (const workspaceKey of runtime.skippedActive) {
    runnersSkippedActive.add(workspaceKey);
  }

  return {
    shapeUpdated,
    codeServerStarted,
    codeServerStopped,
    calendarPrepared,
    calendarRemoved,
    sessionWatchPrepared,
    sessionWatchRemoved,
    capabilityAttached,
    capabilityDetached,
    capabilityMissing,
    piSelectionChanged: runtime.changed,
    runnersReset,
    runnersSkippedActive: [...runnersSkippedActive].sort(),
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
    `  session-watch: ${row.sessionWatchEnabled ? `enabled${row.sessionWatchReady ? "" : " (needs token)"}` : "disabled"}`,
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
    `sessionWatchPrepared=${joinOrNone(result.sessionWatchPrepared)}`,
    `sessionWatchRemoved=${joinOrNone(result.sessionWatchRemoved)}`,
    `capabilityAttached=${joinOrNone(result.capabilityAttached)}`,
    `capabilityDetached=${joinOrNone(result.capabilityDetached)}`,
    `capabilityMissing=${joinOrNone(result.capabilityMissing)}`,
    `piSelectionChanged=${joinOrNone(result.piSelectionChanged)}`,
    `runnersReset=${joinOrNone(result.runnersReset)}`,
    `runnersSkippedActive=${joinOrNone(result.runnersSkippedActive)}`,
    `missingDirs=${joinOrNone(result.missingDirs)}`,
  ];
  return lines.join("\n");
}

function formatCapabilityChanges(workspaceKey: string, capabilities: WorkspaceCapabilityName[]): string[] {
  return capabilities.map((capability) => `${workspaceKey}:${capability}`);
}

async function maybeResetRunnerForCapabilitySurface(params: {
  workspaceKey: string;
  record: WorkspaceRecord;
  config: Config;
  sandboxManager: SandboxManager;
  router: SessionRouter;
  resetRunners: boolean;
  runnersReset: string[];
  runnersSkippedActive: Set<string>;
}): Promise<void> {
  const { workspaceKey, record, config, sandboxManager, router, resetRunners, runnersReset, runnersSkippedActive } = params;
  if (!resetRunners) return;
  if (!router.getCachedRunner(workspaceKey)) return;

  const expectedNetwork = resolveSandboxNetworkName(config.sandboxNetwork, workspaceKey, record.capabilities);
  const usesExpectedNetwork = await sandboxManager.containerUsesExpectedNetwork(workspaceKey, expectedNetwork);
  if (usesExpectedNetwork) {
    return;
  }

  if (router.isActive(workspaceKey)) {
    runnersSkippedActive.add(workspaceKey);
    return;
  }

  await router.reset(workspaceKey);
  runnersReset.push(workspaceKey);
}

function joinOrNone(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

async function retireDeletedWorkspaceRuntimeState(params: {
  knownWorkspaceKeys: string[];
  eventsManager: UserEventsManager;
  router: SessionRouter;
}): Promise<void> {
  const known = new Set(params.knownWorkspaceKeys);
  for (const workspaceKey of params.eventsManager.knownSenders()) {
    if (!known.has(workspaceKey)) {
      await params.eventsManager.stopForUser(workspaceKey);
    }
  }
  params.router.retireDeletedWorkspaces(params.knownWorkspaceKeys);
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
