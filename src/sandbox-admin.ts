import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { getLogger } from "./logger.js";
import { sandboxContainerName } from "./sibling-containers.js";
import { legacySandboxAdminHistoryPath, sandboxAdminHistoryPath } from "./workspace-paths.js";

export interface SandboxAdminRunOptions {
  workspaceKey: string;
  command: string;
  bridgeDataDir: string;
  bridgeContainer?: string;
  network?: string;
  user?: string;
  cwd?: string;
  logPath?: string;
}

export interface SandboxAdminRunResult {
  version: 1;
  timestamp: string;
  workspaceKey: string;
  sandboxContainer: string;
  bridgeContainer: string;
  network: string;
  cwd: string;
  user: string;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  attachedHere: boolean;
  disconnectFailed: boolean;
  replay: string[];
  historyPath: string;
}

export interface SandboxAdminHistoryRecord {
  version: 1;
  timestamp: string;
  workspaceKey: string;
  sandboxContainer: string;
  bridgeContainer?: string;
  network: string;
  cwd: string;
  user: string;
  command?: string;
  exitCode?: number;
  attachedHere: boolean;
  disconnectFailed: boolean;
  replay: string[];
  migratedFrom?: "sandbox-admin-history.shlog";
  migrationError?: string;
  rawBlock?: string;
}

export interface SandboxAdminMigrationResult {
  migratedCount: number;
  legacyPath: string;
  historyPath: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface SandboxAdminDeps {
  execSimple?: (cmd: string, args: string[]) => Promise<string>;
  execCommand?: (cmd: string, args: string[]) => Promise<ExecResult>;
  appendFile?: typeof fs.appendFile;
  mkdir?: typeof fs.mkdir;
  readFile?: typeof fs.readFile;
  rm?: typeof fs.rm;
  access?: typeof fs.access;
  now?: () => Date;
}

export async function runSandboxAdminCommand(
  options: SandboxAdminRunOptions,
  deps: SandboxAdminDeps = {},
): Promise<SandboxAdminRunResult> {
  const execSimpleFn = deps.execSimple ?? execSimple;
  const execCommandFn = deps.execCommand ?? execCommand;
  const appendFileFn = deps.appendFile ?? fs.appendFile;
  const mkdirFn = deps.mkdir ?? fs.mkdir;
  const now = deps.now ?? (() => new Date());

  const workspaceKey = normalizeRequired(options.workspaceKey, "workspaceKey");
  const command = normalizeRequired(options.command, "command");
  const bridgeContainer = normalizeOptional(options.bridgeContainer)
    ?? process.env["BRIDGE_CONTAINER_NAME"]
    ?? "pi-bridge";
  const sandboxContainer = sandboxContainerName(workspaceKey);
  const user = normalizeOptional(options.user) ?? "0";
  const cwd = normalizeOptional(options.cwd) ?? "/workspace";
  const historyPath = normalizeOptional(options.logPath) ?? sandboxAdminHistoryPath(options.bridgeDataDir);
  const timestamp = now().toISOString();

  await ensureContainerExists(execSimpleFn, bridgeContainer, `Bridge container not found: ${bridgeContainer}`);
  await ensureContainerExists(execSimpleFn, sandboxContainer, [
    `Sandbox container not found: ${sandboxContainer}`,
    "Hint: trigger the workspace once after the bridge is up so the sandbox gets created.",
  ].join("\n"));

  const sandboxRunning = await inspectContainerRunning(execSimpleFn, sandboxContainer);
  if (!sandboxRunning) {
    throw new Error([
      `Sandbox container is not running: ${sandboxContainer}`,
      "Hint: let the bridge recreate or restart it by triggering that workspace.",
    ].join("\n"));
  }

  const network = normalizeOptional(options.network) ?? await resolveBridgeNetwork(execSimpleFn, bridgeContainer);
  if (!network) {
    throw new Error(`Could not resolve a usable network from bridge container: ${bridgeContainer}`);
  }

  const alreadyAttached = await containerHasNetwork(execSimpleFn, sandboxContainer, network);
  let attachedHere = false;
  let disconnectFailed = false;

  if (!alreadyAttached) {
    await execSimpleFn("docker", ["network", "connect", network, sandboxContainer]);
    attachedHere = true;
  }

  getLogger().info(
    "sandbox-admin",
    "run-start",
    `Running temporary sandbox admin command for ${workspaceKey}`,
    { workspaceKey, sandboxContainer, network, cwd, user },
  );

  let execResult: ExecResult;
  let commandFailure: Error | undefined;
  try {
    execResult = await execCommandFn("docker", dockerExecArgs({ sandboxContainer, user, cwd, command }));
  } catch (err) {
    commandFailure = err instanceof Error ? err : new Error(String(err));
    execResult = { stdout: "", stderr: "", code: 1 };
  }

  if (attachedHere) {
    try {
      await execSimpleFn("docker", ["network", "disconnect", network, sandboxContainer]);
    } catch {
      disconnectFailed = true;
    }
  }

  if (commandFailure) {
    getLogger().error(
      "sandbox-admin",
      "run-failed",
      `Sandbox admin command failed before completion for ${workspaceKey}`,
      { workspaceKey, sandboxContainer, network, disconnectFailed, error: commandFailure },
    );
    throw new Error(
      disconnectFailed
        ? `${commandFailure.message}\nAdditionally failed to disconnect ${sandboxContainer} from ${network}; inspect container network attachments manually.`
        : commandFailure.message,
    );
  }

  const exitCode = disconnectFailed && execResult.code === 0 ? 1 : execResult.code;
  const replay = buildReplayLines({
    network,
    sandboxContainer,
    user,
    cwd,
    command,
    attachedHere,
    disconnectFailed,
  });

  await mkdirFn(dirname(historyPath), { recursive: true });
  await appendHistoryRecord(historyPath, {
    version: 1,
    timestamp,
    workspaceKey,
    sandboxContainer,
    bridgeContainer,
    network,
    cwd,
    user,
    command,
    exitCode,
    attachedHere,
    disconnectFailed,
    replay,
  }, appendFileFn);

  getLogger().info(
    "sandbox-admin",
    exitCode === 0 ? "run-complete" : "run-nonzero-exit",
    `Temporary sandbox admin command finished for ${workspaceKey}`,
    { workspaceKey, sandboxContainer, network, exitCode, attachedHere, disconnectFailed },
  );

  return {
    version: 1,
    timestamp,
    workspaceKey,
    sandboxContainer,
    bridgeContainer,
    network,
    cwd,
    user,
    command,
    exitCode,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    attachedHere,
    disconnectFailed,
    replay,
    historyPath,
  };
}

export async function migrateLegacySandboxAdminHistory(
  bridgeDataDir: string,
  deps: SandboxAdminDeps = {},
): Promise<SandboxAdminMigrationResult> {
  const legacyPath = legacySandboxAdminHistoryPath(bridgeDataDir);
  const historyPath = sandboxAdminHistoryPath(bridgeDataDir);
  const accessFn = deps.access ?? fs.access;
  const readFileFn = deps.readFile ?? fs.readFile;
  const appendFileFn = deps.appendFile ?? fs.appendFile;
  const mkdirFn = deps.mkdir ?? fs.mkdir;
  const rmFn = deps.rm ?? fs.rm;

  try {
    await accessFn(legacyPath);
  } catch {
    return { migratedCount: 0, legacyPath, historyPath };
  }

  const raw = await readFileFn(legacyPath, "utf8");
  const blocks = raw
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    await rmFn(legacyPath, { force: true });
    return { migratedCount: 0, legacyPath, historyPath };
  }

  const records = blocks.map(parseLegacyHistoryBlock);

  await mkdirFn(dirname(historyPath), { recursive: true });
  if (records.length > 0) {
    const payload = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    await appendFileFn(historyPath, payload, "utf8");
  }
  await rmFn(legacyPath, { force: true });

  if (records.length > 0) {
    const unparsedCount = records.filter((record) => record.migrationError).length;
    getLogger().info(
      "sandbox-admin",
      "history-migrated",
      `Migrated ${records.length} legacy sandbox admin history entr${records.length === 1 ? "y" : "ies"}`,
      { migratedCount: records.length, unparsedCount, historyPath },
    );
    if (unparsedCount > 0) {
      getLogger().warn(
        "sandbox-admin",
        "history-migration-partial-parse",
        `Preserved ${unparsedCount} legacy sandbox admin history entr${unparsedCount === 1 ? "y" : "ies"} as raw migrated records because parsing was incomplete`,
        { unparsedCount, historyPath },
      );
    }
  }

  return { migratedCount: records.length, legacyPath, historyPath };
}

export function dockerExecArgs(params: {
  sandboxContainer: string;
  user: string;
  cwd: string;
  command: string;
}): string[] {
  return [
    "exec",
    "-u",
    params.user,
    "-w",
    params.cwd,
    params.sandboxContainer,
    "sh",
    "-lc",
    params.command,
  ];
}

async function ensureContainerExists(
  execSimpleFn: (cmd: string, args: string[]) => Promise<string>,
  containerName: string,
  errorMessage: string,
): Promise<void> {
  try {
    await execSimpleFn("docker", ["inspect", containerName]);
  } catch {
    throw new Error(errorMessage);
  }
}

async function inspectContainerRunning(
  execSimpleFn: (cmd: string, args: string[]) => Promise<string>,
  containerName: string,
): Promise<boolean> {
  const result = await execSimpleFn("docker", ["inspect", "-f", "{{.State.Running}}", containerName]);
  return result.trim() === "true";
}

async function resolveBridgeNetwork(
  execSimpleFn: (cmd: string, args: string[]) => Promise<string>,
  bridgeContainer: string,
): Promise<string | undefined> {
  const result = await execSimpleFn("docker", [
    "inspect",
    "-f",
    '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}',
    bridgeContainer,
  ]);

  return result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "host" && line !== "none")[0];
}

async function containerHasNetwork(
  execSimpleFn: (cmd: string, args: string[]) => Promise<string>,
  containerName: string,
  targetNetwork: string,
): Promise<boolean> {
  const result = await execSimpleFn("docker", [
    "inspect",
    "-f",
    '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}',
    containerName,
  ]).catch(() => "");

  return result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .includes(targetNetwork);
}

function buildReplayLines(params: {
  network: string;
  sandboxContainer: string;
  user: string;
  cwd: string;
  command: string;
  attachedHere: boolean;
  disconnectFailed: boolean;
}): string[] {
  const lines: string[] = [];
  if (params.attachedHere) {
    lines.push(shellCommand(["docker", "network", "connect", params.network, params.sandboxContainer]));
  } else {
    lines.push(`# network already attached: ${params.network}`);
  }
  lines.push(shellCommand([
    "docker",
    "exec",
    "-u",
    params.user,
    "-w",
    params.cwd,
    params.sandboxContainer,
    "sh",
    "-lc",
    params.command,
  ]));
  if (params.attachedHere) {
    lines.push(shellCommand(["docker", "network", "disconnect", params.network, params.sandboxContainer]));
    if (params.disconnectFailed) {
      lines.push("# warning: disconnect failed; inspect container network attachments manually");
    }
  }
  return lines;
}

async function appendHistoryRecord(
  historyPath: string,
  record: SandboxAdminHistoryRecord,
  appendFileFn: typeof fs.appendFile,
): Promise<void> {
  await appendFileFn(historyPath, JSON.stringify(record) + "\n", "utf8");
}

function parseLegacyHistoryBlock(block: string): SandboxAdminHistoryRecord {
  const lines = block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const header = lines[0]?.match(/^#\s+(\S+)\s+ws=(\S+)\s+container=(\S+)\s+network=(\S+)\s+cwd=(\S+)\s+user=(\S+)\s+exit=(\d+)$/);
  const replay = lines.slice(1);
  const execLine = replay.find((line) => line.startsWith("docker exec "));
  const attachedHere = replay.some((line) => line.startsWith("docker network connect "));
  const disconnectFailed = replay.some((line) => line.includes("disconnect failed"));

  if (!header) {
    return {
      version: 1,
      timestamp: extractLegacyTimestamp(lines[0]),
      workspaceKey: "unknown",
      sandboxContainer: "unknown",
      network: "unknown",
      cwd: "unknown",
      user: "unknown",
      attachedHere,
      disconnectFailed,
      replay: lines,
      migratedFrom: "sandbox-admin-history.shlog",
      migrationError: "legacy header did not match the expected sandbox-admin-history.shlog format",
      rawBlock: block,
    };
  }

  const [, timestamp, workspaceKey, sandboxContainer, network, cwd, user, exitCodeText] = header;
  return {
    version: 1,
    timestamp,
    workspaceKey,
    sandboxContainer,
    network,
    cwd,
    user,
    command: extractLegacyCommand(execLine),
    exitCode: Number(exitCodeText),
    attachedHere,
    disconnectFailed,
    replay,
    migratedFrom: "sandbox-admin-history.shlog",
  };
}

function extractLegacyTimestamp(headerLine: string | undefined): string {
  const match = headerLine?.match(/^#\s+(\S+)/);
  return match?.[1] ?? new Date(0).toISOString();
}

function extractLegacyCommand(line: string | undefined): string | undefined {
  if (!line) return undefined;
  const marker = " sh -lc ";
  const index = line.indexOf(marker);
  if (index === -1) return undefined;
  return tryShellUnquote(line.slice(index + marker.length).trim());
}

function tryShellUnquote(value: string): string {
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/'\\''/g, "'");
  }
  return value;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeRequired(value: string | undefined, label: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function dirname(filePath: string): string {
  const index = filePath.lastIndexOf("/");
  return index === -1 ? "." : filePath.slice(0, index) || "/";
}

function shellCommand(parts: string[]): string {
  return parts.map(shellArg).join(" ");
}

function shellArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function execSimple(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `${cmd} exited with code ${code}`));
    });
  });
}

function execCommand(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
}
