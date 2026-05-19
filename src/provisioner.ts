/**
 * Provisions new workspaces on first contact and maintains the bridge-owned
 * workspace registry plus the in-memory reverse index used on the inbound hot path.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type CalendarConfig,
  type CodeServerConfig,
  type PiThinkingLevel,
  type WorkspaceDefaultsConfig,
} from "./config.js";
import type { InboundMessageMeta, TransportName } from "./transport.js";
import {
  allocateUniqueWorkspacePath,
  legacyWorkspacePath,
  normalizeWorkspacePath,
  slugifyWorkspacePathComponent,
  workspacePaths,
  workspaceRegistryPath,
} from "./workspace-paths.js";
import {
  defaultWorkspaceCapabilitiesRecord,
  normalizeWorkspaceCapabilitiesRecord,
  workspaceCapabilitiesShapeComplete,
  type WorkspaceCapabilitiesRecord,
} from "./workspace-capabilities.js";
import { WorkspaceGitManager } from "./workspace-git.js";

export const LEGACY_BOOT_COMMAND = "python /workspace/boot.py";

export interface SignalTransportBinding {
  sender?: string;
  groupId?: string;
  userWhitelist?: string[];
}

export interface NextcloudTransportBinding {
  roomToken: string;
  userWhitelist?: string[];
}

export interface CodeServerRecord {
  enabled: boolean;
  password?: string;
  port?: number;
}

export interface CalendarRecord {
  enabled: boolean;
  token?: string;
  name?: string;
}

interface BootRecord {
  enabled: boolean;
}

type WorkspaceStatus = "active" | "pending";

export interface WorkspaceRecord {
  createdAt: string;
  lastSeen: string;
  status: WorkspaceStatus;
  workspacePath: string;
  provisionedAt?: string;
  label?: string;
  primaryTransport: TransportName;
  transports: Partial<{
    signal: SignalTransportBinding;
    nextcloud: NextcloudTransportBinding;
  }>;
  codeServer?: CodeServerRecord;
  calendar?: CalendarRecord;
  boot?: BootRecord;
  capabilities?: WorkspaceCapabilitiesRecord;
  /** Preserved for legacy workspace.json compatibility; ignored by current runtime. */
  experimental?: Record<string, unknown>;
  piProvider?: string;
  piModel?: string;
  piThinkingLevel?: string;
}

export interface EnsureProvisionedResult {
  workspaceKey: string;
  record: WorkspaceRecord;
  isNew: boolean;
}

export function deriveSuggestedWorkspacePath(
  transport: TransportName,
  meta: InboundMessageMeta | undefined,
): string | undefined {
  if (transport === "nextcloud") {
    const roomName = typeof meta?.roomName === "string" ? meta.roomName : undefined;
    return roomName ? slugifyWorkspacePathComponent(roomName, "room") : undefined;
  }

  if (transport === "signal") {
    const groupName = typeof meta?.groupName === "string" ? meta.groupName : undefined;
    return groupName ? slugifyWorkspacePathComponent(groupName, "group") : undefined;
  }

  return undefined;
}

interface UserProvisionerOptions {
  codeServer?: Pick<CodeServerConfig, "bindHost" | "portStart">;
  calendar?: Pick<CalendarConfig, "enabled" | "bindHost" | "port" | "publicBaseUrl">;
  workspaceDefaults?: WorkspaceDefaultsConfig;
  modelDefaults?: {
    provider: string;
    model: string;
    thinkingLevel?: PiThinkingLevel;
  };
}

export class UserProvisioner {
  private registry: Record<string, WorkspaceRecord> = {};
  private reverseIndex = new Map<string, string>();
  private initialized = false;
  private initializePromise: Promise<void> | undefined;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly projectsDir: string;
  private readonly blueprintDir: string;
  private readonly options: UserProvisionerOptions;
  private readonly workspaceGit: WorkspaceGitManager;

  constructor(
    private readonly bridgeDataDir: string,
    projectsDirOrBlueprintDir: string,
    blueprintDirOrOptions: string | UserProvisionerOptions = projectsDirOrBlueprintDir,
    options: UserProvisionerOptions = {},
  ) {
    if (typeof blueprintDirOrOptions === "string") {
      this.projectsDir = projectsDirOrBlueprintDir;
      this.blueprintDir = blueprintDirOrOptions;
      this.options = options;
    } else {
      this.projectsDir = bridgeDataDir;
      this.blueprintDir = projectsDirOrBlueprintDir;
      this.options = blueprintDirOrOptions;
    }
    this.workspaceGit = new WorkspaceGitManager(this.projectsDir);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializePromise) {
      this.initializePromise = this.reload();
    }
    await this.initializePromise;
  }

  async reload(): Promise<void> {
    const registry = await this.loadRegistryFromDisk();
    const reverseIndex = buildReverseIndex(registry);
    this.registry = registry;
    this.reverseIndex = reverseIndex;
    this.initialized = true;
  }

  lookup(transport: TransportName, senderId: string): string | undefined {
    return this.reverseIndex.get(bindingLookupKey(transport, senderId));
  }

  getWorkspace(workspaceKey: string): WorkspaceRecord | undefined {
    const record = this.registry[workspaceKey];
    return record ? cloneWorkspaceRecord(record) : undefined;
  }

  async getWorkspaceLive(workspaceKey: string): Promise<WorkspaceRecord | undefined> {
    await this.initialize();
    await this.mutationChain;
    const registry = await this.loadRegistryFromDisk();
    const record = registry[workspaceKey];
    return record ? cloneWorkspaceRecord(record) : undefined;
  }

  listWorkspaces(): Record<string, WorkspaceRecord> {
    return Object.fromEntries(
      Object.entries(this.registry).map(([key, record]) => [key, cloneWorkspaceRecord(record)]),
    );
  }

  getBinding(workspaceKey: string, transport: TransportName): SignalTransportBinding | NextcloudTransportBinding | undefined {
    const record = this.registry[workspaceKey];
    const binding = record?.transports?.[transport];
    return binding ? structuredClone(binding) : undefined;
  }

  getWorkspaceRoot(workspaceKey: string): string | undefined {
    const record = this.registry[workspaceKey];
    if (!record) return undefined;
    return workspacePaths(this.projectsDir, record.workspacePath).root;
  }

  getWorkspacePaths(workspaceKey: string) {
    const record = this.registry[workspaceKey];
    if (!record) return undefined;
    return workspacePaths(this.projectsDir, record.workspacePath);
  }

  async ensurePendingRequest(
    transport: TransportName,
    senderId: string,
    options: {
      binding?: SignalTransportBinding | NextcloudTransportBinding;
      suggestedWorkspacePath?: string;
      label?: string;
    } = {},
  ): Promise<EnsureProvisionedResult> {
    await this.initialize();

    const existing = this.lookup(transport, senderId);
    if (existing) {
      const record = this.getWorkspace(existing);
      if (!record) throw new Error(`Workspace ${existing} vanished from cache during lookup`);
      return { workspaceKey: existing, record, isNew: false };
    }

    return this.withRegistryLock(async () => {
      const cached = this.lookup(transport, senderId);
      if (cached) {
        const record = this.getWorkspace(cached);
        if (!record) throw new Error(`Workspace ${cached} vanished from cache during lookup`);
        return { workspaceKey: cached, record, isNew: false };
      }

      const workspaceKey = this.generateWorkspaceKey();
      const now = new Date().toISOString();
      const workspacePath = this.allocateWorkspacePath(
        options.suggestedWorkspacePath ?? workspaceKey,
        workspaceKey,
      );
      const record: WorkspaceRecord = {
        createdAt: now,
        lastSeen: now,
        status: "pending",
        workspacePath,
        label: options.label,
        primaryTransport: transport,
        transports: createTransportBindings(transport, senderId, options.binding),
        codeServer: {
          enabled: false,
        },
        calendar: {
          enabled: false,
        },
        boot: defaultNewWorkspaceBootRecord(this.options.workspaceDefaults),
        capabilities: defaultWorkspaceCapabilitiesRecord(),
        piProvider: this.options.modelDefaults?.provider,
        piModel: this.options.modelDefaults?.model,
        piThinkingLevel: this.options.modelDefaults?.thinkingLevel,
      };

      this.registry[workspaceKey] = record;
      this.reverseIndex.set(bindingLookupKey(transport, senderId), workspaceKey);
      await this.writeRegistryToDisk();

      return { workspaceKey, record: cloneWorkspaceRecord(record), isNew: true };
    });
  }

  async ensureProvisioned(
    transport: TransportName,
    senderId: string,
    options: {
      defaultCodeServerEnabled?: boolean;
      defaultCalendarEnabled?: boolean;
      binding?: SignalTransportBinding | NextcloudTransportBinding;
      suggestedWorkspacePath?: string;
      label?: string;
    } = {},
  ): Promise<EnsureProvisionedResult> {
    await this.initialize();

    const existing = this.lookup(transport, senderId);
    if (existing) {
      const record = this.getWorkspace(existing);
      if (!record) throw new Error(`Workspace ${existing} vanished from cache during lookup`);
      return { workspaceKey: existing, record, isNew: false };
    }

    return this.withRegistryLock(async () => {
      const cached = this.lookup(transport, senderId);
      if (cached) {
        const record = this.getWorkspace(cached);
        if (!record) throw new Error(`Workspace ${cached} vanished from cache during lookup`);
        return { workspaceKey: cached, record, isNew: false };
      }

      const workspaceKey = this.generateWorkspaceKey();
      const now = new Date().toISOString();
      const workspacePath = this.allocateWorkspacePath(options.suggestedWorkspacePath ?? workspaceKey, workspaceKey);
      const record: WorkspaceRecord = {
        createdAt: now,
        lastSeen: now,
        status: "active",
        workspacePath,
        provisionedAt: now,
        label: options.label,
        primaryTransport: transport,
        transports: createTransportBindings(transport, senderId, options.binding),
        codeServer: {
          enabled: options.defaultCodeServerEnabled ?? this.options.workspaceDefaults?.codeServerEnabled ?? false,
        },
        calendar: {
          enabled: options.defaultCalendarEnabled ?? this.options.workspaceDefaults?.calendarEnabled ?? false,
        },
        boot: defaultNewWorkspaceBootRecord(this.options.workspaceDefaults),
        capabilities: defaultWorkspaceCapabilitiesRecord(),
        piProvider: this.options.modelDefaults?.provider,
        piModel: this.options.modelDefaults?.model,
        piThinkingLevel: this.options.modelDefaults?.thinkingLevel,
      };

      const paths = workspacePaths(this.projectsDir, record.workspacePath);
      console.log(`[provisioner] New workspace ${workspaceKey} for ${transport}:${senderId} - copying blueprint into ${record.workspacePath}`);

      await this.provisionWorkspaceLayout(paths);

      this.registry[workspaceKey] = record;
      this.reverseIndex.set(bindingLookupKey(transport, senderId), workspaceKey);

      if (record.codeServer?.enabled) {
        ensureCodeServerStateInRegistry(this.registry, workspaceKey, this.options.codeServer?.portStart ?? 18440);
      }
      if (record.calendar?.enabled) {
        ensureCalendarStateInRegistry(this.registry, workspaceKey);
      }

      await this.writeRegistryToDisk();
      return { workspaceKey, record: cloneWorkspaceRecord(record), isNew: true };
    });
  }

  async reprovision(workspaceKey: string): Promise<void> {
    await this.initialize();
    await this.withRegistryLock(async () => {
      const record = this.registry[workspaceKey];
      if (!record) {
        throw new Error(`Cannot reprovision unknown workspace: ${workspaceKey}`);
      }

      const paths = workspacePaths(this.projectsDir, record.workspacePath);
      await fs.rm(paths.root, { recursive: true, force: true });
      await this.provisionWorkspaceLayout(paths);
      await this.writeRegistryToDisk();
    });
  }

  async updateLastSeen(workspaceKey: string): Promise<void> {
    await this.initialize();
    await this.withRegistryLock(async () => {
      const record = this.registry[workspaceKey];
      if (!record) return;
      record.lastSeen = new Date().toISOString();
      await this.writeRegistryToDisk();
    });
  }

  async ensureCodeServerAccess(workspaceKey: string): Promise<CodeServerRecord | undefined> {
    await this.initialize();

    let finalRecord: CodeServerRecord | undefined;
    await this.withRegistryLock(async () => {
      const record = this.registry[workspaceKey];
      if (!record) return;
      finalRecord = ensureCodeServerStateInRegistry(
        this.registry,
        workspaceKey,
        this.options.codeServer?.portStart ?? 18440,
      );
      await this.writeRegistryToDisk();
    });

    return finalRecord ? { ...finalRecord } : undefined;
  }

  async ensureCalendarAccess(workspaceKey: string): Promise<CalendarRecord | undefined> {
    await this.initialize();

    let finalRecord: CalendarRecord | undefined;
    await this.withRegistryLock(async () => {
      const record = this.registry[workspaceKey];
      if (!record) return;
      finalRecord = ensureCalendarStateInRegistry(this.registry, workspaceKey);
      await this.writeRegistryToDisk();
    });

    return finalRecord ? { ...finalRecord } : undefined;
  }

  async reconcileDesiredStateShape(): Promise<string[]> {
    await this.initialize();

    return this.withRegistryLock(async () => {
      const registryPath = this.workspaceRegistryPath();
      let rawRegistry: Record<string, Record<string, unknown>>;
      try {
        rawRegistry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, Record<string, unknown>>;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw err;
      }

      const updated: string[] = [];
      let changed = false;
      for (const [workspaceKey, record] of Object.entries(rawRegistry)) {
        const hadExplicitStatus = record["status"] === "active" || record["status"] === "pending";
        if (!hadExplicitStatus) {
          record["status"] = "active";
          changed = true;
          updated.push(workspaceKey);
        }
        if (typeof record["workspacePath"] !== "string" || !record["workspacePath"].trim()) {
          record["workspacePath"] = legacyWorkspacePath(workspaceKey);
          changed = true;
          if (!updated.includes(workspaceKey)) {
            updated.push(workspaceKey);
          }
        }
        if (!hadExplicitStatus && record["status"] === "active" && typeof record["provisionedAt"] !== "string") {
          record["provisionedAt"] = typeof record["createdAt"] === "string"
            ? record["createdAt"]
            : new Date().toISOString();
          changed = true;
          if (!updated.includes(workspaceKey)) {
            updated.push(workspaceKey);
          }
        }
        if (!record["codeServer"] || typeof record["codeServer"] !== "object") {
          record["codeServer"] = { enabled: false };
          changed = true;
          if (!updated.includes(workspaceKey)) {
            updated.push(workspaceKey);
          }
        }
        if (!record["calendar"] || typeof record["calendar"] !== "object") {
          record["calendar"] = { enabled: false };
          changed = true;
          if (!updated.includes(workspaceKey)) {
            updated.push(workspaceKey);
          }
        }
        if (!record["boot"] || typeof record["boot"] !== "object") {
          record["boot"] = { enabled: true };
          changed = true;
          if (!updated.includes(workspaceKey)) {
            updated.push(workspaceKey);
          }
        }
        if (!workspaceCapabilitiesShapeComplete(record["capabilities"])) {
          record["capabilities"] = normalizeWorkspaceCapabilitiesRecord(record["capabilities"]);
          changed = true;
          if (!updated.includes(workspaceKey)) {
            updated.push(workspaceKey);
          }
        }
      }

      if (changed) {
        await fs.writeFile(registryPath, JSON.stringify(rawRegistry, null, 2));
      }
      return updated;
    });
  }

  private generateWorkspaceKey(): string {
    while (true) {
      const candidate = `ws_${randomBytes(3).toString("hex")}`;
      if (!this.registry[candidate]) return candidate;
    }
  }

  private async loadRegistryFromDisk(): Promise<Record<string, WorkspaceRecord>> {
    const registryPath = this.workspaceRegistryPath();
    try {
      const raw = await fs.readFile(registryPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return normalizeRegistry(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      console.warn(`[provisioner] Failed to read workspace registry at ${registryPath}:`, err);
      throw err;
    }
  }

  private async writeRegistryToDisk(): Promise<void> {
    const registryPath = this.workspaceRegistryPath();
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(this.registry, null, 2));
  }

  private workspaceRegistryPath(): string {
    return workspaceRegistryPath(this.bridgeDataDir);
  }

  async provisionPendingWorkspace(workspaceKey: string): Promise<WorkspaceRecord> {
    await this.initialize();

    return this.withRegistryLock(async () => {
      const record = this.registry[workspaceKey];
      if (!record) {
        throw new Error(`Unknown workspace: ${workspaceKey}`);
      }
      if (record.status !== "active") {
        throw new Error(`Cannot provision workspace ${workspaceKey} unless status is active`);
      }
      if (record.provisionedAt) {
        return cloneWorkspaceRecord(record);
      }

      const paths = workspacePaths(this.projectsDir, record.workspacePath);
      await this.provisionWorkspaceLayout(paths);
      record.provisionedAt = new Date().toISOString();

      if (record.codeServer?.enabled) {
        ensureCodeServerStateInRegistry(this.registry, workspaceKey, this.options.codeServer?.portStart ?? 18440);
      }
      if (record.calendar?.enabled) {
        ensureCalendarStateInRegistry(this.registry, workspaceKey);
      }

      await this.writeRegistryToDisk();
      return cloneWorkspaceRecord(record);
    });
  }

  private allocateWorkspacePath(basePath: string, workspaceKey: string): string {
    const usedPaths = new Set(
      Object.entries(this.registry)
        .filter(([key]) => key !== workspaceKey)
        .map(([, record]) => normalizeWorkspacePath(record.workspacePath)),
    );
    return allocateUniqueWorkspacePath(basePath, usedPaths);
  }

  private async provisionWorkspaceLayout(paths: ReturnType<typeof workspacePaths>): Promise<void> {
    await fs.cp(this.blueprintDir, paths.root, { recursive: true });
    await fs.mkdir(paths.uploadDir, { recursive: true });
    await fs.mkdir(paths.coworkDir, { recursive: true });
    await fs.mkdir(paths.agentDir, { recursive: true });
    await fs.mkdir(paths.eventsDir, { recursive: true });
    await fs.mkdir(paths.bridgeDir, { recursive: true });
    await fs.mkdir(paths.sessionsDir, { recursive: true });

    await moveIfPresent(path.join(paths.root, "AGENTS.md"), paths.agentsFilePath);
    await moveIfPresent(path.join(paths.root, "orient.py"), paths.orientFilePath);
    await moveIfPresent(path.join(paths.root, "boot.py"), paths.orientFilePath);
    await moveIfPresent(path.join(paths.root, "skills"), paths.skillsDir);
    await moveIfPresent(path.join(paths.root, "events"), paths.eventsDir);
    await this.workspaceGit.ensureWorkspaceRepo(paths);
  }

  private async withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(fn, fn);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function createTransportBindings(
  transport: TransportName,
  senderId: string,
  binding?: SignalTransportBinding | NextcloudTransportBinding,
): WorkspaceRecord["transports"] {
  if (transport === "signal") {
    const signalBinding = binding && "roomToken" in binding
      ? undefined
      : binding;
    if (signalBinding?.groupId) {
      return {
        signal: {
          groupId: signalBinding.groupId,
          userWhitelist: normalizeUserWhitelist(signalBinding.userWhitelist),
        },
      };
    }
    return {
      signal: {
        sender: signalBinding?.sender ?? senderId,
        userWhitelist: normalizeUserWhitelist(signalBinding?.userWhitelist),
      },
    };
  }

  const nextcloudBinding = binding && "roomToken" in binding
    ? binding
    : undefined;
  return {
    nextcloud: {
      roomToken: nextcloudBinding?.roomToken ?? senderId,
      userWhitelist: normalizeUserWhitelist(nextcloudBinding?.userWhitelist),
    },
  };
}

function normalizeRegistry(raw: Record<string, unknown>): Record<string, WorkspaceRecord> {
  const normalized: Record<string, WorkspaceRecord> = {};
  for (const [workspaceKey, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    normalized[workspaceKey] = normalizeWorkspaceRecord(value as Record<string, unknown>, workspaceKey);
  }
  return normalized;
}

function normalizeWorkspaceRecord(record: Record<string, unknown>, workspaceKey?: string): WorkspaceRecord {
  const transports = normalizeTransportBindings(record["transports"]);
  const primaryTransport = normalizePrimaryTransport(record["primaryTransport"], transports);
  const status = normalizeWorkspaceStatus(record["status"]);
  const hadExplicitStatus = record["status"] === "active" || record["status"] === "pending";
  const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : new Date().toISOString();
  return {
    createdAt,
    lastSeen: typeof record["lastSeen"] === "string" ? record["lastSeen"] : new Date().toISOString(),
    status,
    workspacePath: normalizeWorkspacePathField(record["workspacePath"], workspaceKey),
    provisionedAt: status === "active"
      ? normalizeOptionalString(asOptionalString(record["provisionedAt"]))
        ?? (hadExplicitStatus ? undefined : createdAt)
      : undefined,
    label: normalizeOptionalString(asOptionalString(record["label"])),
    primaryTransport,
    transports,
    codeServer: normalizeCodeServerRecord(record["codeServer"]) ?? { enabled: false },
    calendar: normalizeCalendarRecord(record["calendar"]) ?? { enabled: false },
    boot: normalizeBootRecord(record["boot"]) ?? { enabled: true },
    capabilities: normalizeWorkspaceCapabilitiesRecord(record["capabilities"]),
    experimental: normalizeLegacyExperimentalRecord(record["experimental"]),
    piProvider: normalizeOptionalString(asOptionalString(record["piProvider"])),
    piModel: normalizeOptionalString(asOptionalString(record["piModel"])),
    piThinkingLevel: normalizeOptionalString(asOptionalString(record["piThinkingLevel"])),
  };
}

function normalizeTransportBindings(value: unknown): WorkspaceRecord["transports"] {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const transports: WorkspaceRecord["transports"] = {};

  const signal = raw["signal"];
  if (signal && typeof signal === "object") {
    const signalRecord = signal as Record<string, unknown>;
    const sender = normalizeOptionalString(asOptionalString(signalRecord["sender"]));
    const groupId = normalizeOptionalString(asOptionalString(signalRecord["groupId"]));
    if (sender && groupId) {
      throw new Error("Signal transport binding must choose exactly one of sender or groupId");
    }
    if (sender || groupId) {
      transports.signal = {
        sender,
        groupId,
        userWhitelist: normalizeUserWhitelist(signalRecord["userWhitelist"]),
      };
    }
  }

  const nextcloud = raw["nextcloud"];
  if (nextcloud && typeof nextcloud === "object") {
    const roomToken = normalizeOptionalString(asOptionalString((nextcloud as Record<string, unknown>)["roomToken"]));
    if (roomToken) {
      transports.nextcloud = {
        roomToken,
        userWhitelist: normalizeUserWhitelist((nextcloud as Record<string, unknown>)["userWhitelist"]),
      };
    }
  }

  return transports;
}

function normalizePrimaryTransport(
  value: unknown,
  transports: WorkspaceRecord["transports"],
): TransportName {
  if (value === "signal" && transports.signal) return "signal";
  if (value === "nextcloud" && transports.nextcloud) return "nextcloud";
  if (transports.signal) return "signal";
  if (transports.nextcloud) return "nextcloud";
  return "signal";
}

function normalizeCodeServerRecord(value: unknown): CodeServerRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw["enabled"] === true,
    password: normalizeOptionalString(asOptionalString(raw["password"])),
    port: typeof raw["port"] === "number" && Number.isInteger(raw["port"]) && raw["port"] > 0
      ? raw["port"]
      : undefined,
  };
}

function normalizeCalendarRecord(value: unknown): CalendarRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw["enabled"] === true,
    token: normalizeOptionalString(asOptionalString(raw["token"])),
    name: normalizeOptionalString(asOptionalString(raw["name"])),
  };
}

function normalizeBootRecord(value: unknown): BootRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw["enabled"] !== false,
  };
}

function defaultNewWorkspaceBootRecord(workspaceDefaults?: WorkspaceDefaultsConfig): BootRecord {
  return {
    enabled: workspaceDefaults?.bootEnabled ?? true,
  };
}

function normalizeLegacyExperimentalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return structuredClone(value as Record<string, unknown>);
}

function ensureCodeServerStateInRegistry(
  registry: Record<string, WorkspaceRecord>,
  workspaceKey: string,
  portStart: number,
): CodeServerRecord {
  const workspace = registry[workspaceKey];
  if (!workspace) {
    throw new Error(`Unknown workspace for code-server access: ${workspaceKey}`);
  }

  workspace.codeServer = workspace.codeServer ?? { enabled: false };
  if (!workspace.codeServer.password) {
    workspace.codeServer.password = generatePassword();
  }
  if (!workspace.codeServer.port || workspace.codeServer.port < 1) {
    workspace.codeServer.port = allocateCodeServerPort(registry, workspaceKey, portStart);
  }
  return { ...workspace.codeServer };
}

function allocateCodeServerPort(
  registry: Record<string, WorkspaceRecord>,
  workspaceKey: string,
  start: number,
): number {
  const used = new Set(
    Object.entries(registry)
      .filter(([key]) => key !== workspaceKey)
      .map(([, record]) => record.codeServer?.port)
      .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value > 0),
  );

  let port = start;
  while (used.has(port)) {
    port += 1;
  }
  return port;
}

function ensureCalendarStateInRegistry(
  registry: Record<string, WorkspaceRecord>,
  workspaceKey: string,
): CalendarRecord {
  const workspace = registry[workspaceKey];
  if (!workspace) {
    throw new Error(`Unknown workspace for calendar access: ${workspaceKey}`);
  }

  workspace.calendar = workspace.calendar ?? { enabled: false };
  if (!workspace.calendar.token) {
    workspace.calendar.token = generateToken();
  }
  if (!workspace.calendar.name) {
    workspace.calendar.name = workspace.label ? `${workspace.label} — Workspace Events` : `Workspace Events (${workspaceKey})`;
  }
  return { ...workspace.calendar };
}

function buildReverseIndex(registry: Record<string, WorkspaceRecord>): Map<string, string> {
  const index = new Map<string, string>();
  const workspacePathIndex = new Map<string, string>();
  for (const [workspaceKey, record] of Object.entries(registry)) {
    registerWorkspacePath(workspacePathIndex, workspaceKey, record.workspacePath);
    if (record.transports.signal?.sender) {
      registerReverseIndex(index, workspaceKey, "signal", record.transports.signal.sender);
    }
    if (record.transports.signal?.groupId) {
      registerReverseIndex(index, workspaceKey, "signal", record.transports.signal.groupId);
    }
    if (record.transports.nextcloud?.roomToken) {
      registerReverseIndex(index, workspaceKey, "nextcloud", record.transports.nextcloud.roomToken);
    }
  }
  return index;
}

async function moveIfPresent(from: string, to: string): Promise<void> {
  try {
    await fs.access(from);
  } catch {
    return;
  }

  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rm(to, { recursive: true, force: true });
  await fs.rename(from, to);
}

function registerReverseIndex(
  index: Map<string, string>,
  workspaceKey: string,
  transport: TransportName,
  senderId: string,
): void {
  const key = bindingLookupKey(transport, senderId);
  const existing = index.get(key);
  if (existing && existing !== workspaceKey) {
    throw new Error(`Duplicate workspace transport binding for ${key}: ${existing} and ${workspaceKey}`);
  }
  index.set(key, workspaceKey);
}

function bindingLookupKey(transport: TransportName, senderId: string): string {
  return `${transport}:${senderId.trim()}`;
}

function normalizeWorkspaceStatus(value: unknown): WorkspaceStatus {
  return value === "pending" ? "pending" : "active";
}

function normalizeWorkspacePathField(value: unknown, workspaceKey?: string): string {
  const raw = normalizeOptionalString(asOptionalString(value));
  if (!raw) {
    return legacyWorkspacePath(workspaceKey ?? "workspace");
  }
  return normalizeWorkspacePath(raw);
}

function registerWorkspacePath(index: Map<string, string>, workspaceKey: string, workspacePath: string): void {
  const normalized = normalizeWorkspacePath(workspacePath);
  const existing = index.get(normalized);
  if (existing && existing !== workspaceKey) {
    throw new Error(`Duplicate workspace path for ${normalized}: ${existing} and ${workspaceKey}`);
  }
  index.set(normalized, workspaceKey);
}

function generatePassword(): string {
  return randomBytes(12).toString("base64url");
}

function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

function cloneWorkspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
  return structuredClone(record);
}

function normalizeUserWhitelist(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.map((entry) => `${entry}`.trim()).filter(Boolean))]
    : [];
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}
