/**
 * Bridge entry point.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConstitution, type RunInput, type RunResult } from "./runner.js";
import { defaultProjectsHostDir, loadConfig, type Config } from "./config.js";
import { DurableIngressQueue, type PendingInboundEntry } from "./inbox-queue.js";
import { createCorrelationId, getLogger, initializeLogger } from "./logger.js";
import { UserEventsManager } from "./events-manager.js";
import type { FiredScheduledEvent } from "./events.js";
import { deriveSuggestedWorkspacePath, UserProvisioner, type WorkspaceRecord } from "./provisioner.js";
import { resolveWorkspacePiSelection, SessionRouter } from "./session-router.js";
import {
  supportsMessageReferences,
  supportsOutboundReactions,
  type InboundMessage,
  type Transport,
  type TransportAttachment,
  type TransportName,
} from "./transport.js";
import { processAttachments, resolveOutboundPaths, modelSupportsVision } from "./attachments.js";
import { prepareOutboundChunks, type PreparedOutboundChunk } from "./outbound-delivery.js";
import { parseOutboundControl } from "./outbound-control.js";
import { DurableOutboundQueue } from "./outbox-queue.js";
import { SandboxManager, sandboxConfigFromEnv, detectHostMount } from "./sandbox.js";
import { codeServerLocalUrl, CodeServerManager } from "./code-server.js";
import { calendarPublicUrl } from "./calendar.js";
import { CalendarPublisher } from "./calendar-publisher.js";
import { SessionWatchServer } from "./session-watch.js";
import {
  isUserWhitelisted,
  resolveBridgeContainerIdentifier,
  resolveInboundAuthSender,
  resolveInboundBindingId,
  resolveOutboundRecipient,
  resolveOutboundTarget,
} from "./bridge-runtime.js";
import { createTransports } from "./transports/index.js";
import {
  applyWorkspaceDesiredState,
  formatWorkspaceControlReconcileResult,
  reconcileWorkspaceControlPlane,
} from "./workspace-control.js";
import { workspacePaths } from "./workspace-paths.js";
import { WorkspaceGitManager } from "./workspace-git.js";

export const HELP_TEXT = `Available commands:
!help            — show this message
!status          — show the workspace dashboard
!reset           — start a new session (clears conversation history)
!context         — send full LLM context as a file (system prompt + messages)

Advanced commands:
!reset-workspace — wipe workspace and re-provision from template ⚠️ destructive

Anything else is sent to the AI agent.`;

export interface TraceContext {
  correlationId: string;
  source: "inbound" | "scheduled";
}

export interface BridgeRuntimeDeps {
  trace?: TraceContext;
  inbox?: DurableIngressQueue;
  outbox?: DurableOutboundQueue;
  workspaceGit?: WorkspaceGitManager;
}

async function main(): Promise<void> {
  const config = loadConfig();
  initializeLogger(config.bridgeDataDir);
  const logger = getLogger();
  logger.info("bridge", "startup", "Starting bridge", {
    bridgeDataDir: config.bridgeDataDir,
    projectsDir: config.projectsDir,
    provider: config.piProvider,
    model: config.piModel,
    thinkingLevel: config.piThinkingLevel,
    accessMode: config.bridgeAccessMode,
  });

  const provisioner = new UserProvisioner(config.bridgeDataDir, config.projectsDir, config.blueprintDir, {
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

  const bridgeContainerId = resolveBridgeContainerIdentifier();
  const configuredBridgeDataHostDir = resolveConfiguredHostDir(config.bridgeDataHostDir, "BRIDGE_DATA_HOST_DIR");
  const configuredProjectsHostDir = resolveConfiguredHostDir(config.projectsHostDir, "PROJECTS_HOST_DIR");

  let bridgeDataHostDir = configuredBridgeDataHostDir;
  if (bridgeDataHostDir) {
    logger.info("bridge", "bridge-data-host-dir", `Bridge data host dir: ${bridgeDataHostDir}`, {
      bridgeDataHostDir,
    });
  } else {
    const detectedBridgeDataMount = await detectHostMount(bridgeContainerId, config.bridgeDataDir);
    if (detectedBridgeDataMount) {
      bridgeDataHostDir = detectedBridgeDataMount;
      logger.info("bridge", "bridge-data-host-dir-autodetect", `Auto-detected bridge data host dir: ${detectedBridgeDataMount}`, {
        bridgeDataHostDir: detectedBridgeDataMount,
      });
    }
  }

  let hostProjectsDir = configuredProjectsHostDir;
  if (hostProjectsDir) {
    logger.info("bridge", "projects-host-dir", `Projects host dir: ${hostProjectsDir}`, {
      projectsHostDir: hostProjectsDir,
    });
  } else if (configuredBridgeDataHostDir) {
    hostProjectsDir = defaultProjectsHostDir(configuredBridgeDataHostDir);
    logger.info("bridge", "projects-host-dir-derived", `Derived projects host dir from BRIDGE_DATA_HOST_DIR: ${hostProjectsDir}`, {
      projectsHostDir: hostProjectsDir,
    });
  } else {
    const directProjectsMount = await detectHostMount(bridgeContainerId, config.projectsDir);
    if (directProjectsMount) {
      hostProjectsDir = directProjectsMount;
      logger.info("bridge", "projects-host-dir-autodetect", `Auto-detected projects host dir: ${directProjectsMount}`, {
        projectsHostDir: directProjectsMount,
      });
    } else if (bridgeDataHostDir) {
      const resolvedBridgeDataDir = path.resolve(config.bridgeDataDir);
      const resolvedProjectsDir = path.resolve(config.projectsDir);
      if (resolvedProjectsDir === resolvedBridgeDataDir || resolvedProjectsDir.startsWith(resolvedBridgeDataDir + path.sep)) {
        const relativeProjects = path.relative(resolvedBridgeDataDir, resolvedProjectsDir);
        hostProjectsDir = relativeProjects ? path.join(bridgeDataHostDir, relativeProjects) : bridgeDataHostDir;
        logger.info("bridge", "projects-host-dir-derived-from-bridge", `Derived projects host dir from bridge data host dir: ${hostProjectsDir}`, {
          projectsHostDir: hostProjectsDir,
        });
      }
    }
    if (!hostProjectsDir) {
      logger.warn("bridge", "projects-host-dir-missing", "Could not determine projects host dir.", {});
      logger.warn("bridge", "projects-host-dir-guidance", "Set PROJECTS_HOST_DIR if bridge runs inside Docker.", {});
    }
  }

  if (!bridgeDataHostDir && hostProjectsDir) {
    const resolvedBridgeDataDir = path.resolve(config.bridgeDataDir);
    const resolvedProjectsDir = path.resolve(config.projectsDir);
    if (resolvedProjectsDir === resolvedBridgeDataDir || resolvedProjectsDir.startsWith(resolvedBridgeDataDir + path.sep)) {
      const relativeBridgeDataDir = path.relative(resolvedProjectsDir, resolvedBridgeDataDir);
      bridgeDataHostDir = relativeBridgeDataDir
        ? path.resolve(hostProjectsDir, relativeBridgeDataDir)
        : hostProjectsDir;
      logger.info("bridge", "bridge-data-host-dir-derived", `Derived bridge data host dir from projects host dir: ${bridgeDataHostDir}`, {
        bridgeDataHostDir,
      });
    }
  }

  if (!bridgeDataHostDir) {
    logger.warn("bridge", "bridge-data-host-dir-missing", "Could not determine bridge data host dir.", {});
    logger.warn("bridge", "bridge-data-host-dir-guidance", "Set BRIDGE_DATA_HOST_DIR if sibling containers need bridge-owned host mounts.", {});
  }

  config.bridgeDataHostDir = bridgeDataHostDir;
  config.projectsHostDir = hostProjectsDir;
  bridgeDataHostDir = bridgeDataHostDir || config.bridgeDataDir;
  hostProjectsDir = hostProjectsDir || config.projectsDir;

  const sandboxConfig = sandboxConfigFromEnv(config);
  const sandboxManager = new SandboxManager(sandboxConfig);
  await sandboxManager.validate();
  logger.info("bridge", "sandbox-ready", `Sandbox runtime ready: image=${sandboxConfig.image}, network=${sandboxConfig.network}`, {
    sandboxImage: sandboxConfig.image,
    sandboxNetwork: sandboxConfig.network,
  });

  const codeServerManager = new CodeServerManager(config.codeServer, hostProjectsDir, config.bridgeDataDir, {
    bridgeProjectsDir: config.projectsDir,
    bridgeDataHostDir,
  });
  await codeServerManager.validate();
  logger.info("bridge", "code-server-ready", `Code-server infrastructure ready: image=${config.codeServer.image}`, {
    codeServerImage: config.codeServer.image,
  });

  const calendarPublisher = new CalendarPublisher(config.calendar, provisioner);
  if (config.calendar.enabled) {
    await calendarPublisher.start();
    logger.info("bridge", "calendar-ready", `Calendar publisher ready: bind=${config.calendar.bindHost}:${config.calendar.port}, public=${config.calendar.publicBaseUrl ?? "(operator-provided)"}`, {
      bindHost: config.calendar.bindHost,
      port: config.calendar.port,
      publicBaseUrl: config.calendar.publicBaseUrl,
    });
  }

  const sessionWatchServer = new SessionWatchServer(
    config.sessionWatch ?? { enabled: false, bindHost: "127.0.0.1", port: 8791 },
    provisioner,
  );
  if (config.sessionWatch?.enabled) {
    await sessionWatchServer.start();
    logger.info("bridge", "session-watch-ready", `Session watch ready: bind=${config.sessionWatch.bindHost}:${config.sessionWatch.port}${config.sessionWatch.bindHost === "127.0.0.1" ? " (localhost-only)" : ""}`, {
      bindHost: config.sessionWatch.bindHost,
      port: config.sessionWatch.port,
    });
  }

  const workspaceGit = new WorkspaceGitManager(config.projectsDir);
  await workspaceGit.validate();
  logger.info("bridge", "workspace-git-ready", "Bridge-owned workspace git runtime ready", {});
  await workspaceGit.ensureProvisionedWorkspaces(provisioner.listWorkspaces());
  logger.info("bridge", "workspace-git-ensured", "Bridge-owned workspace git repos ensured for provisioned workspaces", {});

  const runtimeDeps: BridgeRuntimeDeps = {
    inbox: new DurableIngressQueue(config.bridgeDataDir),
    workspaceGit,
  };
  const routerRef: { current: SessionRouter | undefined } = { current: undefined };
  const handleMessage = async (
    workspaceKey: string,
    text: string,
    attachments?: TransportAttachment[],
    inbound?: InboundMessage,
    trace?: TraceContext,
  ): Promise<void> => {
    await handleMessageImpl(
      workspaceKey,
      text,
      attachments ?? [],
      config,
      transportMap,
      routerRef.current!,
      provisioner,
      codeServerManager,
      sandboxManager,
      inbound,
      { ...runtimeDeps, trace },
    );
  };

  const handleScheduledEvent = async (
    workspaceKey: string,
    fired: FiredScheduledEvent,
  ): Promise<void> => {
    await handleScheduledEventImpl(
      workspaceKey,
      fired,
      config,
      transportMap,
      routerRef.current!,
      provisioner,
      runtimeDeps,
    );
  };

  const eventsManager = new UserEventsManager(
    (workspaceKey, fn) => routerRef.current!.dispatch(workspaceKey, fn),
    handleScheduledEvent,
    (workspaceKey) => provisioner.getWorkspacePaths(workspaceKey),
  );
  const router = new SessionRouter(config, provisioner, eventsManager, sandboxManager, sessionWatchServer);
  routerRef.current = router;

  const configuredTransports = createTransports(config);
  const readyTransports: Transport[] = [];
  for (const transport of configuredTransports) {
    if (transport.name === "signal") {
      try {
        await transport.waitUntilReady();
        readyTransports.push(transport);
      } catch (err) {
        logger.error("bridge", "transport-start-failed", `${transport.name} failed to start`, {
          transportName: transport.name,
          error: err,
        });
      }
    } else {
      readyTransports.push(transport);
    }
  }

  if (readyTransports.length === 0) {
    throw new Error("No transports are ready");
  }

  const transportMap = new Map<TransportName, Transport>(
    readyTransports.map((transport) => [transport.name as TransportName, transport]),
  );
  runtimeDeps.outbox = new DurableOutboundQueue(config.bridgeDataDir, {
    resolveTransport: (transportName) => transportMap.get(transportName),
  });
  logger.info("bridge", "transports-ready", `transports:     ${readyTransports.map((t) => t.name).join(", ")}`, {
    transports: readyTransports.map((transport) => transport.name),
  });

  await reconcileSiblingContainers(config, provisioner, sandboxManager, codeServerManager, hostProjectsDir);

  let reconcileChain: Promise<void> = Promise.resolve();
  const queueReconcile = (resetRunners: boolean): Promise<void> => {
    const run = reconcileChain.then(async () => {
      const result = await reconcileWorkspaceControlPlane({
        config,
        provisioner,
        eventsManager,
        codeServerManager,
        router,
        resetRunners,
      });
      logger.info("bridge", "workspace-reconcile-complete", `Workspace reconcile${resetRunners ? " + reset-runners" : ""} complete\n${formatWorkspaceControlReconcileResult(result)}`, {
        resetRunners,
      });
    });
    reconcileChain = run.catch(() => undefined);
    return run;
  };

  await queueReconcile(false);
  await loadConstitution(config.systemDir);
  await runtimeDeps.outbox?.recoverPending();
  if (runtimeDeps.inbox) {
    await recoverPendingInboundEntries(runtimeDeps.inbox, router, handleMessage, logger);
  }

  for (const transport of readyTransports) {
    transport.listen((message: InboundMessage) => {
      void handleInboundMessage(message, config, transportMap, provisioner, router, codeServerManager, handleMessage, runtimeDeps);
    });
  }

  for (const transport of readyTransports) {
    if (transport.name === "nextcloud") {
      await transport.waitUntilReady();
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info("bridge", "shutdown", "Shutting down...");
    for (const transport of readyTransports) {
      transport.stop();
    }

    try {
      await eventsManager.stopAll();
    } catch (err) {
      logger.error("bridge", "shutdown-events-stop-failed", "Error stopping events watchers", { error: err });
    }

    try {
      await calendarPublisher.stop();
    } catch (err) {
      logger.error("bridge", "shutdown-calendar-stop-failed", "Error stopping calendar publisher", { error: err });
    }

    try {
      await sessionWatchServer.stop();
    } catch (err) {
      logger.error("bridge", "shutdown-session-watch-stop-failed", "Error stopping session watch", { error: err });
    }

    try {
      await codeServerManager.stopAll(Object.keys(provisioner.listWorkspaces()));
    } catch (err) {
      logger.error("bridge", "shutdown-code-server-stop-failed", "Error stopping code-server containers", { error: err });
    }

    try {
      await sandboxManager.stopAll();
    } catch (err) {
      logger.error("bridge", "shutdown-sandbox-stop-failed", "Error stopping sandbox containers", { error: err });
    }

    await logger.flush();
    process.exit(0);
  };

  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGHUP", () => {
    if (shuttingDown) return;
    logger.info("bridge", "signal-sighup", "Received SIGHUP — reconciling workspace control plane");
    void queueReconcile(false).catch((err) => {
      logger.error("bridge", "workspace-reconcile-failed", "Workspace reconcile failed", { error: err });
    });
  });
  process.on("SIGUSR1", () => {
    if (shuttingDown) return;
    logger.info("bridge", "signal-sigusr1", "Received SIGUSR1 — reconciling workspace control plane + reset-runners");
    void queueReconcile(true).catch((err) => {
      logger.error("bridge", "workspace-reconcile-reset-failed", "Workspace reconcile + reset-runners failed", { error: err });
    });
  });

  logger.info("bridge", "ready", "Ready — waiting for messages");
}

function workspaceDisplayName(record: WorkspaceRecord, workspaceKey: string): string {
  return record.label ?? record.workspacePath ?? workspaceKey;
}

function formatWorkspaceStatus(params: {
  workspaceKey: string;
  record: WorkspaceRecord;
  config: Config;
  router: SessionRouter;
}): string {
  const { workspaceKey, record, config, router } = params;
  const runner = router.getCachedRunner(workspaceKey);
  const piSelection = resolveWorkspacePiSelection({
    provider: config.piProvider,
    model: config.piModel,
    thinkingLevel: config.piThinkingLevel,
  }, record);

  const provider = runner?.modelProvider ?? piSelection.provider;
  const model = runner?.modelName ?? piSelection.model;
  const thinkingLevel = runner?.thinkingLevel ?? piSelection.thinkingLevel;
  const sessionLine = runner
    ? `Session: active · ${runner.messageCount} messages`
    : "Session: inactive";

  const lines = [
    `Workspace: ${workspaceDisplayName(record, workspaceKey)} (${workspaceKey})`,
    `Model: ${model} (${provider}) · thinking: ${thinkingLevel}`,
    sessionLine,
  ];

  const codeServer = record.codeServer;
  if (codeServer?.enabled && codeServer.password && codeServer.port) {
    lines.push(
      "",
      `Code editor: ${codeServerLocalUrl(config.codeServer.bindHost, codeServer.port)}`,
      `  Password: ${codeServer.password}`,
    );
  }

  if (record.calendar?.enabled) {
    const calendarUrl = record.calendar.token
      ? (config.calendar.publicBaseUrl
        ? calendarPublicUrl(config.calendar.publicBaseUrl, workspaceKey, record.calendar.token)
        : "(not configured — set CALENDAR_PUBLIC_BASE_URL)")
      : "(pending reconcile)";
    lines.push(
      "",
      "Calendar subscription:",
      `  ${calendarUrl}`,
    );
  }

  return lines.join("\n");
}

export async function handleInboundMessage(
  message: InboundMessage,
  config: Config,
  transportMap: Map<TransportName, Transport>,
  provisioner: UserProvisioner,
  router: SessionRouter,
  codeServerManager: CodeServerManager,
  handleMessage: (
    workspaceKey: string,
    text: string,
    attachments?: TransportAttachment[],
    inbound?: InboundMessage,
    trace?: TraceContext,
  ) => Promise<void>,
  deps: BridgeRuntimeDeps = {},
): Promise<void> {
  const logger = getLogger();
  const trace = deps.trace ?? { correlationId: createCorrelationId("inbound"), source: "inbound" as const };
  const transport = message.meta?.transport;
  if (!transport || !transportMap.has(transport)) {
    logger.warn("bridge", "inbound-transport-missing", "Ignoring inbound message without an enabled transport tag", {
      correlationId: trace.correlationId,
    });
    return;
  }

  const bindingId = resolveInboundBindingId(message);
  if (!bindingId) {
    logger.warn("bridge", "inbound-binding-missing", `Ignoring ${transport} inbound message without a binding id`, {
      correlationId: trace.correlationId,
      transportName: transport,
    });
    return;
  }

  let workspaceKey = provisioner.lookup(transport, bindingId);
  let record = workspaceKey ? provisioner.getWorkspace(workspaceKey) : undefined;

  if (!workspaceKey || !record) {
    if (config.bridgeAccessMode === "closed") {
      logger.info("bridge", "inbound-blocked-closed", `Blocked ${transport} sender ${bindingId} (not present in workspace.json)`, {
        correlationId: trace.correlationId,
        transportName: transport,
        bindingId,
      });
      return;
    }

    if (config.bridgeAccessMode === "pending") {
      const suggestedWorkspacePath = deriveSuggestedWorkspacePath(transport, message.meta);
      const label = resolveProvisioningLabel(transport, message.meta);
      const pending = await provisioner.ensurePendingRequest(transport, bindingId, {
        binding: resolveProvisioningBinding(transport, message, bindingId),
        ...(suggestedWorkspacePath ? { suggestedWorkspacePath } : {}),
        ...(label ? { label } : {}),
      });
      const transportRecipient = resolveOutboundRecipient(bindingId, message);
      const replyTarget = resolveOutboundTarget(message);
      await transportMap.get(transport)?.send(
        transportRecipient,
        "Your workspace request is pending admin approval.",
        { target: replyTarget },
      );
      logger.info("bridge", "workspace-pending-request", `Pending workspace request: ${pending.workspaceKey} <- ${transport}:${bindingId}`, {
        correlationId: trace.correlationId,
        workspaceKey: pending.workspaceKey,
        transportName: transport,
        bindingId,
      });
      return;
    }

    const suggestedWorkspacePath = deriveSuggestedWorkspacePath(transport, message.meta);
    const label = resolveProvisioningLabel(transport, message.meta);
    const provisioned = await provisioner.ensureProvisioned(transport, bindingId, {
      defaultCodeServerEnabled: config.workspaceDefaults.codeServerEnabled,
      defaultCalendarEnabled: config.workspaceDefaults.calendarEnabled,
      binding: resolveProvisioningBinding(transport, message, bindingId),
      ...(suggestedWorkspacePath ? { suggestedWorkspacePath } : {}),
      ...(label ? { label } : {}),
    });
    workspaceKey = provisioned.workspaceKey;
    record = provisioned.record;
    logger.info("bridge", "workspace-provisioned", `New workspace provisioned: ${workspaceKey} <- ${transport}:${bindingId}`, {
      correlationId: trace.correlationId,
      workspaceKey,
      transportName: transport,
      bindingId,
    });

    await applyWorkspaceDesiredState({
      workspaceKey,
      record,
      provisioner,
      codeServerManager,
    });
  }

  if (!workspaceKey || !record) {
    logger.warn("bridge", "workspace-unresolved", `Unable to resolve workspace for ${transport}:${bindingId}`, {
      correlationId: trace.correlationId,
      transportName: transport,
      bindingId,
    });
    return;
  }

  if (record.status === "pending") {
    const transportRecipient = resolveOutboundRecipient(bindingId, message);
    const replyTarget = resolveOutboundTarget(message);
    await transportMap.get(transport)?.send(
      transportRecipient,
      "Your workspace request is still pending admin approval.",
      { target: replyTarget },
    );
    await provisioner.updateLastSeen(workspaceKey);
    return;
  }

  const authSender = resolveInboundAuthSender(message);
  if (transport === "nextcloud") {
    const nextcloudBinding = record.transports.nextcloud;
    if (!isUserWhitelisted(authSender, nextcloudBinding?.userWhitelist)) {
      logger.info("bridge", "nextcloud-user-blocked", `Blocked Nextcloud actor ${authSender} in room ${bindingId} -> ${workspaceKey} (not in userWhitelist)`, {
        correlationId: trace.correlationId,
        workspaceKey,
        authSender,
        bindingId,
      });
      return;
    }
  }

  if (transport === "signal") {
    const signalBinding = record.transports.signal;
    if (signalBinding?.groupId && !isUserWhitelisted(authSender, signalBinding.userWhitelist)) {
      logger.info("bridge", "signal-user-blocked", `Blocked Signal participant ${authSender} in group ${bindingId} -> ${workspaceKey} (not in userWhitelist)`, {
        correlationId: trace.correlationId,
        workspaceKey,
        authSender,
        bindingId,
      });
      return;
    }
  }

  await provisioner.updateLastSeen(workspaceKey);

  const { text, attachments, kind = "message" } = message;
  const label = kind === "event" ? "Event" : "Message";
  const preview = text.slice(0, 80) + (text.length > 80 ? "..." : "");
  logger.info("bridge", "inbound-accepted", `${label} from ${transport}:${authSender} -> ${workspaceKey}: ${preview}${attachments.length > 0 ? ` (+${attachments.length} attachment${attachments.length > 1 ? "s" : ""})` : ""}`, {
    correlationId: trace.correlationId,
    workspaceKey,
    transportName: transport,
    authSender,
    attachmentCount: attachments.length,
    kind,
  });

  if (!deps.inbox) {
    router.dispatch(workspaceKey, () => handleMessage(workspaceKey, text, attachments, message, trace));
    return;
  }

  const queued = await deps.inbox.enqueue({
    correlationId: trace.correlationId,
    workspaceKey,
    message,
  });
  logger.info("bridge", "inbox-enqueued", "Inbound message enqueued durably", {
    correlationId: trace.correlationId,
    workspaceKey,
    entryId: queued.id,
  });

  router.dispatch(workspaceKey, async () => {
    try {
      await handleMessage(workspaceKey, text, attachments, message, trace);
      await deps.inbox?.delete(workspaceKey, queued.id);
      logger.info("bridge", "inbox-complete", "Inbound message completed and removed from inbox", {
        correlationId: trace.correlationId,
        workspaceKey,
        entryId: queued.id,
      });
    } catch (err) {
      logger.error("bridge", "inbox-processing-failed", "Queued inbound message failed", {
        correlationId: trace.correlationId,
        workspaceKey,
        entryId: queued.id,
        error: err,
      });
      throw err;
    }
  });
}

interface DeliveryParams {
  workspaceKey: string;
  sourceText: string;
  result: RunResult;
  runner: Awaited<ReturnType<SessionRouter["getOrCreate"]>>;
  transport: Transport;
  transportRecipient: string;
  replyTarget: string | undefined;
  outboundTransportName: TransportName;
  inbound?: InboundMessage;
}

export async function deliverRunnerResult(
  params: DeliveryParams,
  deps: BridgeRuntimeDeps = {},
): Promise<void> {
  const logger = getLogger();
  const {
    workspaceKey,
    sourceText,
    result,
    runner,
    transport,
    transportRecipient,
    replyTarget,
    outboundTransportName,
    inbound,
  } = params;

  const correlationId = deps.trace?.correlationId;
  const messageRefConversation = replyTarget ?? transportRecipient;

  if (
    inbound?.kind === "message"
    && outboundTransportName === "signal"
    && supportsMessageReferences(transport)
  ) {
    await transport.recordInboundMessageRef(
      messageRefConversation,
      inbound,
      result,
      sourceText,
    );
  }

  if (result.error) {
    await sendTransportText({
      workspaceKey,
      correlationId,
      transport,
      transportRecipient,
      text: `Error: ${result.error}`,
      replyTarget,
      outbox: deps.outbox,
    });
    return;
  }

  const outbound = parseOutboundControl(result.response, { waitCalled: result.waitCalled });

  if (outbound.silent) {
    logger.info("bridge", "silent-turn", `Silent turn suppressed for ${workspaceKey} via wait()`, {
      correlationId,
      workspaceKey,
    });
    return;
  }

  for (const reaction of outbound.reactions) {
    logger.info("bridge", "outbound-reaction-parsed", `Parsed outbound [REACT:${reaction.emoji} ${reaction.sessionMessageId}] for ${workspaceKey}`, {
      correlationId,
      workspaceKey,
      emoji: reaction.emoji,
      sessionMessageId: reaction.sessionMessageId,
    });
    if (!supportsOutboundReactions(transport)) {
      logger.info("bridge", "outbound-reaction-skipped", `Outbound reaction skipped (transport unsupported): ${reaction.emoji} -> ${reaction.sessionMessageId}`, {
        correlationId,
        workspaceKey,
        emoji: reaction.emoji,
        sessionMessageId: reaction.sessionMessageId,
      });
      continue;
    }
    try {
      const sent = await transport.sendReactionForSessionMessageId(
        messageRefConversation,
        reaction.sessionMessageId,
        reaction.emoji,
      );
      if (!sent) {
        logger.warn("bridge", "outbound-reaction-not-sent", `Outbound reaction not sent: ${reaction.emoji} -> ${reaction.sessionMessageId}`, {
          correlationId,
          workspaceKey,
          emoji: reaction.emoji,
          sessionMessageId: reaction.sessionMessageId,
        });
      }
    } catch (err) {
      logger.warn("bridge", "outbound-reaction-failed", `Outbound reaction failed: ${reaction.emoji} -> ${reaction.sessionMessageId}`, {
        correlationId,
        workspaceKey,
        emoji: reaction.emoji,
        sessionMessageId: reaction.sessionMessageId,
        error: err,
      });
    }
  }

  for (const attachmentPath of outbound.attachmentPaths) {
    logger.info("bridge", "outbound-attachment-parsed", `Parsed outbound [ATTACH:${attachmentPath}] for ${workspaceKey}`, {
      correlationId,
      workspaceKey,
      attachmentPath,
    });
  }

  const { validPaths, invalidPaths } = await resolveOutboundPaths(
    outbound.attachmentPaths,
    runner.userDir,
    runner.agentWorkspaceRoot,
  );

  for (const invalid of invalidPaths) {
    logger.warn("bridge", "outbound-attachment-skipped", `Outbound attachment skipped: ${invalid.path} — ${invalid.reason}`, {
      correlationId,
      workspaceKey,
      attachmentPath: invalid.path,
      reason: invalid.reason,
    });
  }

  const chunks = prepareOutboundChunks(transport, outbound.visibleText, validPaths, replyTarget);
  if (chunks.length === 0) {
    logger.info("bridge", "outbound-empty", `No outbound transport message for ${workspaceKey} after token parsing`, {
      correlationId,
      workspaceKey,
    });
    return;
  }

  await deliverPreparedChunks({
    workspaceKey,
    correlationId,
    transport,
    transportRecipient,
    chunks,
    outbox: deps.outbox,
    messageRefConversation: outboundTransportName === "signal" ? messageRefConversation : undefined,
    refs: outboundTransportName === "signal" ? result : undefined,
  });
}

export async function handleMessageImpl(
  workspaceKey: string,
  text: string,
  attachments: TransportAttachment[],
  config: Config,
  transportMap: Map<TransportName, Transport>,
  router: SessionRouter,
  provisioner: UserProvisioner,
  codeServerManager: CodeServerManager,
  sandboxManager: SandboxManager,
  inbound?: InboundMessage,
  deps: BridgeRuntimeDeps = {},
): Promise<void> {
  const record = provisioner.getWorkspace(workspaceKey);
  if (!record) {
    throw new Error(`Unknown workspace: ${workspaceKey}`);
  }

  const outboundTransportName = resolveOutboundTransportName(record, inbound);
  const transport = transportMap.get(outboundTransportName);
  if (!transport) {
    throw new Error(`Outbound transport ${outboundTransportName} is not enabled for ${workspaceKey}`);
  }

  const fallbackRecipient = resolveWorkspaceRecipient(record, outboundTransportName, workspaceKey);
  const fallbackTarget = resolveWorkspaceTarget(record, outboundTransportName);
  const transportRecipient = resolveOutboundRecipient(fallbackRecipient, inbound);
  const replyTarget = resolveOutboundTarget(inbound, fallbackTarget);
  const trimmed = text.trim();

  if (trimmed === "!help") {
    await sendTransportText({
      workspaceKey,
      correlationId: deps.trace?.correlationId,
      transport,
      transportRecipient,
      text: HELP_TEXT,
      replyTarget,
      outbox: deps.outbox,
    });
    return;
  }

  if (trimmed === "!reset") {
    await router.reset(workspaceKey);
    await sendTransportText({
      workspaceKey,
      correlationId: deps.trace?.correlationId,
      transport,
      transportRecipient,
      text: "Session reset. Starting fresh.",
      replyTarget,
      outbox: deps.outbox,
    });
    return;
  }

  if (trimmed === "!reset-silent") {
    await router.reset(workspaceKey);
    return;
  }

  if (trimmed === "!reset-workspace") {
    await sandboxManager.remove(workspaceKey);
    await provisioner.reprovision(workspaceKey);
    const refreshed = provisioner.getWorkspace(workspaceKey);
    if (refreshed?.codeServer?.enabled) {
      const access = await provisioner.ensureCodeServerAccess(workspaceKey);
      if (access?.password && access.port) {
        await codeServerManager.recreate(workspaceKey, refreshed.workspacePath, {
          password: access.password,
          port: access.port,
        }, refreshed.primaryTransport);
      }
    } else {
      await codeServerManager.stop(workspaceKey);
    }
    await router.reset(workspaceKey);
    await sendTransportText({
      workspaceKey,
      correlationId: deps.trace?.correlationId,
      transport,
      transportRecipient,
      text: "Workspace reset to factory defaults. ⚠️ All files and session history cleared.",
      replyTarget,
      outbox: deps.outbox,
    });
    return;
  }

  if (trimmed === "!status") {
    await sendTransportText({
      workspaceKey,
      correlationId: deps.trace?.correlationId,
      transport,
      transportRecipient,
      text: formatWorkspaceStatus({
        workspaceKey,
        record,
        config,
        router,
      }),
      replyTarget,
      outbox: deps.outbox,
    });
    return;
  }

  if (trimmed === "!context") {
    try {
      const runner = await router.getOrCreate(workspaceKey);
      const contextMd = runner.dumpContext();
      const paths = workspacePaths(config.projectsDir, record.workspacePath);
      const tmpFile = path.join(paths.coworkDir, `context-dump-${Date.now()}.md`);
      await fs.writeFile(tmpFile, contextMd, "utf8");
      await transport.send(transportRecipient, "Full LLM context attached.", {
        attachments: [tmpFile],
        target: replyTarget,
      });
      await fs.unlink(tmpFile).catch(() => {});
    } catch (err) {
      getLogger().error("bridge", "context-dump-failed", "!context error", {
        correlationId: deps.trace?.correlationId,
        workspaceKey,
        error: err,
      });
      await sendTransportText({
        workspaceKey,
        correlationId: deps.trace?.correlationId,
        transport,
        transportRecipient,
        text: "Failed to dump context.",
        replyTarget,
        outbox: deps.outbox,
      });
    }
    return;
  }

  let runCompleted = false;

  try {
    const runner = await router.getOrCreate(workspaceKey);

    const supportsVision = modelSupportsVision(runner.modelName);
    const attachmentResult = attachments.length > 0
      ? await processAttachments(
        attachments,
        runner.userDir,
        supportsVision,
        transport,
        transportRecipient,
        runner.agentWorkspaceRoot,
      )
      : { processed: [], preamble: "", images: [] };

    const input: RunInput = {
      text: attachmentResult.preamble + (text || "(no text, see attachments above)"),
      images: attachmentResult.images.map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      })),
    };

    const result = await runner.run({ sender: workspaceKey, correlationId: deps.trace?.correlationId }, input);
    runCompleted = true;

    await deliverRunnerResult({
      workspaceKey,
      sourceText: text,
      result,
      runner,
      transport,
      transportRecipient,
      replyTarget,
      outboundTransportName,
      inbound,
    }, deps);
  } catch (err) {
    getLogger().error("bridge", "agent-run-failed", `Error running agent for ${workspaceKey}`, {
      correlationId: deps.trace?.correlationId,
      workspaceKey,
      error: err,
    });
    try {
      await sendTransportText({
        workspaceKey,
        correlationId: deps.trace?.correlationId,
        transport,
        transportRecipient,
        text: `Sorry, an error occurred: ${err instanceof Error ? err.message : String(err)}`,
        replyTarget,
        outbox: deps.outbox,
      });
    } catch (sendError) {
      getLogger().error("bridge", "agent-run-error-send-failed", "Failed to send error message to transport", {
        correlationId: deps.trace?.correlationId,
        workspaceKey,
        error: sendError,
      });
    }
  } finally {
    if (runCompleted) {
      await commitWorkspaceRunSnapshot(workspaceKey, record.workspacePath, deps);
    }
  }
}

export async function handleScheduledEventImpl(
  workspaceKey: string,
  fired: FiredScheduledEvent,
  config: Config,
  transportMap: Map<TransportName, Transport>,
  router: SessionRouter,
  provisioner: UserProvisioner,
  deps: BridgeRuntimeDeps = {},
): Promise<void> {
  const record = provisioner.getWorkspace(workspaceKey);
  if (!record) {
    throw new Error(`Unknown workspace: ${workspaceKey}`);
  }

  const outboundTransportName = record.primaryTransport;
  const transport = transportMap.get(outboundTransportName);
  if (!transport) {
    throw new Error(`Outbound transport ${outboundTransportName} is not enabled for ${workspaceKey}`);
  }

  const transportRecipient = resolveWorkspaceRecipient(record, outboundTransportName, workspaceKey);
  const replyTarget = resolveWorkspaceTarget(record, outboundTransportName);

  const trace = deps.trace ?? { correlationId: createCorrelationId("event"), source: "scheduled" as const };

  let runCompleted = false;

  try {
    const runner = await router.getOrCreate(workspaceKey);
    const agentPath = `.events/${fired.filename}`;
    const result = await runner.runSyntheticRead(
      { sender: workspaceKey, correlationId: trace.correlationId },
      { path: agentPath, content: fired.rawContent },
    );
    runCompleted = true;

    await deliverRunnerResult({
      workspaceKey,
      sourceText: fired.event.text,
      result,
      runner,
      transport,
      transportRecipient,
      replyTarget,
      outboundTransportName,
    }, { ...deps, trace });
  } catch (err) {
    getLogger().error("bridge", "scheduled-event-failed", `Error running scheduled event for ${workspaceKey}`, {
      correlationId: trace.correlationId,
      workspaceKey,
      filename: fired.filename,
      error: err,
    });
    try {
      await sendTransportText({
        workspaceKey,
        correlationId: trace.correlationId,
        transport,
        transportRecipient,
        text: `Sorry, an error occurred: ${err instanceof Error ? err.message : String(err)}`,
        replyTarget,
        outbox: deps.outbox,
      });
    } catch (sendError) {
      getLogger().error("bridge", "scheduled-event-error-send-failed", "Failed to send scheduled-event error message to transport", {
        correlationId: trace.correlationId,
        workspaceKey,
        filename: fired.filename,
        error: sendError,
      });
    }
  } finally {
    if (runCompleted) {
      await commitWorkspaceRunSnapshot(workspaceKey, record.workspacePath, { ...deps, trace });
    }
  }
}

async function commitWorkspaceRunSnapshot(
  workspaceKey: string,
  workspacePath: string,
  deps: BridgeRuntimeDeps,
): Promise<void> {
  if (!deps.workspaceGit) return;

  const logger = getLogger();
  const source = deps.trace?.source === "scheduled" ? "scheduled" : "inbound";

  try {
    const committed = await deps.workspaceGit.commitCompletedRun(workspacePath, source);
    if (!committed) {
      logger.info("bridge", "workspace-git-noop", `Workspace git snapshot already clean for ${workspaceKey}`, {
        correlationId: deps.trace?.correlationId,
        workspaceKey,
        source,
      });
      return;
    }

    logger.info("bridge", "workspace-git-committed", `Workspace git snapshot committed for ${workspaceKey}`, {
      correlationId: deps.trace?.correlationId,
      workspaceKey,
      source,
    });
  } catch (err) {
    logger.error("bridge", "workspace-git-commit-failed", `Failed to commit workspace git snapshot for ${workspaceKey}`, {
      correlationId: deps.trace?.correlationId,
      workspaceKey,
      source,
      error: err,
    });
  }
}

async function sendTransportText(params: {
  workspaceKey: string;
  correlationId: string | undefined;
  transport: Transport;
  transportRecipient: string;
  text: string;
  replyTarget?: string;
  outbox?: DurableOutboundQueue;
}): Promise<void> {
  const { workspaceKey, correlationId, transport, transportRecipient, text, replyTarget, outbox } = params;
  if (!outbox) {
    await transport.send(transportRecipient, text, { target: replyTarget });
    return;
  }
  const chunks = prepareOutboundChunks(transport, text, [], replyTarget);
  await deliverPreparedChunks({
    workspaceKey,
    correlationId,
    transport,
    transportRecipient,
    chunks,
    outbox,
  });
}

async function deliverPreparedChunks(params: {
  workspaceKey: string;
  correlationId: string | undefined;
  transport: Transport;
  transportRecipient: string;
  chunks: PreparedOutboundChunk[];
  outbox?: DurableOutboundQueue;
  messageRefConversation?: string;
  refs?: Pick<RunResult, "sessionFile" | "userMessageId" | "assistantMessageId">;
}): Promise<void> {
  const logger = getLogger();
  const { workspaceKey, correlationId, transport, transportRecipient, chunks, outbox, messageRefConversation, refs } = params;
  if (chunks.length === 0) {
    logger.info("bridge", "outbound-empty", `No outbound transport message for ${workspaceKey}`, {
      correlationId,
      workspaceKey,
    });
    return;
  }

  if (!outbox) {
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const sendResult = await transport.send(transportRecipient, chunk.text, chunk.options);
      if (transport.name === "signal" && messageRefConversation && supportsMessageReferences(transport) && refs) {
        await transport.recordOutboundMessageRef(
          messageRefConversation,
          refs,
          chunk.text,
          sendResult,
          i,
          chunks.length,
        );
      }
    }
    return;
  }

  await outbox.enqueue({
    correlationId: correlationId ?? createCorrelationId("outbound"),
    workspaceKey,
    transportName: transport.name as TransportName,
    recipient: transportRecipient,
    chunks,
    ...(messageRefConversation ? { messageRefConversation } : {}),
    ...(refs ? { refs } : {}),
  });
}

async function recoverPendingInboundEntries(
  inbox: DurableIngressQueue,
  router: SessionRouter,
  handleMessage: (
    workspaceKey: string,
    text: string,
    attachments?: TransportAttachment[],
    inbound?: InboundMessage,
    trace?: TraceContext,
  ) => Promise<void>,
  logger = getLogger(),
): Promise<void> {
  const entries = await inbox.list();
  if (entries.length === 0) {
    return;
  }

  logger.info("bridge", "inbox-recovery-start", `Recovering ${entries.length} pending inbox entr${entries.length === 1 ? "y" : "ies"}`, {
    pendingCount: entries.length,
  });

  for (const entry of entries) {
    replayPendingInboundEntry(entry, inbox, router, handleMessage, logger);
  }
}

function replayPendingInboundEntry(
  entry: PendingInboundEntry,
  inbox: DurableIngressQueue,
  router: SessionRouter,
  handleMessage: (
    workspaceKey: string,
    text: string,
    attachments?: TransportAttachment[],
    inbound?: InboundMessage,
    trace?: TraceContext,
  ) => Promise<void>,
  logger = getLogger(),
): void {
  const trace: TraceContext = { correlationId: entry.correlationId, source: "inbound" };
  router.dispatch(entry.workspaceKey, async () => {
    try {
      await handleMessage(entry.workspaceKey, entry.message.text, entry.message.attachments, entry.message, trace);
      await inbox.delete(entry.workspaceKey, entry.id);
      logger.info("bridge", "inbox-recovery-complete", "Recovered inbox entry completed", {
        correlationId: entry.correlationId,
        workspaceKey: entry.workspaceKey,
        entryId: entry.id,
      });
    } catch (err) {
      logger.error("bridge", "inbox-recovery-failed", "Recovered inbox entry failed", {
        correlationId: entry.correlationId,
        workspaceKey: entry.workspaceKey,
        entryId: entry.id,
        error: err,
      });
    }
  });
}

function resolveOutboundTransportName(record: WorkspaceRecord, inbound?: InboundMessage): TransportName {
  if (inbound?.meta?.transport === "signal" || inbound?.meta?.transport === "nextcloud") {
    return inbound.meta.transport;
  }
  return record.primaryTransport;
}

function resolveWorkspaceRecipient(
  record: WorkspaceRecord,
  transport: TransportName,
  workspaceKey: string,
): string {
  if (transport === "signal") {
    return record.transports.signal?.sender ?? record.transports.signal?.groupId ?? workspaceKey;
  }
  return record.transports.nextcloud?.roomToken ?? workspaceKey;
}

function resolveWorkspaceTarget(record: WorkspaceRecord, transport: TransportName): string | undefined {
  if (transport === "signal") {
    return record.transports.signal?.groupId;
  }
  if (transport === "nextcloud") {
    return record.transports.nextcloud?.roomToken;
  }
  return undefined;
}

function resolveProvisioningLabel(
  transport: TransportName,
  meta: InboundMessage["meta"] | undefined,
): string | undefined {
  if (transport === "nextcloud" && typeof meta?.roomName === "string") {
    return meta.roomName.trim() || undefined;
  }
  if (transport === "signal" && typeof meta?.groupName === "string") {
    return meta.groupName.trim() || undefined;
  }
  return undefined;
}

function resolveProvisioningBinding(
  transport: TransportName,
  message: InboundMessage,
  bindingId: string,
): WorkspaceRecord["transports"][TransportName] | undefined {
  if (transport === "signal") {
    const groupId = typeof message.meta?.groupId === "string" && message.meta.groupId
      ? message.meta.groupId
      : undefined;
    if (groupId) {
      return { groupId, userWhitelist: [] };
    }
    return { sender: bindingId };
  }

  if (transport === "nextcloud") {
    return { roomToken: bindingId, userWhitelist: [] };
  }

  return undefined;
}

async function reconcileSiblingContainers(
  _config: Config,
  provisioner: UserProvisioner,
  sandboxManager: SandboxManager,
  codeServerManager: CodeServerManager,
  hostProjectsDir: string,
): Promise<void> {
  const registry = provisioner.listWorkspaces();
  const workspaceKeys = Object.keys(registry);
  await sandboxManager.reconcileExisting(hostProjectsDir, registry);
  await codeServerManager.reconcileExisting(workspaceKeys, registry);
}

function resolveConfiguredHostDir(value: string | undefined, envName: string): string | undefined {
  if (!value) return undefined;
  if (path.isAbsolute(value)) return value;
  getLogger().warn("bridge", "host-dir-invalid", `Ignoring ${envName} because it is not an absolute host path: ${value}`, {
    envName,
    value,
  });
  return undefined;
}

function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return !!entry && path.resolve(entry) === fileURLToPath(moduleUrl);
}

if (isEntrypoint(import.meta.url)) {
  main().catch(async (err: unknown) => {
    getLogger().error("bridge", "fatal", "Fatal", { error: err });
    await getLogger().flush().catch(() => undefined);
    process.exit(1);
  });
}
