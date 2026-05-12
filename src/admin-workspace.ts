import { loadConfig, type Config } from "./config.js";
import { UserProvisioner } from "./provisioner.js";
import {
  formatWorkspaceControlSummary,
  summarizeWorkspaceControlState,
} from "./workspace-control.js";

interface AdminDeps {
  config?: Config;
  provisioner?: UserProvisioner;
  signalProcess?: typeof process.kill;
}

export async function runAdminWorkspace(argv: string[], deps: AdminDeps = {}): Promise<void> {
  const [command, ...flags] = argv;
  if (command !== "reconcile") {
    throw new Error("Usage: admin-workspace.js reconcile [--check] [--reset-runners]");
  }

  const checkOnly = flags.includes("--check");
  const resetRunners = flags.includes("--reset-runners");
  const invalid = flags.filter((flag) => !["--check", "--reset-runners"].includes(flag));
  if (invalid.length > 0) {
    throw new Error(`Unknown flags: ${invalid.join(", ")}`);
  }

  const config = deps.config ?? loadConfig();
  const provisioner = deps.provisioner ?? new UserProvisioner(config.bridgeDataDir, config.projectsDir, config.blueprintDir, {
    codeServer: config.codeServer,
    calendar: config.calendar,
    workspaceDefaults: config.workspaceDefaults,
    modelDefaults: {
      provider: config.piProvider,
      model: config.piModel,
      thinkingLevel: config.piThinkingLevel,
    },
  });
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

if (import.meta.url === `file://${process.argv[1]}`) {
  runAdminWorkspace(process.argv.slice(2)).catch((err) => {
    console.error("[admin-workspace] Fatal:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
