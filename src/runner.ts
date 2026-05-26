/**
 * Per-sender agent runner: creates AgentSessions and handles individual messages.
 *
 * Key patterns:
 *   - runState: Subscriber registered ONCE, mutable state reset per run.
 *   - Queue chain: All transport API calls serialized per run.
 *   - Silent turns: wait() ends a turn without an outbound user message.
 *
 * Prompt architecture:
 *   Three stable layers managed by the SDK's ResourceLoader:
 *     1. Constitution (customPrompt) — identity, values, principles
 *     2. Interface Protocol (appendSystemPrompt) — bridge-global mechanics + active transport rules
 *     3. AGENTS.md content (appendSystemPrompt) — agent's own working notes, without leaking its real file path
 *   No per-run setSystemPrompt(). Prompt is stable within a session.
 *
 * Sandbox integration:
 *   Tool calls are delegated to a per-workspace Docker container via custom
 *   Operations implementations backed by an Executor.
 *   The pi SDK's createBashTool/createReadTool/etc. accept pluggable Operations.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type ImageContent, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import {
  type AgentSession,
  type AgentSessionEvent,
  AuthStorage,
  createAgentSession,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  createExtensionRuntime,
  defineTool,
  ModelRegistry,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
  type BashOperations,
  type ReadOperations,
  type EditOperations,
  type WriteOperations,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { enabledTransportNames, resolveSandboxCwd, SANDBOX_WORKSPACE_ROOT, type Config, type PiThinkingLevel } from "./config.js";
import { getLogger } from "./logger.js";
import { LEGACY_BOOT_COMMAND, type WorkspaceRecord } from "./provisioner.js";
import type { TransportName } from "./transport.js";
import { DockerExecutor, type Executor } from "./sandbox.js";
import type { SessionWatchEvent, SessionWatchSink } from "./session-watch.js";
import { legacyWorkspacePath, workspacePaths } from "./workspace-paths.js";

export interface RunContext {
  sender: string;
  correlationId?: string;
}

/** Input to AgentRunner.run() */
export interface RunInput {
  /** User message text (may include attachment preamble) */
  text: string;
  /** Images for native vision models */
  images?: ImageContent[];
}

export interface SyntheticReadInput {
  path: string;
  content: string;
}

/** Result from AgentRunner.run() */
export interface RunResult {
  /** Raw final agent response text (bridge parses outbound control tokens later) */
  response: string;
  /** True when the custom wait() tool intentionally ended the turn silently */
  waitCalled: boolean;
  /** Error message if run failed */
  error?: string;
  /** Session file for this run */
  sessionFile?: string;
  /** The new user-message session entry created by this run, if any */
  userMessageId?: string;
  /** The final assistant-message session entry created by this run, if any */
  assistantMessageId?: string;
}

function createWatchRunId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function publishWatchEvent(
  sink: SessionWatchSink | undefined,
  workspaceKey: string,
  event: SessionWatchEvent,
): void {
  sink?.publish(workspaceKey, event);
}

function summarizeToolStart(toolName: string, args: unknown): string {
  const params = isRecord(args) ? args : {};

  if (toolName === "bash") {
    const command = typeof params["command"] === "string" ? params["command"] : undefined;
    return command ? `$ ${command}` : "bash";
  }

  if (toolName === "read") {
    const filePath = pickString(params, ["file_path", "path"]);
    const offset = typeof params["offset"] === "number" ? params["offset"] : undefined;
    const limit = typeof params["limit"] === "number" ? params["limit"] : undefined;
    const suffix = offset !== undefined || limit !== undefined
      ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
      : "";
    return filePath ? `read ${filePath}${suffix}` : "read";
  }

  if (toolName === "write") {
    const filePath = pickString(params, ["file_path", "path"]);
    const content = typeof params["content"] === "string" ? params["content"] : "";
    const lineCount = content ? content.split(/\r?\n/).length : 0;
    return filePath
      ? `write ${filePath}${lineCount > 0 ? ` (${lineCount} lines)` : ""}`
      : "write";
  }

  if (toolName === "edit") {
    const filePath = pickString(params, ["file_path", "path"]);
    return filePath ? `edit ${filePath}` : "edit";
  }

  return toolName;
}

function summarizeToolResult(result: unknown): string | undefined {
  const text = extractToolText(result);
  if (!text) return undefined;
  return truncateWatchText(text, 12, 1200);
}

function extractToolText(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (!isRecord(result)) return "";

  const details = isRecord(result["details"]) ? result["details"] : undefined;
  if (details && typeof details["diff"] === "string" && details["diff"].trim()) {
    return details["diff"].trim();
  }

  const content = Array.isArray(result["content"]) ? result["content"] : undefined;
  if (content) {
    const text = content
      .map((part) => isRecord(part) && typeof part["text"] === "string" ? part["text"] : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }

  if (typeof result["stdout"] === "string" && result["stdout"].trim()) {
    return result["stdout"].trim();
  }
  if (typeof result["output"] === "string" && result["output"].trim()) {
    return result["output"].trim();
  }
  if (typeof result["message"] === "string" && result["message"].trim()) {
    return result["message"].trim();
  }

  return "";
}

function truncateWatchText(text: string, maxLines: number, maxChars: number): string {
  const normalized = text.trim();
  if (!normalized) return "";
  const lines = normalized.split(/\r?\n/);
  const visibleLines = lines.slice(0, maxLines);
  let truncated = visibleLines.join("\n");

  if (truncated.length > maxChars) {
    truncated = `${truncated.slice(0, maxChars)}…`;
  } else if (lines.length > maxLines) {
    truncated = `${truncated}\n…`;
  }

  return truncated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key];
    }
  }
  return undefined;
}

// ============================================================================
// Docker-backed Operations (delegate tool calls to sandbox container)
// ============================================================================

const IMAGE_SNIFF_BYTES = 4100;
const utf8TextDecoder = new TextDecoder("utf-8", { fatal: true });

function hasNonTextControlChars(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (
      code === 0x7f
      || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0b && code !== 0x0c && code !== 0x0d)
    ) {
      return true;
    }
  }
  return false;
}

function detectSupportedImageMimeType(buffer: Buffer): string | null {
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (buffer.length >= 6) {
    const gifHeader = buffer.subarray(0, 6).toString("ascii");
    if (gifHeader === "GIF87a" || gifHeader === "GIF89a") {
      return "image/gif";
    }
  }

  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

function buildSandboxReadCommand(absolutePath: string, maxBytes?: number): string {
  if (maxBytes === undefined) {
    return `cat ${shellEscape(absolutePath)}`;
  }

  return `head -c ${Math.max(0, Math.trunc(maxBytes))} ${shellEscape(absolutePath)}`;
}

async function readSandboxFileBytes(
  executor: Executor,
  absolutePath: string,
  maxBytes?: number,
): Promise<Buffer> {
  // read/edit preflight must keep raw bytes intact until the bridge decides
  // whether the file is text or an image. Crossing the sandbox boundary through
  // UTF-8 stdout corrupts binary data and breaks the stock pi tool contract.
  if (!executor.execBinary) {
    throw new Error(
      "Sandbox file reads require executor.execBinary(); file contents must not cross a text boundary.",
    );
  }

  const result = await executor.execBinary(buildSandboxReadCommand(absolutePath, maxBytes));
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to read file: ${absolutePath}`);
  }
  return result.stdout;
}

function assertEditableTextBuffer(buffer: Buffer, absolutePath: string): void {
  let decoded: string;
  try {
    decoded = utf8TextDecoder.decode(buffer);
  } catch {
    throw new Error(`Binary files are not supported by edit: ${absolutePath}`);
  }

  if (hasNonTextControlChars(decoded)) {
    throw new Error(`Binary files are not supported by edit: ${absolutePath}`);
  }
}

export function createDockerBashOps(executor: Executor): BashOperations {
  return {
    exec: async (
      command: string,
      cwd: string,
      options: {
        onData: (data: Buffer) => void;
        signal?: AbortSignal;
        timeout?: number;
      },
    ) => {
      const result = await executor.exec(command, {
        timeout: options.timeout,
        signal: options.signal,
        cwd,
      });
      // Stream all output at once (docker exec doesn't do incremental streaming here)
      const combined = result.stdout + (result.stderr ? "\n" + result.stderr : "");
      if (combined) options.onData(Buffer.from(combined));
      return { exitCode: result.code };
    },
  };
}

export function createDockerReadOps(executor: Executor): ReadOperations {
  return {
    readFile: async (absolutePath: string): Promise<Buffer> => readSandboxFileBytes(executor, absolutePath),
    access: async (absolutePath: string): Promise<void> => {
      const result = await executor.exec(`test -r ${shellEscape(absolutePath)}`);
      if (result.code !== 0) {
        throw new Error(`File not accessible: ${absolutePath}`);
      }
    },
    detectImageMimeType: async (absolutePath: string): Promise<string | null> =>
      detectSupportedImageMimeType(await readSandboxFileBytes(executor, absolutePath, IMAGE_SNIFF_BYTES)),
  };
}

export function createDockerEditOps(executor: Executor): EditOperations {
  return {
    readFile: async (absolutePath: string): Promise<Buffer> => {
      const buffer = await readSandboxFileBytes(executor, absolutePath);
      assertEditableTextBuffer(buffer, absolutePath);
      return buffer;
    },
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      const result = await executor.exec(
        `printf '%s' ${shellEscape(content)} > ${shellEscape(absolutePath)}`,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr || `Failed to write file: ${absolutePath}`);
      }
    },
    access: async (absolutePath: string): Promise<void> => {
      const result = await executor.exec(`test -r ${shellEscape(absolutePath)} && test -w ${shellEscape(absolutePath)}`);
      if (result.code !== 0) {
        throw new Error(`File not accessible: ${absolutePath}`);
      }
    },
  };
}

export function createDockerWriteOps(executor: Executor): WriteOperations {
  return {
    writeFile: async (absolutePath: string, content: string): Promise<void> => {
      const dir = absolutePath.includes("/")
        ? absolutePath.substring(0, absolutePath.lastIndexOf("/"))
        : ".";
      const result = await executor.exec(
        `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(content)} > ${shellEscape(absolutePath)}`,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr || `Failed to write file: ${absolutePath}`);
      }
    },
    mkdir: async (dir: string): Promise<void> => {
      const result = await executor.exec(`mkdir -p ${shellEscape(dir)}`);
      if (result.code !== 0) {
        throw new Error(result.stderr || `Failed to create directory: ${dir}`);
      }
    },
  };
}

function wrapToolAsCustomTool<TParams extends TSchema, TDetails>(
  tool: AgentTool<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) =>
      tool.execute(toolCallId, params, signal, onUpdate),
  };
}

const WAIT_TOOL_NAME = "wait";
const waitToolSchema = Type.Object({}, { additionalProperties: false });

function createWaitTool(): ToolDefinition<typeof waitToolSchema, { silent: true }> {
  return defineTool({
    name: WAIT_TOOL_NAME,
    label: WAIT_TOOL_NAME,
    description: "End the current turn silently. Takes no arguments.",
    promptSnippet: "Call wait() with no arguments to end the current turn silently",
    promptGuidelines: [
      "Use wait() with no arguments when you intentionally want no outbound user-facing message for the current turn",
      "Do not pass arguments to wait()",
      "If you call wait(), the bridge suppresses any visible assistant text from that turn",
    ],
    parameters: waitToolSchema,
    async execute() {
      return {
        content: [{ type: "text", text: "The current turn ended silently." }],
        details: { silent: true },
        terminate: true,
      };
    },
  });
}

function isSuccessfulWaitToolResult(event: {
  toolName: string;
  isError: boolean;
  result: unknown;
}): boolean {
  return event.toolName === WAIT_TOOL_NAME
    && !event.isError
    && isRecord(event.result)
    && event.result["terminate"] === true;
}

function createSandboxToolOverrides(
  sandboxCwd: string,
  executor: Executor,
): Array<ToolDefinition<TSchema, unknown>> {
  return [
    wrapToolAsCustomTool(createReadTool(sandboxCwd, { operations: createDockerReadOps(executor) })) as unknown as ToolDefinition<TSchema, unknown>,
    wrapToolAsCustomTool(createBashTool(sandboxCwd, { operations: createDockerBashOps(executor) })) as unknown as ToolDefinition<TSchema, unknown>,
    wrapToolAsCustomTool(createEditTool(sandboxCwd, { operations: createDockerEditOps(executor) })) as unknown as ToolDefinition<TSchema, unknown>,
    wrapToolAsCustomTool(createWriteTool(sandboxCwd, { operations: createDockerWriteOps(executor) })) as unknown as ToolDefinition<TSchema, unknown>,
  ];
}

function createCustomTools(sandboxCwd: string, executor: Executor): Array<ToolDefinition<TSchema, unknown>> {
  return [
    createWaitTool() as unknown as ToolDefinition<TSchema, unknown>,
    ...createSandboxToolOverrides(sandboxCwd, executor),
  ];
}

let sandboxStartupSelfCheckPromise: Promise<void> | null = null;

export function resetSandboxStartupSelfCheckCache(): void {
  sandboxStartupSelfCheckPromise = null;
}

export async function runSandboxStartupSelfCheck(
  executor: Executor,
  sandboxCwd: string,
): Promise<void> {
  const result = await executor.exec(
    `pwd && test -d ${shellEscape(SANDBOX_WORKSPACE_ROOT)} && test -d ${shellEscape(sandboxCwd)}`,
    { cwd: sandboxCwd, timeout: 10 },
  );

  const actualCwd = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? "";

  if (result.code !== 0 || actualCwd !== sandboxCwd) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
    throw new Error(
      `Sandbox startup self-check failed: expected sandbox cwd ${sandboxCwd}, got ${actualCwd || "<empty>"} (${detail}). `
      + "Tool execution may not be routed through the sandbox; check session wiring and sandbox executor setup before trusting isolation.",
    );
  }
}

async function ensureSandboxStartupSelfCheck(
  sender: string,
  executor: Executor,
  sandboxCwd: string,
): Promise<void> {
  if (!(executor instanceof DockerExecutor)) {
    return;
  }

  sandboxStartupSelfCheckPromise ??= (async () => {
    try {
      await runSandboxStartupSelfCheck(executor, sandboxCwd);
      getLogger().info("runner", "sandbox-self-check-passed", `Sandbox startup self-check passed (${sandboxCwd})`, {
        workspaceKey: sender,
        sandboxCwd,
      });
    } catch (err) {
      getLogger().error("runner", "sandbox-self-check-failed", "Sandbox startup self-check failed", {
        workspaceKey: sender,
        sandboxCwd,
        error: err,
      });
      throw err;
    }
  })();

  await sandboxStartupSelfCheckPromise;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Per-run mutable state (Pattern 1: runState)
// ============================================================================

interface RunState {
  ctx: RunContext | null;
  queue: QueueChain | null;
  pendingTools: Map<string, { toolName: string; startTime: number }>;
  responseText: string;
  waitCalled: boolean;
  stopReason: string;
  errorMessage: string | undefined;
  currentRunId: string | undefined;
}

interface QueueChain {
  enqueue(fn: () => Promise<void>): void;
  drain(): Promise<void>;
}

function createQueueChain(): QueueChain {
  let chain = Promise.resolve();

  return {
    enqueue(fn: () => Promise<void>): void {
      chain = chain.then(async () => {
        try {
          await fn();
        } catch (err) {
          getLogger().error("runner", "queue-error", "Queue error", { error: err });
        }
      });
    },
    drain(): Promise<void> {
      return chain;
    },
  };
}

// ============================================================================
// Constitution loader (cached)
// ============================================================================

let constitutionCache: string | null = null;

export async function loadConstitution(systemDir: string): Promise<string> {
  if (constitutionCache !== null) return constitutionCache;
  try {
    constitutionCache = await fs.readFile(path.join(systemDir, "CONSTITUTION.md"), "utf8");
  } catch {
    constitutionCache = "";
    getLogger().warn("runner", "constitution-missing", "CONSTITUTION.md not found in system dir — no constitution injected");
  }
  return constitutionCache;
}

/** Reset the cache (for testing). */
export function resetConstitutionCache(): void {
  constitutionCache = null;
}

// ============================================================================
// Interface Protocol loaders (cached)
// ============================================================================

const interfaceProtocolCache = new Map<string, string>();

async function loadOptionalInterfaceProtocol(
  systemDir: string,
  fileName: string,
  missingMessage: string,
): Promise<string> {
  const cacheKey = path.join(systemDir, fileName);
  const cached = interfaceProtocolCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const content = await fs.readFile(cacheKey, "utf8");
    interfaceProtocolCache.set(cacheKey, content);
    return content;
  } catch {
    interfaceProtocolCache.set(cacheKey, "");
    getLogger().warn("runner", "interface-protocol-missing", missingMessage.replace(/^\[runner\]\s*/, ""));
    return "";
  }
}

export async function loadInterfaceProtocol(systemDir: string): Promise<string> {
  return loadOptionalInterfaceProtocol(
    systemDir,
    "interface-protocol.md",
    "[runner] interface-protocol.md not found in system dir — no bridge-global interface protocol injected",
  );
}

export async function loadTransportInterfaceProtocol(
  systemDir: string,
  transport: TransportName,
): Promise<string> {
  const fileName = `interface-protocol-${transport}.md`;
  return loadOptionalInterfaceProtocol(
    systemDir,
    fileName,
    `[runner] ${fileName} not found in system dir — no ${transport} interface addendum injected`,
  );
}

export async function loadInterfaceProtocols(
  systemDir: string,
  transport: TransportName | undefined,
): Promise<string[]> {
  const layers = await Promise.all([
    loadInterfaceProtocol(systemDir),
    ...(transport ? [loadTransportInterfaceProtocol(systemDir, transport)] : []),
  ]);
  return layers.filter(Boolean);
}

/** Reset the cache (for testing). */
export function resetInterfaceProtocolCache(): void {
  interfaceProtocolCache.clear();
}

// ============================================================================
// AgentRunner
// ============================================================================

const AGENT_WORKSPACE_ROOT = "/workspace";

export class AgentRunner {
  /** The path the agent sees as its workspace root.
   *  The bridge uses this seam to translate attachment paths between the
   *  bridge-visible workspace and the agent-visible workspace namespace. */
  readonly agentWorkspaceRoot = AGENT_WORKSPACE_ROOT;

  constructor(
    private readonly session: AgentSession,
    private readonly sessionManager: SessionManager,
    private readonly runState: RunState,
    readonly sender: string,
    readonly userDir: string,
    readonly modelProvider: string,
    readonly modelName: string,
    readonly thinkingLevel: PiThinkingLevel,
    private readonly sessionWatchSink?: SessionWatchSink,
  ) {}

  async run(ctx: RunContext, input: RunInput): Promise<RunResult> {
    const { session } = this;
    const entryCountBefore = this.beginRun(ctx);

    try {
      await session.prompt(input.text, { images: input.images });
      return await this.finishRun(entryCountBefore);
    } catch (err) {
      this.markRunError(err);
      throw err;
    } finally {
      await this.endRun();
    }
  }

  async runSyntheticRead(ctx: RunContext, input: SyntheticReadInput): Promise<RunResult> {
    const { session, sessionManager } = this;
    const entryCountBefore = this.beginRun(ctx);

    try {
      const toolCallId = `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const toolCall: ToolCall = {
        type: "toolCall",
        id: toolCallId,
        name: "read",
        arguments: { path: input.path },
      };
      const model = session.model;
      if (!model) {
        throw new Error("Cannot inject synthetic read without an active model");
      }

      const assistantMessage: AssistantMessage = {
        role: "assistant",
        content: [toolCall],
        api: model.api as AssistantMessage["api"],
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      const toolResult: ToolResultMessage = {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: input.content }],
        isError: false,
        details: undefined,
        timestamp: Date.now(),
      };

      session.agent.state.messages = [...session.messages, assistantMessage, toolResult];
      sessionManager.appendMessage(assistantMessage);
      sessionManager.appendMessage(toolResult);

      await session.agent.continue();
      return await this.finishRun(entryCountBefore);
    } catch (err) {
      this.markRunError(err);
      throw err;
    } finally {
      await this.endRun();
    }
  }

  private beginRun(ctx: RunContext): number {
    const { sessionManager, runState } = this;

    runState.ctx = ctx;
    runState.queue = createQueueChain();
    runState.pendingTools.clear();
    runState.responseText = "";
    runState.waitCalled = false;
    runState.stopReason = "stop";
    runState.errorMessage = undefined;
    runState.currentRunId = createWatchRunId();

    const entryCountBefore = sessionManager.getEntries().length;
    publishWatchEvent(this.sessionWatchSink, this.sender, {
      type: "run_start",
      runId: runState.currentRunId,
      at: new Date().toISOString(),
    });
    return entryCountBefore;
  }

  private async finishRun(entryCountBefore: number): Promise<RunResult> {
    const { runState } = this;

    await runState.queue?.drain();
    const refs = this.collectRunRefs(entryCountBefore);

    if (runState.stopReason === "error" && runState.errorMessage) {
      return {
        response: "",
        waitCalled: runState.waitCalled,
        error: runState.errorMessage,
        ...refs,
      };
    }

    const response = runState.responseText.trim();
    return { response, waitCalled: runState.waitCalled, ...refs };
  }

  private markRunError(err: unknown): void {
    const { runState } = this;
    runState.stopReason = "error";
    if (!runState.errorMessage) {
      runState.errorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  private async endRun(): Promise<void> {
    const { runState } = this;
    await runState.queue?.drain().catch(() => undefined);
    if (runState.currentRunId) {
      publishWatchEvent(this.sessionWatchSink, this.sender, {
        type: "run_end",
        runId: runState.currentRunId,
        at: new Date().toISOString(),
        stopReason: runState.stopReason,
        error: runState.errorMessage,
      });
    }
    runState.ctx = null;
    runState.queue = null;
    runState.currentRunId = undefined;
  }

  private collectRunRefs(entryCountBefore: number): Pick<RunResult, "sessionFile" | "userMessageId" | "assistantMessageId"> {
    const newEntries = this.sessionManager.getEntries().slice(entryCountBefore);
    let userMessageId: string | undefined;
    let assistantMessageId: string | undefined;

    for (const entry of newEntries) {
      const candidate = entry as unknown as {
        type?: string;
        id?: string;
        message?: { role?: string };
      };
      if (candidate.type !== "message" || !candidate.id) continue;
      if (candidate.message?.role === "user" && !userMessageId) {
        userMessageId = candidate.id;
      }
      if (candidate.message?.role === "assistant") {
        assistantMessageId = candidate.id;
      }
    }

    return {
      sessionFile: this.sessionManager.getSessionFile(),
      userMessageId,
      assistantMessageId,
    };
  }

  /** Dump the full context the LLM sees: system prompt + conversation messages. */
  get messageCount(): number {
    return this.session.messages.length;
  }

  dumpContext(): string {
    const parts: string[] = [];

    parts.push("# LLM Context Dump\n");
    parts.push(`Generated: ${new Date().toISOString()}`);
    parts.push(`Sender: ${this.sender}\n`);

    // System prompt (assembled by SDK: constitution + interface protocol + AGENTS.md + boot preload + date/cwd)
    parts.push("---\n\n## System Prompt\n");
    parts.push("```");
    parts.push(this.session.systemPrompt);
    parts.push("```\n");

    // Conversation messages
    parts.push("## Messages\n");
    const messages = this.session.messages;
    if (messages.length === 0) {
      parts.push("_(no messages yet)_\n");
    } else {
      for (const msg of messages) {
        const m = msg as unknown as Record<string, unknown>;
        const role = (m.role as string) ?? (m.type as string) ?? "unknown";
        parts.push(`### ${role}\n`);
        if (m.content) {
          if (typeof m.content === "string") {
            parts.push("```");
            parts.push(m.content);
            parts.push("```\n");
          } else if (Array.isArray(m.content)) {
            for (const block of m.content as Array<Record<string, unknown>>) {
              if (block.type === "text" && typeof block.text === "string") {
                parts.push("```");
                parts.push(block.text);
                parts.push("```\n");
              } else if (block.type === "tool_use") {
                parts.push(`**tool_use**: \`${block.name as string}\``);
                parts.push("```json");
                parts.push(JSON.stringify(block.input, null, 2));
                parts.push("```\n");
              } else if (block.type === "tool_result") {
                parts.push(`**tool_result**: \`${block.toolCallId as string}\``);
                parts.push("```");
                const val = block.content ?? block.text ?? "";
                parts.push(typeof val === "string" ? val : JSON.stringify(val, null, 2));
                parts.push("```\n");
              } else {
                parts.push("```json");
                parts.push(JSON.stringify(block, null, 2));
                parts.push("```\n");
              }
            }
          }
        }
      }
    }

    return parts.join("\n");
  }

}

// ============================================================================
// Boot preload helpers
// ============================================================================

const BOOT_PRELOAD_TIMEOUT_MS = 10_000;
const BOOT_PRELOAD_MAX_CHARS = 12_000;
const DEFAULT_ORIENT_COMMAND = `python ${path.posix.join(SANDBOX_WORKSPACE_ROOT, ".agent", "orient.py")}`;
const LEGACY_AGENT_BOOT_COMMAND = `python ${path.posix.join(SANDBOX_WORKSPACE_ROOT, ".agent", "boot.py")}`;

interface WorkspaceBootSelection {
  enabled: boolean;
  source: "default" | "workspace";
}

function resolveWorkspaceBootSelection(record?: Pick<WorkspaceRecord, "boot">): WorkspaceBootSelection {
  if (!record) {
    return { enabled: false, source: "default" };
  }

  const boot = record.boot;
  if (!boot) {
    return { enabled: true, source: "default" };
  }

  return {
    enabled: boot.enabled !== false,
    source: "workspace",
  };
}

async function loadBootPromptLayer(
  executor: Executor,
  boot: WorkspaceBootSelection,
  sandboxCwd: string,
): Promise<string | undefined> {
  if (!boot.enabled) {
    return undefined;
  }

  const runtimeCwd = sandboxCwd;

  const tryCommand = async (command: string): Promise<string | undefined> => {
    try {
      const result = await executor.exec(command, { cwd: runtimeCwd, timeout: BOOT_PRELOAD_TIMEOUT_MS });
      if (result.code !== 0) {
        return undefined;
      }
      const combined = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      if (!combined) {
        return undefined;
      }
      return combined.length > BOOT_PRELOAD_MAX_CHARS
        ? `${combined.slice(0, BOOT_PRELOAD_MAX_CHARS)}\n\n[truncated by bridge]`
        : combined;
    } catch {
      return undefined;
    }
  };

  for (const command of [DEFAULT_ORIENT_COMMAND, LEGACY_AGENT_BOOT_COMMAND, LEGACY_BOOT_COMMAND]) {
    const result = await tryCommand(command);
    if (result) return result;
  }

  getLogger().warn("runner", "boot-preload-missing", "Boot preload skipped: no orientation script produced output", {
    source: boot.source,
  });
  return undefined;
}

// ============================================================================
// Session factory
// ============================================================================

export async function createSenderSession(
  sender: string,
  config: Config,
  options: {
    forceNew?: boolean;
    executor: Executor;
    piSelection?: { provider: string; model: string; thinkingLevel: PiThinkingLevel };
    workspaceRecord?: WorkspaceRecord;
    sessionWatchSink?: SessionWatchSink;
  },
): Promise<AgentRunner> {
  const effectiveWorkspacePath = options.workspaceRecord?.workspacePath ?? legacyWorkspacePath(sender);
  const userPaths = workspacePaths(config.projectsDir, effectiveWorkspacePath);
  const userDir = userPaths.root;
  const cwd = userPaths.coworkDir;
  const sessionDir = userPaths.sessionsDir;
  const agentsFilePath = userPaths.agentsFilePath;

  // Ensure directories exist
  await fs.mkdir(cwd, { recursive: true });
  await fs.mkdir(sessionDir, { recursive: true });

  // Auth — ANTHROPIC_API_KEY from env is picked up automatically
  const authStorage = AuthStorage.create();
  if (config.anthropicApiKey) {
    authStorage.setRuntimeApiKey("anthropic", config.anthropicApiKey);
  }

  const modelRegistry = ModelRegistry.inMemory(authStorage);

  const selectedProvider = options.piSelection?.provider ?? config.piProvider;
  const selectedModelName = options.piSelection?.model ?? config.piModel;
  const selectedThinkingLevel = options.piSelection?.thinkingLevel ?? config.piThinkingLevel;
  const model = modelRegistry.find(selectedProvider, selectedModelName);
  if (!model) {
    throw new Error(`Model not found: ${selectedProvider}/${selectedModelName}`);
  }

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: true },
    retry: { enabled: true, maxRetries: 3 },
  });

  const { executor } = options;
  const sandboxCwd = resolveSandboxCwd(config.sandboxCwd);
  await ensureSandboxStartupSelfCheck(sender, executor, sandboxCwd);

  // Try to continue most recent session, or create new
  // Note: SessionManager uses the bridge-side cwd for session file paths.
  // This is correct — session files live on the bridge's filesystem, not in the sandbox.
  let sessionManager: SessionManager;
  let isNewSession = false;
  try {
    const sessions = await SessionManager.list(cwd, sessionDir);
    if (!options.forceNew && sessions.length > 0) {
      sessionManager = SessionManager.open(sessions[0].path);
      getLogger().info("runner", "session-restored", `Restored session for ${sender}: ${sessions[0].path}`, {
        workspaceKey: sender,
        sessionFile: sessions[0].path,
      });
    } else {
      sessionManager = SessionManager.create(sandboxCwd, sessionDir);
      isNewSession = true;
      getLogger().info("runner", "session-created", `New session created for ${sender}`, {
        workspaceKey: sender,
      });
    }
  } catch {
    sessionManager = SessionManager.create(sandboxCwd, sessionDir);
    isNewSession = true;
  }

  // Load constitution, bridge-global interface protocol, the workspace's
  // primary transport addendum, and AGENTS.md content for SDK prompt assembly.
  const constitution = await loadConstitution(config.systemDir);
  const promptTransport = options.workspaceRecord?.primaryTransport ?? enabledTransportNames(config)[0];
  const interfaceProtocols = await loadInterfaceProtocols(
    config.systemDir,
    promptTransport,
  );

  let agentsContent: string;
  try {
    agentsContent = await fs.readFile(agentsFilePath, "utf8");
  } catch {
    try {
      agentsContent = await fs.readFile(path.join(userDir, "AGENTS.md"), "utf8");
    } catch {
      agentsContent = "# Agent Context\n\nThis is your own working space.";
    }
  }

  const bootSelection = resolveWorkspaceBootSelection(options.workspaceRecord);
  const bootPromptLayer = isNewSession
    ? await loadBootPromptLayer(executor, bootSelection, sandboxCwd)
    : undefined;

  const appendPromptLayers = [
    ...interfaceProtocols,
    ...(agentsContent.trim().length > 0 ? [agentsContent] : []),
    ...(bootPromptLayer ? [bootPromptLayer] : []),
  ];

  // Build ResourceLoader — SDK assembles the prompt from these layers:
  //   1. customPrompt (constitution) → identity, values
  //   2. appendSystemPrompt (bridge-global protocol + workspace primary-transport addendum + AGENTS.md content)
  //   3. contextFiles → intentionally empty; avoid leaking real workspace file paths into the prompt
  const resourceLoader: ResourceLoader = {
    getSystemPrompt: () => constitution || undefined,
    getAppendSystemPrompt: () => appendPromptLayers,
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    extendResources: () => {},
    reload: async () => {},
  };

  // The customTools path always carries the bridge-owned wait() tool and
  // overrides read/bash/edit/write by name inside the live session registry.
  const customTools = createCustomTools(sandboxCwd, executor);

  const { session } = await createAgentSession({
    cwd: sandboxCwd,
    model,
    thinkingLevel: selectedThinkingLevel,
    authStorage,
    modelRegistry,
    resourceLoader,
    customTools,
    sessionManager,
    settingsManager,
  });

  // Create runState and subscribe ONCE (Pattern 1)
  const runState: RunState = {
    ctx: null,
    queue: null,
    pendingTools: new Map(),
    responseText: "",
    waitCalled: false,
    stopReason: "stop",
    errorMessage: undefined,
    currentRunId: undefined,
  };

  session.subscribe((event: AgentSessionEvent) => {
    if (!runState.ctx || !runState.queue || !runState.currentRunId) return;

    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      publishWatchEvent(options.sessionWatchSink, sender, {
        type: "text_delta",
        runId: runState.currentRunId,
        delta: event.assistantMessageEvent.delta,
      });
      return;
    }

    if (event.type === "tool_execution_start") {
      runState.pendingTools.set(event.toolCallId, {
        toolName: event.toolName,
        startTime: Date.now(),
      });
      getLogger().info("runner", "tool-start", `Tool start: ${event.toolName}`, {
        correlationId: runState.ctx?.correlationId,
        workspaceKey: sender,
        toolName: event.toolName,
      });
      publishWatchEvent(options.sessionWatchSink, sender, {
        type: "tool_start",
        runId: runState.currentRunId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        summary: summarizeToolStart(event.toolName, event.args),
      });
    } else if (event.type === "tool_execution_end") {
      if (isSuccessfulWaitToolResult(event)) {
        runState.waitCalled = true;
      }
      const pending = runState.pendingTools.get(event.toolCallId);
      runState.pendingTools.delete(event.toolCallId);
      const dur = pending ? ((Date.now() - pending.startTime) / 1000).toFixed(1) : "?";
      getLogger().info("runner", event.isError ? "tool-error" : "tool-done", `Tool ${event.isError ? "error" : "done"}: ${event.toolName} (${dur}s)`, {
        correlationId: runState.ctx?.correlationId,
        workspaceKey: sender,
        toolName: event.toolName,
        durationSeconds: dur,
      });
      publishWatchEvent(options.sessionWatchSink, sender, {
        type: "tool_end",
        runId: runState.currentRunId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        preview: summarizeToolResult(event.result),
      });
    } else if (event.type === "message_end") {
      // Extract text from the final assistant message
      const msg = event.message;
      if (msg && "role" in msg && msg.role === "assistant" && "content" in msg) {
        const content = msg.content as Array<{ type: string; text?: string }>;
        const textParts = content
          .filter((c) => c.type === "text" && c.text)
          .map((c) => c.text!);
        if (textParts.length > 0) {
          runState.responseText = textParts.join("\n");
        }

        // Check for stop reason and error
        const anyMsg = msg as unknown as Record<string, unknown>;
        if (typeof anyMsg.stopReason === "string") {
          runState.stopReason = anyMsg.stopReason;
        }
        if (typeof anyMsg.errorMessage === "string") {
          runState.errorMessage = anyMsg.errorMessage;
        }
      }
    } else if (event.type === "compaction_start") {
      getLogger().warn("runner", "compaction-start", `Compaction started (${event.reason})`, {
        correlationId: runState.ctx?.correlationId,
        workspaceKey: sender,
        reason: event.reason,
      });
      publishWatchEvent(options.sessionWatchSink, sender, {
        type: "status",
        runId: runState.currentRunId,
        at: new Date().toISOString(),
        label: `Compaction started (${event.reason})`,
        level: "warn",
      });
    } else if (event.type === "compaction_end") {
      getLogger().info("runner", "compaction-end", `Compaction ended (${event.reason})`, {
        correlationId: runState.ctx?.correlationId,
        workspaceKey: sender,
        reason: event.reason,
        errorMessage: event.errorMessage,
      });
      publishWatchEvent(options.sessionWatchSink, sender, {
        type: "status",
        runId: runState.currentRunId,
        at: new Date().toISOString(),
        label: `Compaction ended (${event.reason})${event.errorMessage ? ` — ${event.errorMessage}` : ""}`,
        level: event.errorMessage ? "error" : "info",
      });
    } else if (event.type === "auto_retry_start") {
      getLogger().warn("runner", "auto-retry-start", `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`, {
        correlationId: runState.ctx?.correlationId,
        workspaceKey: sender,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: event.errorMessage,
      });
      publishWatchEvent(options.sessionWatchSink, sender, {
        type: "status",
        runId: runState.currentRunId,
        at: new Date().toISOString(),
        label: `Retry ${event.attempt}/${event.maxAttempts}: ${event.errorMessage}`,
        level: "warn",
      });
    }
  });

  return new AgentRunner(
    session,
    sessionManager,
    runState,
    sender,
    userDir,
    selectedProvider,
    selectedModelName,
    selectedThinkingLevel,
    options.sessionWatchSink,
  );
}
