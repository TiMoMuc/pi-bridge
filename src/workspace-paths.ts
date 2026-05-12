import * as path from "node:path";

export const WORKSPACE_UPLOAD_DIRNAME = "upload";
const WORKSPACE_COWORK_DIRNAME = "cowork";
const WORKSPACE_AGENT_DIRNAME = ".agent";
const WORKSPACE_EVENTS_DIRNAME = ".events";
export const WORKSPACE_BRIDGE_DIRNAME = ".bridge";

const WORKSPACE_AGENTS_FILENAME = "AGENTS.md";
const WORKSPACE_ORIENT_FILENAME = "orient.py";
const WORKSPACE_SKILLS_DIRNAME = "skills";
const WORKSPACE_SESSIONS_DIRNAME = "sessions";
const WORKSPACE_GIT_DIRNAME = "git";

const BRIDGE_ADMIN_DIRNAME = "admin";
const BRIDGE_LOGS_DIRNAME = "logs";
const BRIDGE_INBOX_DIRNAME = "inbox";
const BRIDGE_OUTBOX_DIRNAME = "outbox";
const BRIDGE_CODE_SERVER_STATE_DIRNAME = "code-server";
const WORKSPACE_REGISTRY_FILENAME = "workspace.json";
const SIGNAL_MESSAGE_REFS_FILENAME = "signal-message-refs.jsonl";

export interface WorkspacePaths {
  root: string;
  uploadDir: string;
  coworkDir: string;
  agentDir: string;
  eventsDir: string;
  bridgeDir: string;
  sessionsDir: string;
  gitDir: string;
  agentsFilePath: string;
  orientFilePath: string;
  skillsDir: string;
}

export function defaultProjectsDir(bridgeDataDir: string): string {
  return path.join(bridgeDataDir, "projects");
}

export function bridgeAdminDir(bridgeDataDir: string): string {
  return path.join(bridgeDataDir, BRIDGE_ADMIN_DIRNAME);
}

export function bridgeLogsDir(bridgeDataDir: string): string {
  return path.join(bridgeAdminDir(bridgeDataDir), BRIDGE_LOGS_DIRNAME);
}

export function bridgeInboxDir(bridgeDataDir: string): string {
  return path.join(bridgeAdminDir(bridgeDataDir), BRIDGE_INBOX_DIRNAME);
}

export function bridgeOutboxDir(bridgeDataDir: string): string {
  return path.join(bridgeAdminDir(bridgeDataDir), BRIDGE_OUTBOX_DIRNAME);
}

export function workspaceRegistryPath(bridgeDataDir: string): string {
  return path.join(bridgeAdminDir(bridgeDataDir), WORKSPACE_REGISTRY_FILENAME);
}

export function signalMessageRefsPath(bridgeDataDir: string): string {
  return path.join(bridgeAdminDir(bridgeDataDir), SIGNAL_MESSAGE_REFS_FILENAME);
}

export function codeServerStatePaths(bridgeDataDir: string, workspaceKey: string): {
  configDir: string;
  dataDir: string;
} {
  const stateDir = path.join(bridgeDataDir, BRIDGE_CODE_SERVER_STATE_DIRNAME, workspaceKey);
  return {
    configDir: path.join(stateDir, "config"),
    dataDir: path.join(stateDir, "data"),
  };
}

export function legacyWorkspacePath(workspaceKey: string): string {
  return path.posix.join("users", workspaceKey);
}

export function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("workspacePath must not be empty");
  }
  if (path.isAbsolute(trimmed)) {
    throw new Error(`workspacePath must be relative: ${value}`);
  }

  const parts = trimmed
    .split(/[\\/]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("workspacePath must contain at least one path segment");
  }

  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new Error(`workspacePath must not contain traversal segments: ${value}`);
    }
  }

  return parts.join(path.posix.sep);
}

function resolveWorkspaceRoot(projectsDir: string, workspacePath: string): string {
  const normalizedPath = normalizeWorkspacePath(workspacePath);
  const base = path.resolve(projectsDir);
  const resolved = path.resolve(base, normalizedPath);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`workspacePath resolves outside PROJECTS_DIR: ${workspacePath}`);
  }
  return resolved;
}

export function workspacePaths(projectsDir: string, workspacePath: string): WorkspacePaths {
  const root = resolveWorkspaceRoot(projectsDir, workspacePath);
  const uploadDir = path.join(root, WORKSPACE_UPLOAD_DIRNAME);
  const coworkDir = path.join(root, WORKSPACE_COWORK_DIRNAME);
  const agentDir = path.join(root, WORKSPACE_AGENT_DIRNAME);
  const eventsDir = path.join(root, WORKSPACE_EVENTS_DIRNAME);
  const bridgeDir = path.join(root, WORKSPACE_BRIDGE_DIRNAME);
  return {
    root,
    uploadDir,
    coworkDir,
    agentDir,
    eventsDir,
    bridgeDir,
    sessionsDir: path.join(bridgeDir, WORKSPACE_SESSIONS_DIRNAME),
    gitDir: path.join(bridgeDir, WORKSPACE_GIT_DIRNAME),
    agentsFilePath: path.join(agentDir, WORKSPACE_AGENTS_FILENAME),
    orientFilePath: path.join(agentDir, WORKSPACE_ORIENT_FILENAME),
    skillsDir: path.join(agentDir, WORKSPACE_SKILLS_DIRNAME),
  };
}

export function slugifyWorkspacePathComponent(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  const normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || fallback;
}

export function allocateUniqueWorkspacePath(basePath: string, usedPaths: Set<string>): string {
  const normalizedBase = normalizeWorkspacePath(basePath);
  if (!usedPaths.has(normalizedBase)) {
    return normalizedBase;
  }

  let counter = 2;
  while (true) {
    const candidate = `${normalizedBase}-${counter}`;
    if (!usedPaths.has(candidate)) {
      return candidate;
    }
    counter += 1;
  }
}
