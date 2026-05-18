import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { workspacePaths } from "../src/workspace-paths.js";
import { WorkspaceGitManager } from "../src/workspace-git.js";

const EXPECTED_PUSH_TO_CHECKOUT_HOOK = `#!/bin/sh
gitdir=$(git rev-parse --absolute-git-dir)
worktree=$(cd "$gitdir/../.." && pwd)
GIT_DIR="$gitdir" GIT_WORK_TREE="$worktree" git read-tree -u -m HEAD "$1"
`;

describe("WorkspaceGitManager", () => {
  let tmpDir: string;
  let projectsDir: string;
  let manager: WorkspaceGitManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-git-test-"));
    projectsDir = path.join(tmpDir, "projects");
    await fs.mkdir(projectsDir, { recursive: true });
    manager = new WorkspaceGitManager(projectsDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("initializes a bridge-owned repo with a root pointer file, hook, and initial snapshot", async () => {
    const paths = workspacePaths(projectsDir, "users/ws_demo");
    await fs.mkdir(paths.coworkDir, { recursive: true });
    await fs.mkdir(paths.sessionsDir, { recursive: true });
    await fs.writeFile(path.join(paths.coworkDir, "note.txt"), "hello\n");
    await fs.writeFile(path.join(paths.sessionsDir, "run.jsonl"), '{"type":"message"}\n');

    await manager.ensureWorkspaceRepo(paths);

    expect(await fs.readFile(path.join(paths.root, ".git"), "utf8")).toBe("gitdir: .bridge/git\n");
    await expect(fs.stat(path.join(paths.gitDir, "HEAD"))).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(paths.gitDir, "info", "exclude"), "utf8")).resolves.toContain("/.bridge/git/");
    await expect(fs.readFile(path.join(paths.gitDir, "hooks", "push-to-checkout"), "utf8")).resolves.toBe(EXPECTED_PUSH_TO_CHECKOUT_HOOK);

    expect(git(paths.root, ["config", "--get", "receive.denyCurrentBranch"])).toBe("updateInstead");
    expect(git(paths.root, ["config", "--get", "core.worktree"])).toBe("../..");
    expect(git(paths.root, ["rev-list", "--count", "HEAD"])).toBe("1");

    const tracked = git(paths.root, ["ls-files"]).split(/\r?\n/).filter(Boolean);
    expect(tracked).toContain("cowork/note.txt");
    expect(tracked).toContain(".bridge/sessions/run.jsonl");
    expect(tracked.some((entry) => entry.startsWith(".bridge/git/"))).toBe(false);
  });

  it("migrates a legacy root .git directory into .bridge/git and preserves history", async () => {
    const paths = workspacePaths(projectsDir, "users/ws_legacy");
    await fs.mkdir(paths.root, { recursive: true });
    await fs.writeFile(path.join(paths.root, "legacy.txt"), "before\n");

    git(paths.root, ["init", "-b", "main"]);
    git(paths.root, ["config", "user.name", "Legacy User"]);
    git(paths.root, ["config", "user.email", "legacy@example.com"]);
    git(paths.root, ["add", "legacy.txt"]);
    git(paths.root, ["commit", "-m", "legacy init"]);

    await manager.ensureWorkspaceRepo(paths);

    const pointerStat = await fs.stat(path.join(paths.root, ".git"));
    expect(pointerStat.isFile()).toBe(true);
    expect(await fs.readFile(path.join(paths.root, ".git"), "utf8")).toBe("gitdir: .bridge/git\n");
    await expect(fs.stat(path.join(paths.gitDir, "HEAD"))).resolves.toBeTruthy();
    expect(git(paths.root, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(git(paths.root, ["log", "--format=%s", "-1"])).toBe("legacy init");
  });

  it("heals stale push-to-checkout hook contents and permissions", async () => {
    const paths = workspacePaths(projectsDir, "users/ws_hook_heal");
    await fs.mkdir(paths.coworkDir, { recursive: true });
    await fs.writeFile(path.join(paths.coworkDir, "note.txt"), "hello\n");

    await manager.ensureWorkspaceRepo(paths);

    const hookPath = path.join(paths.gitDir, "hooks", "push-to-checkout");
    await fs.writeFile(hookPath, '#!/bin/sh\ngit reset --hard "$1"\n', "utf8");
    await fs.chmod(hookPath, 0o644);

    await manager.ensureWorkspaceRepo(paths);

    expect(await fs.readFile(hookPath, "utf8")).toBe(EXPECTED_PUSH_TO_CHECKOUT_HOOK);
    const stat = await fs.stat(hookPath);
    expect(stat.mode & 0o111).toBeTruthy();
  });

  it("push-to-checkout updates the live worktree and leaves the remote clean after push", async () => {
    const workspacePath = "users/ws_push";
    const paths = workspacePaths(projectsDir, workspacePath);
    await fs.mkdir(paths.coworkDir, { recursive: true });
    await fs.writeFile(path.join(paths.coworkDir, "note.txt"), "before\n");

    await manager.ensureWorkspaceRepo(paths);

    const cloneDir = path.join(tmpDir, "clone");
    const remoteUrl = `file://${paths.root}`;
    git(tmpDir, ["clone", remoteUrl, cloneDir]);
    git(cloneDir, ["config", "user.name", "Remote User"]);
    git(cloneDir, ["config", "user.email", "remote@example.com"]);

    await fs.writeFile(path.join(cloneDir, "cowork", "note.txt"), "after\n");
    git(cloneDir, ["commit", "-am", "remote update"]);
    const pushedHead = git(cloneDir, ["rev-parse", "HEAD"]);

    git(cloneDir, ["push", "origin", "main"]);

    expect(await fs.readFile(path.join(paths.coworkDir, "note.txt"), "utf8")).toBe("after\n");
    expect(git(paths.root, ["rev-parse", "HEAD"])).toBe(pushedHead);
    expect(git(paths.root, ["status", "--short"])).toBe("");
  });

  it("refuses to create git state for a missing workspace root", async () => {
    const paths = workspacePaths(projectsDir, "users/ws_missing");

    await expect(manager.ensureWorkspaceRepo(paths)).rejects.toThrow(
      `Workspace root is missing or not a directory: ${paths.root}`,
    );
  });

  it("commits one snapshot per changed completed run and no-ops when clean", async () => {
    const workspacePath = "users/ws_runs";
    const paths = workspacePaths(projectsDir, workspacePath);
    await fs.mkdir(paths.sessionsDir, { recursive: true });
    await fs.writeFile(path.join(paths.sessionsDir, "session.jsonl"), '{"type":"start"}\n');

    await manager.ensureWorkspaceRepo(paths);
    expect(git(paths.root, ["rev-list", "--count", "HEAD"])).toBe("1");

    await fs.appendFile(path.join(paths.sessionsDir, "session.jsonl"), '{"type":"message"}\n');
    await expect(manager.commitCompletedRun(workspacePath, "inbound")).resolves.toBe(true);
    expect(git(paths.root, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(git(paths.root, ["log", "--format=%s", "-1"])).toMatch(/^bridge: save inbound run /);

    await expect(manager.commitCompletedRun(workspacePath, "inbound")).resolves.toBe(false);
    expect(git(paths.root, ["rev-list", "--count", "HEAD"])).toBe("2");
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
