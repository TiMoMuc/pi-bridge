import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("orient.py", () => {
  let tmpDir: string;
  let workspaceRoot: string;
  let agentDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "orient-script-test-"));
    workspaceRoot = path.join(tmpDir, "workspace");
    agentDir = path.join(workspaceRoot, ".agent");
    await fs.mkdir(path.join(agentDir, "skills", "demo-skill"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, ".events"), { recursive: true });
    await fs.mkdir(path.join(workspaceRoot, "cowork"), { recursive: true });
    await fs.copyFile("__blueprint__/.agent/orient.py", path.join(agentDir, "orient.py"));
    await fs.writeFile(
      path.join(agentDir, "skills", "demo-skill", "SKILL.md"),
      "---\nname: demo-skill\ndescription: Demo skill description.\n---\n\nUse me when needed.\n",
    );
    await fs.writeFile(
      path.join(workspaceRoot, ".events", "weekly.json"),
      JSON.stringify({ type: "periodic", schedule: "0 9 * * 1", timezone: "Europe/Berlin", text: "Weekly review" }),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function runOrient(...args: string[]): Promise<string> {
    const scriptPath = path.join(agentDir, "orient.py");
    const { stdout } = await execFileAsync("python3", [scriptPath, ...args], {
      cwd: workspaceRoot,
      env: process.env,
    });
    return stdout;
  }

  it("renders a wrapped prompt-safe default with repo surface and skills", async () => {
    const output = await runOrient();

    expect(output).toContain("# Workspace Orientation");
    expect(output).toContain("Informational workspace context only");
    expect(output).toContain("## Repo Surface");
    expect(output).toContain("## Available Skills");
    expect(output).toContain("demo-skill");
    expect(output).toContain(".agent/skills/demo-skill/SKILL.md");
    expect(output).not.toContain("## Scheduled Events");
  });

  it("includes events only when explicitly requested", async () => {
    const output = await runOrient("--events");

    expect(output).toContain("## Scheduled Events");
    expect(output).toContain("weekly.json");
    expect(output).toContain("0 9 * * 1");
  });

  it("degrades malformed skill frontmatter into warnings instead of failing", async () => {
    await fs.mkdir(path.join(agentDir, "skills", "broken-skill"), { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "skills", "broken-skill", "SKILL.md"),
      "---\nname: broken-skill\ndescription: missing closer\nThis never closes\n",
    );

    const output = await runOrient("--skills");

    expect(output).toContain("## Available Skills");
    expect(output).toContain("demo-skill");
    expect(output).toContain("## Orientation Warnings");
    expect(output).toContain("broken-skill/SKILL.md: frontmatter is not properly closed");
  });
});
