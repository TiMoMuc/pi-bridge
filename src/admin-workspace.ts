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
import { deleteWorkspaceDestructively } from "./workspace-admin.js";
import { migrateLegacySandboxAdminHistory, runSandboxAdminCommand, type SandboxAdminRunResult } from "./sandbox-admin.js";

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
  runSandboxAdmin?: (options: Parameters<typeof runSandboxAdminCommand>[0]) => Promise<SandboxAdminRunResult>;
}

const USAGE = [
  "Usage:",
  "  admin-workspace.js reconcile [--check] [--reset-runners]",
  "  admin-workspace.js delete <workspaceKey> --confirm <workspaceKey>",
  "  admin-workspace.js sandbox <workspaceKey> --cmd '<shell command>' [--user <uid[:gid]>] [--cwd <path>] [--network <name>] [--log <path>] [--bridge-container <name>]",
].join("\n");

export async function runAdminWorkspace(argv: string[], deps: AdminDeps = {}): Promise<number> {
  const [command, ...args] = argv;

  if (command === "reconcile") {
    await runReconcileCommand(args, deps);
    return 0;
  }

  if (command === "delete") {
    await runDeleteCommand(args, deps);
    return 0;
  }

  if (command === "sandbox") {
    return runSandboxCommand(args, deps);
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

  const record = await deleteWorkspaceDestructively({
    workspaceKey,
    provisioner,
    sandboxManager,
    codeServerManager,
    capabilityManager,
    inbox,
    outbox,
    rm: deps.rm ?? fs.rm,
  });

  const sendSignal = deps.signalProcess ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  sendSignal(1, "SIGHUP");
  console.log(
    `[admin-workspace] Deleted ${workspaceKey} (${record.workspacePath}) destructively — registry removed, sibling runtime state torn down, durable queues cleared, workspace root deleted, bridge reload requested via SIGHUP`,
  );
}

async function runSandboxCommand(args: string[], deps: AdminDeps): Promise<number> {
  const parsed = parseSandboxArgs(args);
  const config = deps.config ?? loadConfig();
  const provisioner = deps.provisioner ?? createProvisioner(config);
  await provisioner.initialize();

  const record = provisioner.getWorkspace(parsed.workspaceKey);
  if (!record) {
    throw new Error(`Unknown workspace: ${parsed.workspaceKey}`);
  }
  if (!record.provisionedAt) {
    throw new Error(`Workspace ${parsed.workspaceKey} is not provisioned yet; no sandbox exists to administer.`);
  }

  await migrateLegacySandboxAdminHistory(config.bridgeDataDir);

  const runSandboxAdmin = deps.runSandboxAdmin ?? ((options) => runSandboxAdminCommand(options));
  const result = await runSandboxAdmin({
    workspaceKey: parsed.workspaceKey,
    command: parsed.command,
    bridgeDataDir: config.bridgeDataDir,
    bridgeContainer: parsed.bridgeContainer,
    network: parsed.network,
    user: parsed.user,
    cwd: parsed.cwd,
    logPath: parsed.logPath,
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  console.log(
    `[admin-workspace] Sandbox command for ${parsed.workspaceKey} finished with exit=${result.exitCode} network=${result.network} log=${result.historyPath}`,
  );
  return result.exitCode;
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

function parseSandboxArgs(args: string[]): {
  workspaceKey: string;
  command: string;
  bridgeContainer?: string;
  network?: string;
  user?: string;
  cwd?: string;
  logPath?: string;
} {
  const [workspaceKey, ...flags] = args;
  if (!workspaceKey || workspaceKey.startsWith("--")) {
    throw new Error(USAGE);
  }

  let command: string | undefined;
  let bridgeContainer: string | undefined;
  let network: string | undefined;
  let user: string | undefined;
  let cwd: string | undefined;
  let logPath: string | undefined;
  const invalid: string[] = [];

  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (["--cmd", "--bridge-container", "--network", "--user", "--cwd", "--log"].includes(flag)) {
      if (!value) {
        throw new Error(`Missing value for ${flag}\n${USAGE}`);
      }
    }

    if (flag === "--cmd") {
      command = value;
      i += 1;
      continue;
    }
    if (flag === "--bridge-container") {
      bridgeContainer = value;
      i += 1;
      continue;
    }
    if (flag === "--network") {
      network = value;
      i += 1;
      continue;
    }
    if (flag === "--user") {
      user = value;
      i += 1;
      continue;
    }
    if (flag === "--cwd") {
      cwd = value;
      i += 1;
      continue;
    }
    if (flag === "--log") {
      logPath = value;
      i += 1;
      continue;
    }
    invalid.push(flag);
  }

  if (invalid.length > 0) {
    throw new Error(`Unknown flags: ${invalid.join(", ")}\n${USAGE}`);
  }
  if (!command?.trim()) {
    throw new Error(`Missing value for --cmd\n${USAGE}`);
  }

  return {
    workspaceKey,
    command,
    bridgeContainer,
    network,
    user,
    cwd,
    logPath,
  };
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
  runAdminWorkspace(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error("[admin-workspace] Fatal:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
