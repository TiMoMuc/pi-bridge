import * as fs from "node:fs/promises";
import { loadConfig, type Config } from "./config.js";
import { CodeServerManager } from "./code-server.js";
import { DurableIngressQueue } from "./inbox-queue.js";
import { DurableOutboundQueue } from "./outbox-queue.js";
import { UserProvisioner } from "./provisioner.js";
import { SandboxManager, sandboxConfigFromEnv } from "./sandbox.js";
import {
  formatWorkspaceControlSummary,
  summarizeWorkspaceControlState,
} from "./workspace-control.js";
import { WorkspaceCapabilityManager } from "./workspace-capabilities.js";

interface AdminDeps {
  config?: Config;
  provisioner?: UserProvisioner;
  sandboxManager?: SandboxManager;
  codeServerManager?: CodeServerManager;
  capabilityManager?: WorkspaceCapabilityManager;
  inbox?: DurableIngressQueue;
  outbox?: DurableOutboundQueue;
  signalProcess?: typeof process.kill;
  rm?: typeof fs.rm;
}

const USAGE = [
  "Usage:",
  "  admin-workspace.js reconcile [--check] [--reset-runners]",
  "  admin-workspace.js delete <workspaceKey> --confirm <workspaceKey>",
].join("\n");

export async function runAdminWorkspace(argv: string[], deps: AdminDeps = {}): Promise<void> {
  const [command, ...args] = argv;

  if (command === "reconcile") {
    await runReconcileCommand(args, deps);
    return;
  }

  if (command === "delete") {
    await runDeleteCommand(args, deps);
    return;
  }

  throw new Error(USAGE);
}

async function runReconcileCommand(flags: string[], deps: AdminDeps): Promise<void> {
  const checkOnly = flags.includes("--check");
  const resetRunners = flags.includes("--reset-runners");
  const invalid = flags.filter((flag) => !["--check", "--reset-runners"].includes(flag));
  if (invalid.length > 0) {
    throw new Error(`Unknown flags: ${invalid.join(", ")}\n${USAGE}`);
  }

  const config = deps.config ?? loadConfig();
  const provisioner = deps.provisioner ?? createProvisioner(config);
  await provisioner.initialize();

  if (checkOnly) {
    const summary = await summarizeWorkspaceControlState(provisioner);
    console.log(formatWorkspaceControlSummary(summary));
    return;
  }

  const signalName: NodeJS.Signals = resetRunners ? "SIGUSR1" : "SIGHUP";
  const sendSignal = deps.signalProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  sendSignal(1, signalName);
  console.log(`[admin-workspace] Requested ${resetRunners ? "reconcile + reset-runners" : "reconcile"} via ${signalName}`);
}

async function runDeleteCommand(args: string[], deps: AdminDeps): Promise<void> {
  const workspaceKey = parseDeleteArgs(args);
  const config = deps.config ?? loadConfig();
  const provisioner = deps.provisioner ?? createProvisioner(config);
  await provisioner.initialize();

  const record = provisioner.getWorkspace(workspaceKey);
  if (!record) {
    throw new Error(`Unknown workspace: ${workspaceKey}`);
  }

  const paths = provisioner.getWorkspacePaths(workspaceKey);
  if (!paths) {
    throw new Error(`Workspace ${workspaceKey} has no resolved workspace path`);
  }

  const sandboxManager = deps.sandboxManager ?? new SandboxManager(sandboxConfigFromEnv(config));
  const codeServerManager = deps.codeServerManager ?? new CodeServerManager(config.codeServer, config.projectsDir, config.bridgeDataDir, {
    bridgeProjectsDir: config.projectsDir,
    bridgeDataHostDir: config.bridgeDataDir,
    runtimeIdentity: config.runtimeIdentity,
  });
  const capabilityManager = deps.capabilityManager ?? new WorkspaceCapabilityManager();
  const inbox = deps.inbox ?? new DurableIngressQueue(config.bridgeDataDir);
  const outbox = deps.outbox ?? new DurableOutboundQueue(config.bridgeDataDir, {
    resolveTransport: () => undefined,
  });
  const removeDir = deps.rm ?? fs.rm;

  await sandboxManager.remove(workspaceKey);
  await codeServerManager.destroy(workspaceKey);
  await capabilityManager.applyWorkspaceCapabilities(workspaceKey);
  await inbox.deleteWorkspace(workspaceKey);
  await outbox.deleteWorkspace(workspaceKey);
  await removeDir(paths.root, { recursive: true, force: true });
  await provisioner.deleteWorkspace(workspaceKey);

  const sendSignal = deps.signalProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  sendSignal(1, "SIGHUP");
  console.log(
    `[admin-workspace] Deleted ${workspaceKey} (${record.workspacePath}) destructively — registry removed, sibling runtime state torn down, durable queues cleared, workspace root deleted, bridge reload requested via SIGHUP`,
  );
}

function parseDeleteArgs(args: string[]): string {
  const [workspaceKey, ...flags] = args;
  if (!workspaceKey || workspaceKey.startsWith("--")) {
    throw new Error(USAGE);
  }

  let confirm: string | undefined;
  const invalid: string[] = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--confirm") {
      const value = flags[i + 1];
      if (!value) {
        throw new Error(`Missing value for --confirm\n${USAGE}`);
      }
      confirm = value;
      i += 1;
      continue;
    }
    invalid.push(flag);
  }

  if (invalid.length > 0) {
    throw new Error(`Unknown flags: ${invalid.join(", ")}\n${USAGE}`);
  }
  if (confirm !== workspaceKey) {
    throw new Error(`Refusing destructive delete: --confirm must exactly match ${workspaceKey}`);
  }
  return workspaceKey;
}

function createProvisioner(config: Config): UserProvisioner {
  return new UserProvisioner(config.bridgeDataDir, config.projectsDir, config.blueprintDir, {
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdminWorkspace(process.argv.slice(2)).catch((err) => {
    console.error("[admin-workspace] Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
