import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceRecord } from "./provisioner.js";
import { workspacePaths, type WorkspacePaths } from "./workspace-paths.js";

const POINTER_FILENAME = ".git";
const POINTER_CONTENT = "gitdir: .bridge/git\n";
const EXCLUDE_FILE_HEADER = "# bridge-owned operational excludes\n";
const EXCLUDE_PATTERNS = ["/.bridge/git/"];
const BRIDGE_GIT_USER_NAME = "pi-bridge";
const BRIDGE_GIT_USER_EMAIL = "bridge@localhost";
const INITIAL_COMMIT_MESSAGE = "bridge: initialize workspace history";
const PUSH_TO_CHECKOUT_HOOK_NAME = "push-to-checkout";
const PUSH_TO_CHECKOUT_HOOK_CONTENT = `#!/bin/sh
gitdir=$(git rev-parse --absolute-git-dir)
worktree=$(cd "$gitdir/../.." && pwd)
GIT_DIR="$gitdir" GIT_WORK_TREE="$worktree" git read-tree -u -m HEAD "$1"
`;

export type WorkspaceGitRunSource = "inbound" | "scheduled";

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {
  cwd?: string;
  allowCodes?: number[];
}

interface WorkspaceGitManagerDeps {
  run?: (args: string[], options?: RunOptions) => Promise<ExecResult>;
}

export class WorkspaceGitManager {
  private readonly runCommand: (args: string[], options?: RunOptions) => Promise<ExecResult>;

  constructor(
    private readonly projectsDir: string,
    deps: WorkspaceGitManagerDeps = {},
  ) {
    this.runCommand = deps.run ?? runGitCommand;
  }

  async validate(): Promise<void> {
    await this.runCommand(["--version"]);
  }

  async ensureProvisionedWorkspaces(workspaces: Record<string, WorkspaceRecord>): Promise<void> {
    for (const record of Object.values(workspaces)) {
      if (record.status !== "active" || !record.provisionedAt) continue;
      await this.ensureWorkspaceRepoByPath(record.workspacePath);
    }
  }

  async ensureWorkspaceRepoByPath(workspacePath: string): Promise<void> {
    await this.ensureWorkspaceRepo(workspacePaths(this.projectsDir, workspacePath));
  }

  async ensureWorkspaceRepo(paths: WorkspacePaths): Promise<void> {
    const rootStat = await statIfExists(paths.root);
    if (!rootStat?.isDirectory()) {
      throw new Error(`Workspace root is missing or not a directory: ${paths.root}`);
    }

    await fs.mkdir(paths.bridgeDir, { recursive: true });

    await this.migrateLegacyRootGitDir(paths);

    const repoExists = await pathExists(path.join(paths.gitDir, "HEAD"));
    if (!repoExists) {
      await this.initializeRepo(paths);
    }

    await this.ensureGitPointer(paths);
    await this.configureRepo(paths);
    await this.ensurePushToCheckoutHook(paths);
    await this.ensureExcludeFile(paths);
    await this.ensureInitialCommit(paths);
  }

  async commitCompletedRun(workspacePath: string, source: WorkspaceGitRunSource): Promise<boolean> {
    const paths = workspacePaths(this.projectsDir, workspacePath);
    await this.ensureWorkspaceRepo(paths);

    await this.runInWorkspace(paths, ["add", "-A"]);
    const diff = await this.runInWorkspace(paths, ["diff", "--cached", "--quiet"], { allowCodes: [0, 1] });
    if (diff.code === 0) {
      return false;
    }

    const timestamp = new Date().toISOString();
    await this.runInWorkspace(paths, ["commit", "-m", `bridge: save ${source} run ${timestamp}`]);
    return true;
  }

  private async migrateLegacyRootGitDir(paths: WorkspacePaths): Promise<void> {
    const pointerPath = path.join(paths.root, POINTER_FILENAME);
    const pointerStat = await statIfExists(pointerPath);
    if (!pointerStat || !pointerStat.isDirectory()) {
      return;
    }

    const gitDirExists = await pathExists(paths.gitDir);
    if (gitDirExists) {
      throw new Error(
        `Workspace ${paths.root} has both a legacy root .git directory and ${paths.gitDir}; resolve manually before continuing.`,
      );
    }

    await fs.mkdir(paths.bridgeDir, { recursive: true });
    await fs.rename(pointerPath, paths.gitDir);
  }

  private async initializeRepo(paths: WorkspacePaths): Promise<void> {
    const pointerPath = path.join(paths.root, POINTER_FILENAME);
    const pointerStat = await statIfExists(pointerPath);
    if (pointerStat && !pointerStat.isDirectory()) {
      await fs.rm(pointerPath, { force: true });
    }

    await this.runCommand(
      ["init", "--initial-branch=main", "--separate-git-dir=.bridge/git"],
      { cwd: paths.root },
    );
  }

  private async ensureGitPointer(paths: WorkspacePaths): Promise<void> {
    const pointerPath = path.join(paths.root, POINTER_FILENAME);
    const pointerStat = await statIfExists(pointerPath);
    if (pointerStat?.isDirectory()) {
      throw new Error(`Expected ${pointerPath} to be a pointer file, but it is a directory.`);
    }

    const current = pointerStat ? await fs.readFile(pointerPath, "utf8") : undefined;
    if (current !== POINTER_CONTENT) {
      await fs.writeFile(pointerPath, POINTER_CONTENT, "utf8");
    }
  }

  private async configureRepo(paths: WorkspacePaths): Promise<void> {
    await this.runGitDir(paths, ["config", "core.worktree", "../.."]);
    await this.runGitDir(paths, ["config", "receive.denyCurrentBranch", "updateInstead"]);
    await this.runGitDir(paths, ["config", "user.name", BRIDGE_GIT_USER_NAME]);
    await this.runGitDir(paths, ["config", "user.email", BRIDGE_GIT_USER_EMAIL]);
  }

  private async ensurePushToCheckoutHook(paths: WorkspacePaths): Promise<void> {
    const hookPath = path.join(paths.gitDir, "hooks", PUSH_TO_CHECKOUT_HOOK_NAME);
    await fs.mkdir(path.dirname(hookPath), { recursive: true });

    const current = await fs.readFile(hookPath, "utf8").catch(() => "");
    if (current !== PUSH_TO_CHECKOUT_HOOK_CONTENT) {
      await fs.writeFile(hookPath, PUSH_TO_CHECKOUT_HOOK_CONTENT, "utf8");
    }
    await fs.chmod(hookPath, 0o755);
  }

  private async ensureExcludeFile(paths: WorkspacePaths): Promise<void> {
    const excludePath = path.join(paths.gitDir, "info", "exclude");
    await fs.mkdir(path.dirname(excludePath), { recursive: true });

    const existing = await fs.readFile(excludePath, "utf8").catch(() => "");
    const lines = existing.split(/\r?\n/).filter(Boolean);
    let changed = false;

    if (!lines.includes(EXCLUDE_FILE_HEADER.trim())) {
      lines.unshift(EXCLUDE_FILE_HEADER.trim());
      changed = true;
    }

    for (const pattern of EXCLUDE_PATTERNS) {
      if (!lines.includes(pattern)) {
        lines.push(pattern);
        changed = true;
      }
    }

    if (changed || !existing) {
      await fs.writeFile(excludePath, `${lines.join("\n")}\n`, "utf8");
    }
  }

  private async ensureInitialCommit(paths: WorkspacePaths): Promise<void> {
    const head = await this.runInWorkspace(paths, ["rev-parse", "--verify", "HEAD"], { allowCodes: [0, 128] });
    if (head.code === 0) {
      return;
    }

    await this.runInWorkspace(paths, ["add", "-A"]);
    await this.runInWorkspace(paths, ["commit", "--allow-empty", "-m", INITIAL_COMMIT_MESSAGE]);
  }

  private async runInWorkspace(paths: WorkspacePaths, args: string[], options: RunOptions = {}): Promise<ExecResult> {
    return this.runCommand(args, { ...options, cwd: paths.root });
  }

  private async runGitDir(paths: WorkspacePaths, args: string[], options: RunOptions = {}): Promise<ExecResult> {
    return this.runCommand([`--git-dir=${paths.gitDir}`, ...args], options);
  }
}

async function statIfExists(target: string) {
  try {
    return await fs.stat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

async function pathExists(target: string): Promise<boolean> {
  return !!(await statIfExists(target));
}

async function runGitCommand(args: string[], options: RunOptions = {}): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      const result: ExecResult = {
        stdout,
        stderr,
        code: code ?? 0,
      };
      const allowCodes = options.allowCodes ?? [0];
      if (!allowCodes.includes(result.code)) {
        reject(new Error(`git ${args.join(" ")} failed (${result.code}): ${(stderr || stdout).trim()}`));
        return;
      }
      resolve(result);
    });
    child.on("error", reject);
  });
}
