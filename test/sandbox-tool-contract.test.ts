import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
  createDockerBashOps,
  createDockerEditOps,
  createDockerReadOps,
  createDockerWriteOps,
} from "../src/runner.js";
import type { ExecBinaryResult, ExecOptions, ExecResult, Executor } from "../src/sandbox.js";

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "tool-contract",
);

function createLocalShellExecutor(defaultCwd: string): Executor {
  return {
    exec: (command, options) => runShellText(command, options, defaultCwd),
    execBinary: (command, options) => runShellBinary(command, options, defaultCwd),
  };
}

function runShellText(
  command: string,
  options: ExecOptions | undefined,
  defaultCwd: string,
): Promise<ExecResult> {
  return runShell(command, options, defaultCwd, "text") as Promise<ExecResult>;
}

function runShellBinary(
  command: string,
  options: ExecOptions | undefined,
  defaultCwd: string,
): Promise<ExecBinaryResult> {
  return runShell(command, options, defaultCwd, "binary") as Promise<ExecBinaryResult>;
}

function runShell(
  command: string,
  options: ExecOptions | undefined,
  defaultCwd: string,
  mode: "text" | "binary",
): Promise<ExecResult | ExecBinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], {
      cwd: options?.cwd ?? defaultCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let aborted = false;
    let timedOut = false;

    const timeoutHandle =
      options?.timeout && options.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeout * 1000)
        : undefined;

    const onAbort = () => {
      aborted = true;
      child.kill("SIGKILL");
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.on("error", reject);
    child.stdout?.on("data", (data: Buffer) => stdoutChunks.push(Buffer.from(data)));
    child.stderr?.on("data", (data: Buffer) => stderrChunks.push(Buffer.from(data)));
    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      options?.signal?.removeEventListener("abort", onAbort);

      if (aborted) {
        reject(new Error("Command aborted"));
        return;
      }

      if (timedOut) {
        reject(new Error(`Command timed out after ${options?.timeout} seconds`));
        return;
      }

      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (mode === "binary") {
        resolve({ stdout, stderr, code: code ?? 0 });
        return;
      }

      resolve({ stdout: stdout.toString("utf8"), stderr, code: code ?? 0 });
    });
  });
}

type ToolBundle = ReturnType<typeof createToolBundle>;

function createToolBundle(stockDir: string, bridgeDir: string, executor: Executor) {
  return {
    stock: {
      read: createReadTool(stockDir),
      bash: createBashTool(stockDir),
      edit: createEditTool(stockDir),
      write: createWriteTool(stockDir),
    },
    bridge: {
      read: createReadTool(bridgeDir, { operations: createDockerReadOps(executor) }),
      bash: createBashTool(bridgeDir, { operations: createDockerBashOps(executor) }),
      edit: createEditTool(bridgeDir, { operations: createDockerEditOps(executor) }),
      write: createWriteTool(bridgeDir, { operations: createDockerWriteOps(executor) }),
    },
  };
}

async function executeTool<TResult>(
  tool: { execute: unknown },
  params: unknown,
): Promise<TResult> {
  const execute = tool.execute as (
    toolCallId: string,
    toolParams: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<TResult>;
  return execute("tool-call-1", params, undefined, undefined);
}

function getContentTypes(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const content = (result as { content?: Array<{ type?: string }> }).content;
  return Array.isArray(content)
    ? content.map((part) => part.type).filter((type): type is string => typeof type === "string")
    : [];
}

function getTextContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return Array.isArray(content)
    ? content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    : "";
}

describe("sandbox tool contract", () => {
  let tmpDir: string;
  let stockDir: string;
  let bridgeDir: string;
  let tools: ToolBundle;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-tool-contract-"));
    stockDir = path.join(tmpDir, "stock");
    bridgeDir = path.join(tmpDir, "bridge");
    await fs.cp(FIXTURE_DIR, stockDir, { recursive: true });
    await fs.cp(FIXTURE_DIR, bridgeDir, { recursive: true });
    tools = createToolBundle(stockDir, bridgeDir, createLocalShellExecutor(bridgeDir));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("read", () => {
    it("matches stock pi for small text and unicode fixtures", async () => {
      for (const fixture of ["small.txt", "unicode.txt"]) {
        const stock = await executeTool(tools.stock.read, { path: fixture });
        const bridge = await executeTool(tools.bridge.read, { path: fixture });
        expect(bridge).toEqual(stock);
        expect(getContentTypes(bridge)).toEqual(["text"]);
      }
    });

    it("matches stock pi for long text truncation and offset/limit", async () => {
      const stockFull = await executeTool(tools.stock.read, { path: "long.txt" });
      const bridgeFull = await executeTool(tools.bridge.read, { path: "long.txt" });
      expect(bridgeFull).toEqual(stockFull);
      expect(getTextContent(bridgeFull)).toContain("Use offset=2001 to continue.");

      const stockSlice = await executeTool(tools.stock.read, {
        path: "long.txt",
        offset: 2050,
        limit: 5,
      });
      const bridgeSlice = await executeTool(tools.bridge.read, {
        path: "long.txt",
        offset: 2050,
        limit: 5,
      });
      expect(bridgeSlice).toEqual(stockSlice);
      expect(getTextContent(bridgeSlice)).toContain("[152 more lines in file. Use offset=2055 to continue.]");
    });

    it.each([
      ["sample.png", "image/png"],
      ["sample.jpg", "image/jpeg"],
      ["sample.gif", "image/gif"],
    ])("matches stock pi for %s image reads", async (fixture, mimeType) => {
      const stock = await executeTool(tools.stock.read, { path: fixture });
      const bridge = await executeTool(tools.bridge.read, { path: fixture });

      expect(bridge).toEqual(stock);
      expect(getContentTypes(bridge)).toEqual(["text", "image"]);
      expect(getTextContent(bridge)).toContain(`Read image file [${mimeType}]`);
      expect(getTextContent(bridge)).not.toContain("�PNG");
    });

    it("keeps non-image binary reads on the stock pi text fallback path", async () => {
      const stock = await executeTool(tools.stock.read, { path: "sample.pdf" });
      const bridge = await executeTool(tools.bridge.read, { path: "sample.pdf" });

      expect(bridge).toEqual(stock);
      expect(getContentTypes(bridge)).toEqual(["text"]);
    });

    it("rejects missing and unreadable files", async () => {
      await expect(executeTool(tools.stock.read, { path: "missing.txt" })).rejects.toThrow();
      await expect(executeTool(tools.bridge.read, { path: "missing.txt" })).rejects.toThrow();

      const stockUnreadable = path.join(stockDir, "unreadable.txt");
      const bridgeUnreadable = path.join(bridgeDir, "unreadable.txt");
      await fs.writeFile(stockUnreadable, "hidden\n", "utf8");
      await fs.writeFile(bridgeUnreadable, "hidden\n", "utf8");
      await fs.chmod(stockUnreadable, 0o000);
      await fs.chmod(bridgeUnreadable, 0o000);

      try {
        await expect(executeTool(tools.stock.read, { path: "unreadable.txt" })).rejects.toThrow();
        await expect(executeTool(tools.bridge.read, { path: "unreadable.txt" })).rejects.toThrow();
      } finally {
        await fs.chmod(stockUnreadable, 0o644);
        await fs.chmod(bridgeUnreadable, 0o644);
      }
    });
  });

  describe("edit", () => {
    it("matches stock pi for ordinary text edits", async () => {
      const relativePath = "editable.txt";
      const original = await fs.readFile(path.join(stockDir, "unicode.txt"), "utf8");
      await fs.writeFile(path.join(stockDir, relativePath), original, "utf8");
      await fs.writeFile(path.join(bridgeDir, relativePath), original, "utf8");

      const params = {
        path: relativePath,
        edits: [
          { oldText: "Hällo π 👋", newText: "Hello π 👋" },
          { oldText: "naïve café", newText: "naïve café au lait" },
        ],
      };

      const stock = await executeTool(tools.stock.edit, params);
      const bridge = await executeTool(tools.bridge.edit, params);

      expect(bridge).toEqual(stock);
      expect(await fs.readFile(path.join(bridgeDir, relativePath), "utf8")).toBe(
        await fs.readFile(path.join(stockDir, relativePath), "utf8"),
      );
    });

    it.each(["sample.png", "sample.pdf"])("rejects binary edits for %s", async (fixture) => {
      const bridgePath = path.join(bridgeDir, fixture);
      const before = await fs.readFile(bridgePath);

      await expect(executeTool(tools.bridge.edit, {
        path: fixture,
        edits: [{ oldText: "x", newText: "y" }],
      })).rejects.toThrow(/Binary files are not supported by edit/);

      expect(await fs.readFile(bridgePath)).toEqual(before);
    });
  });

  describe("write", () => {
    it("matches stock pi for unicode and multiline text", async () => {
      const content = [
        "Hällo π 👋",
        "quotes: 'single' and \"double\"",
        "shell-ish: $PATH `pwd` \\ backslash",
      ].join("\n");

      const stock = await executeTool(tools.stock.write, {
        path: "written/unicode.txt",
        content,
      });
      const bridge = await executeTool(tools.bridge.write, {
        path: "written/unicode.txt",
        content,
      });

      expect(bridge).toEqual(stock);
      expect(await fs.readFile(path.join(bridgeDir, "written", "unicode.txt"), "utf8")).toBe(content);
      expect(await fs.readFile(path.join(stockDir, "written", "unicode.txt"), "utf8")).toBe(content);
    });

    it("round-trips a larger text payload without treating write as binary transport", async () => {
      const content = Array.from(
        { length: 1536 },
        (_, index) => `line ${index + 1} • café • 'quotes' • "double" • $HOME • \\`,
      ).join("\n");

      const stock = await executeTool(tools.stock.write, {
        path: "written/large.txt",
        content,
      });
      const bridge = await executeTool(tools.bridge.write, {
        path: "written/large.txt",
        content,
      });

      expect(bridge).toEqual(stock);
      expect(await fs.readFile(path.join(bridgeDir, "written", "large.txt"), "utf8")).toBe(content);
    });
  });

  describe("bash", () => {
    it("stays text-oriented even when stdout starts with image bytes", async () => {
      const stock = await executeTool(tools.stock.bash, { command: "head -c 8 sample.png" });
      const bridge = await executeTool(tools.bridge.bash, { command: "head -c 8 sample.png" });

      expect(getContentTypes(stock)).toEqual(["text"]);
      expect(getContentTypes(bridge)).toEqual(["text"]);
      expect(getContentTypes(bridge)).not.toContain("image");
    });
  });
});
