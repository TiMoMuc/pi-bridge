/**
 * Environment variable parsing. All bridge configuration lives here.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { TransportName } from "./transport.js";
import { defaultProjectsDir } from "./workspace-paths.js";

export const DEFAULT_SANDBOX_IMAGE = "pi-bridge-sandbox:latest";
export const SANDBOX_WORKSPACE_ROOT = "/workspace";
export const DEFAULT_SANDBOX_CWD = ".";
export const DEFAULT_SYSTEM_DIR = "/app/system";
export const DEFAULT_CODE_SERVER_IMAGE = "pi-bridge-code-server:latest";
const CODE_SERVER_EXTENSIONS_MANIFEST_URL = new URL("../code-server/extensions.txt", import.meta.url);

export interface NextcloudConfig {
  baseUrl: string;
  botSecret: string;
  webhookHost: string;
  webhookPort: number;
  webhookPath: string;
  apiUser: string;
  apiPassword: string;
}

export interface CalendarConfig {
  enabled: boolean;
  bindHost: string;
  port: number;
  publicBaseUrl?: string;
  refreshInterval: string;
}

export interface WorkspaceDefaultsConfig {
  codeServerEnabled: boolean;
  calendarEnabled: boolean;
  bootEnabled: boolean;
}

export interface SessionWatchConfig {
  enabled: boolean;
  bindHost: string;
  port: number;
  publicBaseUrl?: string;
}

export interface AdminUiConfig {
  bindHost: string;
  port: number;
  username: string;
  password: string;
}

export interface RuntimeIdentityConfig {
  uid: number;
  gid: number;
  dockerSocketGid: number;
}

export type BridgeAccessMode = "open" | "closed" | "pending";
export type CodeServerExtensionsMode = "append" | "override";
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export interface CodeServerConfig {
  /** Legacy compatibility field; runtime no longer uses a global enable flag. */
  enabled?: boolean;
  image: string;
  bindHost: string;
  portStart: number;
  publicUrlTemplate?: string;
  extensions: string[];
  extensionsMode: CodeServerExtensionsMode;
}

export interface Config {
  /** Legacy compatibility field; runtime no longer selects a single active transport. */
  transport?: TransportName;
  signalCliUrl: string;
  signalPhoneNumber?: string;

  anthropicApiKey: string;
  piProvider: string;
  piModel: string;
  piThinkingLevel: PiThinkingLevel;
  bridgeAccessMode: BridgeAccessMode;
  bridgeDataDir: string;
  projectsDir: string;
  bridgeDataHostDir?: string;
  projectsHostDir?: string;
  blueprintDir: string;
  /** Internal system prompt root inside the bridge image. Not operator-configurable. */
  systemDir: string;
  adminPhone: string | undefined;
  runtimeIdentity?: RuntimeIdentityConfig;

  sandboxImage: string;
  sandboxMemory: number;
  sandboxCpus: number;
  sandboxNetwork: string;
  /** Relative path under the fixed sandbox workspace root. `.` means `/workspace`. */
  sandboxCwd: string;

  codeServer: CodeServerConfig;
  calendar: CalendarConfig;
  sessionWatch?: SessionWatchConfig;
  adminUi?: AdminUiConfig;
  workspaceDefaults: WorkspaceDefaultsConfig;
  nextcloud: NextcloudConfig;
}

export const DEFAULT_CODE_SERVER_EXTENSIONS = loadCodeServerExtensionManifest();

export function loadCodeServerExtensionManifest(): string[] {
  const raw = readFileSync(CODE_SERVER_EXTENSIONS_MANIFEST_URL, "utf8");
  const extensions = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
  if (extensions.length === 0) {
    throw new Error("code-server/extensions.txt is empty — define at least one default extension.");
  }
  return unique(extensions);
}

export function resolveCodeServerExtensions(
  manifestExtensions: string[],
  envExtensions: string[],
  mode: CodeServerExtensionsMode,
): string[] {
  return mode === "override"
    ? unique(envExtensions)
    : unique([...manifestExtensions, ...envExtensions]);
}

export function defaultProjectsHostDir(bridgeDataHostDir: string): string {
  return path.join(bridgeDataHostDir, "projects");
}

const REMOVED_ENV_GUIDANCE: Record<string, string> = {
  WORKSPACE_DIR: "removed; use BRIDGE_DATA_HOST_DIR / PROJECTS_HOST_DIR for host paths and BRIDGE_DATA_DIR / PROJECTS_DIR for in-container paths",
  BRIDGE_DATA_DIR_HOST: "removed; use BRIDGE_DATA_HOST_DIR",
  PROJECTS_DIR_HOST: "removed; use PROJECTS_HOST_DIR",
  NC_URL: "removed; use NEXTCLOUD_BASE_URL",
  NC_BOT_SECRET: "removed; use NEXTCLOUD_BOT_SECRET",
  NC_USER: "removed; use NEXTCLOUD_API_USER",
  NC_APP_TOKEN: "removed; use NEXTCLOUD_API_PASSWORD",
  NC_WEBHOOK_HOST: "removed; use NEXTCLOUD_WEBHOOK_HOST",
  NC_WEBHOOK_PORT: "removed; use NEXTCLOUD_WEBHOOK_PORT",
  NC_WEBHOOK_PATH: "removed; use NEXTCLOUD_WEBHOOK_PATH",
  SYSTEM_DIR: `removed from the operator env surface; the bridge now uses ${DEFAULT_SYSTEM_DIR} internally`,
};

export function loadConfig(): Config {
  assertRemovedEnvNotSet();
  const csv = (key: string): string[] => {
    const val = process.env[key];
    if (!val) return [];
    return val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  };

  const codeServerExtensionsMode = parseCodeServerExtensionsMode(
    process.env["CODE_SERVER_EXTENSIONS_MODE"] ?? "append",
  );
  const codeServerEnvExtensions = csv("CODE_SERVER_EXTENSIONS");
  const adminUiUser = normalizeOptionalString(process.env["ADMIN_UI_USER"]);
  const adminUiPassword = normalizeOptionalString(process.env["ADMIN_UI_PASSWORD"]);
  if (!!adminUiUser !== !!adminUiPassword) {
    throw new Error("ADMIN_UI_USER and ADMIN_UI_PASSWORD must be set together");
  }
  const runtimeIdentity = resolveRuntimeIdentity(
    parseOptionalIdEnv("BRIDGE_RUNTIME_UID"),
    parseOptionalIdEnv("BRIDGE_RUNTIME_GID"),
    parseOptionalIdEnv("BRIDGE_DOCKER_SOCKET_GID"),
  );

  const config: Config = {
    signalCliUrl: process.env["SIGNAL_CLI_URL"] ?? "http://localhost:8080",
    signalPhoneNumber: normalizeOptionalString(process.env["SIGNAL_PHONE_NUMBER"]),

    anthropicApiKey: process.env["ANTHROPIC_API_KEY"] ?? "",
    piProvider: process.env["PI_PROVIDER"] ?? "anthropic",
    piModel: process.env["PI_MODEL"] ?? "claude-sonnet-4-5",
    piThinkingLevel: parsePiThinkingLevel(process.env["PI_THINKING_LEVEL"] ?? "off"),
    bridgeAccessMode: parseBridgeAccessMode(process.env["BRIDGE_ACCESS_MODE"] ?? "open"),
    bridgeDataDir: process.env["BRIDGE_DATA_DIR"] ?? "/bridge-data",
    projectsDir: "",
    bridgeDataHostDir: normalizeOptionalString(process.env["BRIDGE_DATA_HOST_DIR"]),
    projectsHostDir: normalizeOptionalString(process.env["PROJECTS_HOST_DIR"]),
    blueprintDir: process.env["BLUEPRINT_DIR"] ?? "/app/__blueprint__",
    systemDir: DEFAULT_SYSTEM_DIR,
    adminPhone: normalizeOptionalString(process.env["ADMIN_PHONE"]),
    runtimeIdentity,

    sandboxImage: process.env["SANDBOX_IMAGE"] ?? DEFAULT_SANDBOX_IMAGE,
    sandboxMemory: Number(process.env["SANDBOX_MEMORY"] ?? "536870912"),
    sandboxCpus: Number(process.env["SANDBOX_CPUS"] ?? "1000000000"),
    sandboxNetwork: process.env["SANDBOX_NETWORK"] ?? "none",
    sandboxCwd: parseSandboxCwd(process.env["SANDBOX_CWD"] ?? DEFAULT_SANDBOX_CWD),

    codeServer: {
      image: process.env["CODE_SERVER_IMAGE"] ?? DEFAULT_CODE_SERVER_IMAGE,
      bindHost: process.env["CODE_SERVER_BIND_HOST"] ?? "127.0.0.1",
      portStart: Number(process.env["CODE_SERVER_PORT_START"] ?? "18440"),
      publicUrlTemplate: normalizeCodeServerPublicUrlTemplate(
        normalizeOptionalString(process.env["CODE_SERVER_PUBLIC_URL_TEMPLATE"]),
      ),
      extensionsMode: codeServerExtensionsMode,
      extensions: resolveCodeServerExtensions(
        DEFAULT_CODE_SERVER_EXTENSIONS,
        codeServerEnvExtensions,
        codeServerExtensionsMode,
      ),
    },

    calendar: {
      enabled: process.env["CALENDAR_ENABLED"] === "true",
      bindHost: process.env["CALENDAR_HTTP_HOST"] ?? "0.0.0.0",
      port: Number(process.env["CALENDAR_HTTP_PORT"] ?? "8789"),
      publicBaseUrl: normalizeBaseUrl(normalizeOptionalString(process.env["CALENDAR_PUBLIC_BASE_URL"])),
      refreshInterval: process.env["CALENDAR_REFRESH_INTERVAL"]?.trim() || "PT15M",
    },

    sessionWatch: {
      enabled: process.env["SESSION_WATCH_ENABLED"] === "true",
      bindHost: process.env["SESSION_WATCH_HOST"] ?? "127.0.0.1",
      port: Number(process.env["SESSION_WATCH_PORT"] ?? "8791"),
      publicBaseUrl: normalizeBaseUrl(normalizeOptionalString(process.env["SESSION_WATCH_PUBLIC_BASE_URL"])),
    },

    adminUi: adminUiUser && adminUiPassword
      ? {
        bindHost: "0.0.0.0",
        port: Number(process.env["ADMIN_UI_PORT"] ?? "8792"),
        username: adminUiUser,
        password: adminUiPassword,
      }
      : undefined,

    workspaceDefaults: {
      codeServerEnabled: process.env["DEFAULT_NEW_WORKSPACE_CODE_SERVER_ENABLED"] === "true",
      calendarEnabled: process.env["DEFAULT_NEW_WORKSPACE_CALENDAR_ENABLED"] === "true",
      bootEnabled: process.env["DEFAULT_NEW_WORKSPACE_BOOT_ENABLED"]?.trim().toLowerCase() !== "false",
    },

    nextcloud: {
      baseUrl: process.env["NEXTCLOUD_BASE_URL"] ?? "",
      botSecret: process.env["NEXTCLOUD_BOT_SECRET"] ?? "",
      webhookHost: process.env["NEXTCLOUD_WEBHOOK_HOST"] ?? "0.0.0.0",
      webhookPort: Number(process.env["NEXTCLOUD_WEBHOOK_PORT"] ?? "8788"),
      webhookPath: process.env["NEXTCLOUD_WEBHOOK_PATH"] ?? "/nextcloud-talk-webhook",
      apiUser: process.env["NEXTCLOUD_API_USER"] ?? "",
      apiPassword: process.env["NEXTCLOUD_API_PASSWORD"] ?? "",
    },
  };

  config.projectsDir = normalizeContainerPath(
    process.env["PROJECTS_DIR"] ?? defaultProjectsDir(config.bridgeDataDir),
  );

  if (!!config.nextcloud.apiUser !== !!config.nextcloud.apiPassword) {
    throw new Error("NEXTCLOUD_API_USER and NEXTCLOUD_API_PASSWORD must be set together");
  }

  if (enabledTransportNames(config).length === 0) {
    throw new Error("At least one transport must be configured: SIGNAL_PHONE_NUMBER and/or NEXTCLOUD_BASE_URL + NEXTCLOUD_BOT_SECRET");
  }

  return config;
}

export function enabledTransportNames(config: Config): TransportName[] {
  const transports: TransportName[] = [];
  if (hasSignalTransport(config)) transports.push("signal");
  if (hasNextcloudTransport(config)) transports.push("nextcloud");
  return transports;
}

export function hasSignalTransport(config: Config): boolean {
  return !!normalizeOptionalString(config.signalPhoneNumber);
}

export function hasNextcloudTransport(config: Config): boolean {
  return !!normalizeOptionalString(config.nextcloud.baseUrl) && !!normalizeOptionalString(config.nextcloud.botSecret);
}

function parseBridgeAccessMode(value: string): BridgeAccessMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "open" || normalized === "closed" || normalized === "pending") {
    return normalized;
  }
  throw new Error(`Invalid BRIDGE_ACCESS_MODE value: ${value}`);
}

export function parsePiThinkingLevel(value: string): PiThinkingLevel {
  const normalized = value.trim().toLowerCase();
  if (PI_THINKING_LEVELS.includes(normalized as PiThinkingLevel)) {
    return normalized as PiThinkingLevel;
  }
  throw new Error(`Invalid PI_THINKING_LEVEL value: ${value}`);
}

function parseCodeServerExtensionsMode(value: string): CodeServerExtensionsMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "append" || normalized === "override") {
    return normalized;
  }
  throw new Error(`Invalid CODE_SERVER_EXTENSIONS_MODE value: ${value}`);
}

function normalizeContainerPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`Invalid path value (must be absolute inside the bridge container): ${value}`);
  }
  return path.posix.normalize(trimmed);
}

export function parseSandboxCwd(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return ".";
  }
  if (path.posix.isAbsolute(trimmed)) {
    throw new Error(`Invalid SANDBOX_CWD value (must be relative to ${SANDBOX_WORKSPACE_ROOT}): ${value}`);
  }

  const normalized = path.posix.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid SANDBOX_CWD value (must stay within ${SANDBOX_WORKSPACE_ROOT}): ${value}`);
  }
  return normalized === "." ? "." : normalized;
}

export function resolveSandboxCwd(value: string): string {
  const normalized = parseSandboxCwd(value);
  return normalized === "."
    ? SANDBOX_WORKSPACE_ROOT
    : path.posix.join(SANDBOX_WORKSPACE_ROOT, normalized);
}

function assertRemovedEnvNotSet(): void {
  const detected = Object.entries(REMOVED_ENV_GUIDANCE)
    .filter(([name]) => normalizeOptionalString(process.env[name]) !== undefined)
    .map(([name, guidance]) => `- ${name}: ${guidance}`);

  if (detected.length === 0) {
    return;
  }

  throw new Error([
    "Removed environment variables detected.",
    ...detected,
    "Check this commit's .env.example and README.md, then migrate your .env before restarting the bridge.",
  ].join("\n"));
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseOptionalIdEnv(name: string): number | undefined {
  const raw = normalizeOptionalString(process.env[name]);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return Number(raw);
}

function resolveRuntimeIdentity(
  uid: number | undefined,
  gid: number | undefined,
  dockerSocketGid: number | undefined,
): RuntimeIdentityConfig | undefined {
  if ((uid === undefined) !== (gid === undefined)) {
    throw new Error("BRIDGE_RUNTIME_UID and BRIDGE_RUNTIME_GID must be set together");
  }
  if (uid === undefined || gid === undefined) {
    if (dockerSocketGid !== undefined) {
      throw new Error("BRIDGE_DOCKER_SOCKET_GID requires BRIDGE_RUNTIME_UID and BRIDGE_RUNTIME_GID");
    }
    return undefined;
  }
  if (dockerSocketGid === undefined) {
    throw new Error("BRIDGE_DOCKER_SOCKET_GID is required when BRIDGE_RUNTIME_UID and BRIDGE_RUNTIME_GID are set");
  }

  return {
    uid,
    gid,
    dockerSocketGid,
  };
}

function normalizeBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\/+$/, "");
}

function normalizeCodeServerPublicUrlTemplate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`Invalid CODE_SERVER_PUBLIC_URL_TEMPLATE value (must start with http:// or https://): ${value}`);
  }

  const invalidPlaceholders = [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)]
    .map((match) => match[1])
    .filter((placeholder) => placeholder !== "port" && placeholder !== "workspaceKey");
  if (invalidPlaceholders.length > 0) {
    throw new Error(`Invalid CODE_SERVER_PUBLIC_URL_TEMPLATE placeholder(s): ${invalidPlaceholders.join(", ")}`);
  }

  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
