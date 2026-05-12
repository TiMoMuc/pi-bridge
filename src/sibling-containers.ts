import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { TransportName } from "./transport.js";

const SIBLING_MANAGED_LABEL = "io.pi-bridge.managed";
export const SIBLING_ROLE_LABEL = "io.pi-bridge.role";
export const SIBLING_WORKSPACE_LABEL = "io.pi-bridge.workspace";
export const SIBLING_TRANSPORT_LABEL = "io.pi-bridge.transport";
export const SIBLING_PROJECT_LABEL = "io.pi-bridge.project";

const SIBLING_MANAGED_VALUE = "true";
const SANDBOX_CONTAINER_PREFIX = "pi-sandbox-";
export const LEGACY_SANDBOX_CONTAINER_PREFIX = "signal-sandbox-";
const CODE_SERVER_CONTAINER_PREFIX = "code-server-";

type SiblingContainerRole = "sandbox" | "code-server";
export type SiblingContainerStatus = "healthy" | "stale" | "orphaned" | "legacy";

export interface SiblingContainerIdentity {
  role: SiblingContainerRole;
  workspaceKey: string;
  transport?: TransportName | "unknown";
  project: string;
}

export interface DiscoveredSiblingContainer {
  name: string;
  role: SiblingContainerRole;
  workspaceKey?: string;
  transport?: TransportName | "unknown";
  project?: string;
  labelled: boolean;
  legacy: boolean;
}

export function siblingLabelArgs(identity: SiblingContainerIdentity): string[] {
  return [
    "--label", `${SIBLING_MANAGED_LABEL}=${SIBLING_MANAGED_VALUE}`,
    "--label", `${SIBLING_ROLE_LABEL}=${identity.role}`,
    "--label", `${SIBLING_WORKSPACE_LABEL}=${identity.workspaceKey}`,
    "--label", `${SIBLING_TRANSPORT_LABEL}=${identity.transport ?? "unknown"}`,
    "--label", `${SIBLING_PROJECT_LABEL}=${identity.project}`,
  ];
}

export function sanitizeWorkspaceKey(workspaceKey: string): string {
  return workspaceKey.replace(/^\+/, "p").replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function sandboxContainerName(workspaceKey: string): string {
  return `${SANDBOX_CONTAINER_PREFIX}${sanitizeWorkspaceKey(workspaceKey)}`;
}

export function codeServerContainerName(workspaceKey: string): string {
  return `${CODE_SERVER_CONTAINER_PREFIX}${sanitizeWorkspaceKey(workspaceKey)}`;
}

export async function canonicalizePath(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

export async function discoverSiblingContainers(
  execSimple: (cmd: string, args: string[]) => Promise<string>,
  knownWorkspaces: string[],
): Promise<DiscoveredSiblingContainer[]> {
  const raw = await execSimple("docker", ["ps", "-a", "--format", "{{.Names}}"])
    .catch(() => "");
  const names = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const workspaceBySanitized = new Map<string, string>(
    knownWorkspaces.map((workspaceKey) => [sanitizeWorkspaceKey(workspaceKey), workspaceKey]),
  );

  const discovered: DiscoveredSiblingContainer[] = [];

  for (const name of names) {
    const parsedByName = parseSiblingContainerName(name, workspaceBySanitized);
    if (!parsedByName) continue;

    const labelRaw = await execSimple("docker", [
      "inspect",
      "-f",
      `{{index .Config.Labels "${SIBLING_MANAGED_LABEL}"}}\t{{index .Config.Labels "${SIBLING_ROLE_LABEL}"}}\t{{index .Config.Labels "${SIBLING_WORKSPACE_LABEL}"}}\t{{index .Config.Labels "${SIBLING_TRANSPORT_LABEL}"}}\t{{index .Config.Labels "${SIBLING_PROJECT_LABEL}"}}`,
      name,
    ]).catch(() => "\t\t\t\t");

    const [managed, roleLabel, workspaceLabel, transportLabel, projectLabel] = labelRaw.trimEnd().split("\t");
    if (managed === SIBLING_MANAGED_VALUE && isSiblingRole(roleLabel) && workspaceLabel) {
      discovered.push({
        name,
        role: roleLabel,
        workspaceKey: workspaceLabel,
        transport: isTransportName(transportLabel) ? transportLabel : "unknown",
        project: projectLabel || undefined,
        labelled: true,
        legacy: false,
      });
      continue;
    }

    discovered.push({
      name,
      role: parsedByName.role,
      workspaceKey: parsedByName.workspaceKey,
      labelled: false,
      legacy: parsedByName.legacy,
    });
  }

  return discovered;
}

function parseSiblingContainerName(
  name: string,
  workspaceBySanitized: Map<string, string>,
): { role: SiblingContainerRole; workspaceKey?: string; legacy: boolean } | null {
  if (name.startsWith(SANDBOX_CONTAINER_PREFIX)) {
    const workspaceKey = workspaceBySanitized.get(name.slice(SANDBOX_CONTAINER_PREFIX.length));
    return { role: "sandbox", workspaceKey, legacy: false };
  }
  if (name.startsWith(LEGACY_SANDBOX_CONTAINER_PREFIX)) {
    const workspaceKey = workspaceBySanitized.get(name.slice(LEGACY_SANDBOX_CONTAINER_PREFIX.length));
    return { role: "sandbox", workspaceKey, legacy: true };
  }
  if (name.startsWith(CODE_SERVER_CONTAINER_PREFIX)) {
    const workspaceKey = workspaceBySanitized.get(name.slice(CODE_SERVER_CONTAINER_PREFIX.length));
    return { role: "code-server", workspaceKey, legacy: false };
  }
  return null;
}

function isSiblingRole(value: string): value is SiblingContainerRole {
  return value === "sandbox" || value === "code-server";
}

function isTransportName(value: string): value is TransportName {
  return value === "signal" || value === "nextcloud";
}
