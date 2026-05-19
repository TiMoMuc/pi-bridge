/**
 * Per-workspace AgentRunner cache with message serialization.
 */

import * as fs from "node:fs/promises";
import { getModel, type KnownProvider } from "@earendil-works/pi-ai";
import { parsePiThinkingLevel, type Config, type PiThinkingLevel } from "./config.js";
import { getLogger } from "./logger.js";
import { normalizeOptionalString, type UserProvisioner, type WorkspaceRecord } from "./provisioner.js";
import type { UserEventsManager } from "./events-manager.js";
import { type AgentRunner, createSenderSession } from "./runner.js";
import type { SandboxManager, Executor } from "./sandbox.js";
import type { SessionWatchSink } from "./session-watch.js";
import { legacyWorkspacePath, workspacePaths } from "./workspace-paths.js";
import { resolveSandboxNetworkName } from "./workspace-capabilities.js";

interface WorkspaceModelSelection {
  provider: string;
  model: string;
  source: "default" | "workspace";
  fallbackReason?: "incomplete" | "invalid";
  requestedProvider?: string;
  requestedModel?: string;
}

interface WorkspaceThinkingSelection {
  thinkingLevel: PiThinkingLevel;
  source: "default" | "workspace";
  fallbackReason?: "invalid";
  requestedThinkingLevel?: string;
}

export interface WorkspacePiSelection {
  provider: string;
  model: string;
  thinkingLevel: PiThinkingLevel;
  modelSource: WorkspaceModelSelection["source"];
  modelFallbackReason?: WorkspaceModelSelection["fallbackReason"];
  requestedProvider?: string;
  requestedModel?: string;
  thinkingSource: WorkspaceThinkingSelection["source"];
  thinkingFallbackReason?: WorkspaceThinkingSelection["fallbackReason"];
  requestedThinkingLevel?: string;
}

function resolveWorkspaceModelSelection(
  defaultProvider: string,
  defaultModel: string,
  record?: Pick<WorkspaceRecord, "piProvider" | "piModel">,
): WorkspaceModelSelection {
  const requestedProvider = normalizeOptionalString(record?.piProvider);
  const requestedModel = normalizeOptionalString(record?.piModel);

  if (!requestedProvider && !requestedModel) {
    return { provider: defaultProvider, model: defaultModel, source: "default" };
  }

  if (!requestedProvider || !requestedModel) {
    return {
      provider: defaultProvider,
      model: defaultModel,
      source: "default",
      fallbackReason: "incomplete",
      requestedProvider,
      requestedModel,
    };
  }

  if (!getModel(requestedProvider as KnownProvider, requestedModel as never)) {
    return {
      provider: defaultProvider,
      model: defaultModel,
      source: "default",
      fallbackReason: "invalid",
      requestedProvider,
      requestedModel,
    };
  }

  return {
    provider: requestedProvider,
    model: requestedModel,
    source: "workspace",
    requestedProvider,
    requestedModel,
  };
}

function resolveWorkspaceThinkingSelection(
  defaultThinkingLevel: PiThinkingLevel,
  record?: Pick<WorkspaceRecord, "piThinkingLevel">,
): WorkspaceThinkingSelection {
  const requestedThinkingLevel = normalizeOptionalString(record?.piThinkingLevel);

  if (!requestedThinkingLevel) {
    return { thinkingLevel: defaultThinkingLevel, source: "default" };
  }

  try {
    return {
      thinkingLevel: parsePiThinkingLevel(requestedThinkingLevel),
      source: "workspace",
      requestedThinkingLevel,
    };
  } catch {
    return {
      thinkingLevel: defaultThinkingLevel,
      source: "default",
      fallbackReason: "invalid",
      requestedThinkingLevel,
    };
  }
}

export function resolveWorkspacePiSelection(
  defaults: { provider: string; model: string; thinkingLevel: PiThinkingLevel },
  record?: Pick<WorkspaceRecord, "piProvider" | "piModel" | "piThinkingLevel">,
): WorkspacePiSelection {
  const modelSelection = resolveWorkspaceModelSelection(defaults.provider, defaults.model, record);
  const thinkingSelection = resolveWorkspaceThinkingSelection(defaults.thinkingLevel, record);

  return {
    provider: modelSelection.provider,
    model: modelSelection.model,
    thinkingLevel: thinkingSelection.thinkingLevel,
    modelSource: modelSelection.source,
    modelFallbackReason: modelSelection.fallbackReason,
    requestedProvider: modelSelection.requestedProvider,
    requestedModel: modelSelection.requestedModel,
    thinkingSource: thinkingSelection.source,
    thinkingFallbackReason: thinkingSelection.fallbackReason,
    requestedThinkingLevel: thinkingSelection.requestedThinkingLevel,
  };
}

interface SessionRouterDeps {
  createSession?: typeof createSenderSession;
}

export class SessionRouter {
  private runners = new Map<string, AgentRunner>();
  private queues = new Map<string, Promise<void>>();
  private active = new Set<string>();
  private readonly createSession: typeof createSenderSession;

  constructor(
    private readonly config: Config,
    private readonly provisioner: UserProvisioner,
    private readonly eventsManager: UserEventsManager,
    private readonly sandboxManager: SandboxManager,
    private readonly sessionWatchSink?: SessionWatchSink,
    deps: SessionRouterDeps = {},
  ) {
    this.createSession = deps.createSession ?? createSenderSession;
  }

  async getOrCreate(workspaceKey: string): Promise<AgentRunner> {
    const existing = this.runners.get(workspaceKey);
    if (existing) return existing;

    const record = this.provisioner.getWorkspace(workspaceKey);
    if (!record) {
      throw new Error(`Unknown workspace: ${workspaceKey}`);
    }

    const executor = await this.getExecutor(workspaceKey);
    const piSelection = resolveWorkspacePiSelection({
      provider: this.config.piProvider,
      model: this.config.piModel,
      thinkingLevel: this.config.piThinkingLevel,
    }, record);

    const runner = await this.createSession(workspaceKey, this.config, {
      executor,
      piSelection,
      workspaceRecord: record,
      sessionWatchSink: this.sessionWatchSink,
    });
    this.runners.set(workspaceKey, runner);
    this.eventsManager.startForUser(workspaceKey);
    this.logPiSelection(workspaceKey, piSelection);
    getLogger().info("router", "session-created", `Session created for ${workspaceKey}`, { workspaceKey });
    return runner;
  }

  dispatch(workspaceKey: string, fn: () => Promise<void>): void {
    const current = this.queues.get(workspaceKey) ?? Promise.resolve();
    const next = current.then(async () => {
      this.active.add(workspaceKey);
      try {
        await fn();
      } finally {
        this.active.delete(workspaceKey);
      }
    }).catch((err) => {
      getLogger().error("router", "dispatch-error", `Error handling message for ${workspaceKey}`, {
        workspaceKey,
        error: err,
      });
    });
    this.queues.set(workspaceKey, next);
  }

  async reset(workspaceKey: string): Promise<AgentRunner> {
    this.runners.delete(workspaceKey);

    const executor = await this.getExecutor(workspaceKey);
    const record = this.provisioner.getWorkspace(workspaceKey);
    if (!record) {
      throw new Error(`Unknown workspace: ${workspaceKey}`);
    }
    const piSelection = resolveWorkspacePiSelection({
      provider: this.config.piProvider,
      model: this.config.piModel,
      thinkingLevel: this.config.piThinkingLevel,
    }, record);

    const runner = await this.createSession(workspaceKey, this.config, {
      forceNew: true,
      executor,
      piSelection,
      workspaceRecord: record,
      sessionWatchSink: this.sessionWatchSink,
    });
    this.runners.set(workspaceKey, runner);
    this.logPiSelection(workspaceKey, piSelection);
    getLogger().info("router", "session-reset", `Session reset for ${workspaceKey}`, { workspaceKey });
    return runner;
  }

  knownSenders(): string[] {
    return [...this.runners.keys()];
  }

  getCachedRunner(workspaceKey: string): AgentRunner | undefined {
    return this.runners.get(workspaceKey);
  }

  isActive(workspaceKey: string): boolean {
    return this.active.has(workspaceKey);
  }

  async reconcileWorkspacePiSelections(resetRunners: boolean): Promise<{
    changed: string[];
    reset: string[];
    skippedActive: string[];
  }> {
    const changed: string[] = [];
    const reset: string[] = [];
    const skippedActive: string[] = [];

    for (const [workspaceKey, runner] of this.runners) {
      const record = this.provisioner.getWorkspace(workspaceKey);
      const selection = resolveWorkspacePiSelection({
        provider: this.config.piProvider,
        model: this.config.piModel,
        thinkingLevel: this.config.piThinkingLevel,
      }, record);
      const same = runner.modelProvider === selection.provider
        && runner.modelName === selection.model
        && runner.thinkingLevel === selection.thinkingLevel;
      if (same) continue;

      changed.push(workspaceKey);
      if (!resetRunners) continue;
      if (this.isActive(workspaceKey)) {
        skippedActive.push(workspaceKey);
        continue;
      }

      await this.reset(workspaceKey);
      reset.push(workspaceKey);
    }

    return { changed, reset, skippedActive };
  }

  private logPiSelection(workspaceKey: string, selection: WorkspacePiSelection): void {
    if (selection.modelSource === "workspace") {
      getLogger().info("router", "workspace-model-override", `Workspace model override for ${workspaceKey}: ${selection.provider}/${selection.model}`, {
        workspaceKey,
        provider: selection.provider,
        model: selection.model,
      });
    } else if (selection.modelFallbackReason === "incomplete") {
      getLogger().warn(
        "router",
        "workspace-model-override-incomplete",
        `Incomplete workspace model override for ${workspaceKey} (provider=${selection.requestedProvider ?? "missing"}, model=${selection.requestedModel ?? "missing"}); falling back to ${selection.provider}/${selection.model}`,
        {
          workspaceKey,
          requestedProvider: selection.requestedProvider,
          requestedModel: selection.requestedModel,
          provider: selection.provider,
          model: selection.model,
        },
      );
    } else if (selection.modelFallbackReason === "invalid") {
      getLogger().warn(
        "router",
        "workspace-model-override-invalid",
        `Invalid workspace model override for ${workspaceKey}: ${selection.requestedProvider}/${selection.requestedModel}; falling back to ${selection.provider}/${selection.model}`,
        {
          workspaceKey,
          requestedProvider: selection.requestedProvider,
          requestedModel: selection.requestedModel,
          provider: selection.provider,
          model: selection.model,
        },
      );
    }

    if (selection.thinkingSource === "workspace") {
      getLogger().info("router", "workspace-thinking-override", `Workspace thinking override for ${workspaceKey}: ${selection.thinkingLevel}`, {
        workspaceKey,
        thinkingLevel: selection.thinkingLevel,
      });
      return;
    }

    if (selection.thinkingFallbackReason === "invalid") {
      getLogger().warn(
        "router",
        "workspace-thinking-override-invalid",
        `Invalid workspace thinking override for ${workspaceKey}: ${selection.requestedThinkingLevel}; falling back to ${selection.thinkingLevel}`,
        {
          workspaceKey,
          requestedThinkingLevel: selection.requestedThinkingLevel,
          thinkingLevel: selection.thinkingLevel,
        },
      );
    }
  }

  private async getExecutor(workspaceKey: string): Promise<Executor> {
    const sandboxId = workspaceKey;

    const record = this.provisioner.getWorkspace(workspaceKey);
    if (!record) {
      throw new Error(`Unknown workspace: ${workspaceKey}`);
    }

    const workspacePath = record.workspacePath ?? legacyWorkspacePath(workspaceKey);
    const bridgePaths = workspacePaths(this.config.projectsDir, workspacePath);
    const hostBase = this.config.projectsHostDir || this.config.projectsDir;
    const hostPaths = workspacePaths(hostBase, workspacePath);

    if (record.provisionedAt) {
      try {
        const stat = await fs.stat(bridgePaths.root);
        if (!stat.isDirectory()) {
          throw new Error(`Workspace root is not a directory: ${bridgePaths.root}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Workspace ${workspaceKey} is marked provisioned but its root is missing at ${bridgePaths.root}; refusing to recreate it automatically (${reason})`,
        );
      }
    }

    await Promise.all([
      fs.mkdir(bridgePaths.coworkDir, { recursive: true }),
      fs.mkdir(bridgePaths.bridgeDir, { recursive: true }),
      fs.mkdir(bridgePaths.uploadDir, { recursive: true }),
    ]);

    return this.sandboxManager.getOrCreateExecutor(
      sandboxId,
      hostPaths.root,
      record.primaryTransport,
      resolveSandboxNetworkName(this.config.sandboxNetwork, workspaceKey, record.capabilities),
    );
  }
}
