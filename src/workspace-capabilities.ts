import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getLogger } from "./logger.js";
import { sanitizeWorkspaceKey } from "./sibling-containers.js";

export type WorkspaceCapabilityName = "pdfApi" | "spreadsheetRecalc" | "accessGemini";

export interface CapabilityToggleRecord {
  enabled: boolean;
}

export interface WorkspaceCapabilitiesRecord {
  pdfApi?: CapabilityToggleRecord;
  spreadsheetRecalc?: CapabilityToggleRecord;
  accessGemini?: CapabilityToggleRecord;
}

export interface WorkspaceCapabilityApplyResult {
  attached: WorkspaceCapabilityName[];
  detached: WorkspaceCapabilityName[];
  missing: WorkspaceCapabilityName[];
  networkCreated: boolean;
  networkRemoved: boolean;
}

interface WorkspaceCapabilityManagerDeps {
  execSimple?: typeof execSimple;
  project?: string;
}

const NETWORK_KIND_LABEL = "io.pi-bridge.kind";
const PROJECT_LABEL = "io.pi-bridge.project";
const WORKSPACE_LABEL = "io.pi-bridge.workspace";
const NETWORK_KIND_VALUE = "workspace-capability-network";
const CAPABILITY_BUNDLE_SOURCE_PATH = "/capability/.";
const WORKSPACE_CAPABILITIES_DIRNAME = "capabilities";
const CAPABILITY_SKILL_FILENAME = "SKILL.md";
const REQUIRED_SKILL_FRONTMATTER_KEYS = ["name", "description", "version"] as const;

const CAPABILITY_CONFIG: Record<WorkspaceCapabilityName, { containerSuffix: string; alias: string }> = {
  pdfApi: {
    containerSuffix: "pdf-api",
    alias: "pdf-api",
  },
  spreadsheetRecalc: {
    containerSuffix: "spreadsheet-recalc",
    alias: "spreadsheet-recalc",
  },
  accessGemini: {
    containerSuffix: "access-gemini",
    alias: "access-gemini",
  },
};

const KNOWN_WORKSPACE_CAPABILITIES = Object.keys(CAPABILITY_CONFIG) as WorkspaceCapabilityName[];

export function defaultWorkspaceCapabilitiesRecord(): WorkspaceCapabilitiesRecord {
  return {
    pdfApi: { enabled: false },
    spreadsheetRecalc: { enabled: false },
    accessGemini: { enabled: false },
  };
}

export function normalizeWorkspaceCapabilitiesRecord(value: unknown): WorkspaceCapabilitiesRecord {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return {
    pdfApi: normalizeCapabilityToggleRecord(raw["pdfApi"]) ?? { enabled: false },
    spreadsheetRecalc: normalizeCapabilityToggleRecord(raw["spreadsheetRecalc"]) ?? { enabled: false },
    accessGemini: normalizeCapabilityToggleRecord(raw["accessGemini"]) ?? { enabled: false },
  };
}

export function workspaceCapabilitiesShapeComplete(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const raw = value as Record<string, unknown>;
  return KNOWN_WORKSPACE_CAPABILITIES.every((capability) => capability in raw);
}

export function enabledWorkspaceCapabilities(capabilities?: WorkspaceCapabilitiesRecord): WorkspaceCapabilityName[] {
  return KNOWN_WORKSPACE_CAPABILITIES.filter((name) => capabilities?.[name]?.enabled === true);
}

export function hasEnabledWorkspaceCapabilities(capabilities?: WorkspaceCapabilitiesRecord): boolean {
  return enabledWorkspaceCapabilities(capabilities).length > 0;
}

export function workspaceCapabilityNetworkName(workspaceKey: string): string {
  return `${sanitizeWorkspaceKey(workspaceKey)}-net`;
}

export function resolveSandboxNetworkName(
  defaultNetwork: string,
  workspaceKey: string,
  capabilities?: WorkspaceCapabilitiesRecord,
): string {
  return hasEnabledWorkspaceCapabilities(capabilities)
    ? workspaceCapabilityNetworkName(workspaceKey)
    : defaultNetwork;
}

export class WorkspaceCapabilityManager {
  private readonly execSimpleFn: typeof execSimple;
  private readonly project: string;

  constructor(deps: WorkspaceCapabilityManagerDeps = {}) {
    this.execSimpleFn = deps.execSimple ?? execSimple;
    this.project = deps.project ?? process.env["BRIDGE_CONTAINER_NAME"] ?? "pi-bridge";
  }

  async applyWorkspaceCapabilities(
    workspaceKey: string,
    capabilities?: WorkspaceCapabilitiesRecord,
    workspaceBridgeDir?: string,
  ): Promise<WorkspaceCapabilityApplyResult> {
    const enabled = new Set(enabledWorkspaceCapabilities(capabilities));
    const networkName = workspaceCapabilityNetworkName(workspaceKey);
    const result: WorkspaceCapabilityApplyResult = {
      attached: [],
      detached: [],
      missing: [],
      networkCreated: false,
      networkRemoved: false,
    };

    if (enabled.size > 0) {
      result.networkCreated = await this.ensureWorkspaceNetwork(workspaceKey, networkName);
    }

    for (const capability of KNOWN_WORKSPACE_CAPABILITIES) {
      if (!enabled.has(capability)) {
        await this.removeWorkspaceCapabilityArtifacts(capability, workspaceBridgeDir);
        if (await this.disconnectCapabilityFromWorkspace(capability, networkName)) {
          result.detached.push(capability);
        }
        continue;
      }

      const materialized = await this.materializeWorkspaceCapabilityBundle(capability, workspaceBridgeDir, workspaceKey);
      if (!materialized) {
        await this.disconnectCapabilityFromWorkspace(capability, networkName);
        result.missing.push(capability);
        continue;
      }

      const attached = await this.connectCapabilityToWorkspace(capability, networkName);
      if (attached === "missing") {
        await this.removeWorkspaceCapabilityArtifacts(capability, workspaceBridgeDir);
        result.missing.push(capability);
      } else if (attached) {
        result.attached.push(capability);
      }
    }

    if (enabled.size === 0) {
      result.networkRemoved = await this.removeWorkspaceNetwork(networkName);
    }

    return result;
  }

  capabilityContainerName(capability: WorkspaceCapabilityName): string {
    return `${this.project}-${CAPABILITY_CONFIG[capability].containerSuffix}`;
  }

  capabilityAlias(capability: WorkspaceCapabilityName): string {
    return CAPABILITY_CONFIG[capability].alias;
  }

  private async materializeWorkspaceCapabilityBundle(
    capability: WorkspaceCapabilityName,
    workspaceBridgeDir: string | undefined,
    workspaceKey: string,
  ): Promise<boolean> {
    if (!workspaceBridgeDir) {
      getLogger().warn(
        "workspace-capabilities",
        "capability-artifact-path-missing",
        `Cannot materialize ${capability} guidance without a workspace .bridge directory`,
        { workspaceKey, capability },
      );
      return false;
    }

    const containerName = this.capabilityContainerName(capability);
    const destinationDir = path.join(workspaceBridgeDir, WORKSPACE_CAPABILITIES_DIRNAME, capability);
    const destinationPath = path.join(destinationDir, CAPABILITY_SKILL_FILENAME);

    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.mkdir(destinationDir, { recursive: true });

    try {
      await this.execSimpleFn("docker", ["cp", `${containerName}:${CAPABILITY_BUNDLE_SOURCE_PATH}`, destinationDir]);
    } catch {
      await this.removeWorkspaceCapabilityArtifacts(capability, workspaceBridgeDir);
      getLogger().warn(
        "workspace-capabilities",
        "capability-bundle-missing",
        `Capability ${capability} is not exposable because ${CAPABILITY_BUNDLE_SOURCE_PATH} is unavailable`,
        { workspaceKey, capability, containerName },
      );
      return false;
    }

    let skillText = "";
    try {
      skillText = await fs.readFile(destinationPath, "utf8");
    } catch {
      await this.removeWorkspaceCapabilityArtifacts(capability, workspaceBridgeDir);
      getLogger().warn(
        "workspace-capabilities",
        "capability-skill-missing",
        `Capability ${capability} is not exposable because the copied capability bundle is missing ${CAPABILITY_SKILL_FILENAME}`,
        { workspaceKey, capability, containerName },
      );
      return false;
    }

    const validationError = validateCapabilitySkillFrontmatter(skillText);
    if (validationError) {
      await this.removeWorkspaceCapabilityArtifacts(capability, workspaceBridgeDir);
      getLogger().warn(
        "workspace-capabilities",
        "capability-skill-invalid",
        `Capability ${capability} is not exposable because its bundled skill is invalid: ${validationError}`,
        { workspaceKey, capability, containerName },
      );
      return false;
    }

    return true;
  }

  private async removeWorkspaceCapabilityArtifacts(
    capability: WorkspaceCapabilityName,
    workspaceBridgeDir?: string,
  ): Promise<void> {
    if (!workspaceBridgeDir) return;
    await fs.rm(path.join(workspaceBridgeDir, WORKSPACE_CAPABILITIES_DIRNAME, capability), {
      recursive: true,
      force: true,
    });
  }

  private async ensureWorkspaceNetwork(workspaceKey: string, networkName: string): Promise<boolean> {
    if (await this.networkExists(networkName)) {
      return false;
    }

    await this.execSimpleFn("docker", [
      "network",
      "create",
      "--internal",
      "--label", `${NETWORK_KIND_LABEL}=${NETWORK_KIND_VALUE}`,
      "--label", `${PROJECT_LABEL}=${this.project}`,
      "--label", `${WORKSPACE_LABEL}=${workspaceKey}`,
      networkName,
    ]);
    return true;
  }

  private async connectCapabilityToWorkspace(
    capability: WorkspaceCapabilityName,
    networkName: string,
  ): Promise<boolean | "missing"> {
    const containerName = this.capabilityContainerName(capability);
    const state = await this.inspectContainer(containerName);
    if (state !== "running") {
      return "missing";
    }

    const attachedNetworks = await this.inspectContainerNetworks(containerName);
    if (attachedNetworks.has(networkName)) {
      return false;
    }

    await this.execSimpleFn("docker", [
      "network",
      "connect",
      "--alias",
      this.capabilityAlias(capability),
      networkName,
      containerName,
    ]);
    return true;
  }

  private async disconnectCapabilityFromWorkspace(
    capability: WorkspaceCapabilityName,
    networkName: string,
  ): Promise<boolean> {
    const containerName = this.capabilityContainerName(capability);
    const state = await this.inspectContainer(containerName);
    if (state === "none") {
      return false;
    }

    const attachedNetworks = await this.inspectContainerNetworks(containerName);
    if (!attachedNetworks.has(networkName)) {
      return false;
    }

    await this.execSimpleFn("docker", ["network", "disconnect", networkName, containerName]).catch(() => undefined);
    return true;
  }

  private async removeWorkspaceNetwork(networkName: string): Promise<boolean> {
    if (!await this.networkExists(networkName)) {
      return false;
    }

    try {
      await this.execSimpleFn("docker", ["network", "rm", networkName]);
      return true;
    } catch {
      return false;
    }
  }

  private async networkExists(networkName: string): Promise<boolean> {
    try {
      await this.execSimpleFn("docker", ["network", "inspect", networkName]);
      return true;
    } catch {
      return false;
    }
  }

  private async inspectContainer(name: string): Promise<"running" | "stopped" | "none"> {
    try {
      const result = await this.execSimpleFn("docker", ["inspect", "-f", "{{.State.Running}}", name]);
      return result.trim() === "true" ? "running" : "stopped";
    } catch {
      return "none";
    }
  }

  private async inspectContainerNetworks(name: string): Promise<Set<string>> {
    try {
      const result = await this.execSimpleFn("docker", [
        "inspect",
        "-f",
        '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}',
        name,
      ]);
      return new Set(
        result
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
    } catch {
      return new Set();
    }
  }
}

function normalizeCapabilityToggleRecord(value: unknown): CapabilityToggleRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    enabled: raw["enabled"] === true,
  };
}

function validateCapabilitySkillFrontmatter(text: string): string | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return "frontmatter block is missing";
  }

  const fields = new Map<string, string>();
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!keyValue) {
      return `frontmatter line is not a simple key/value pair: ${line}`;
    }

    const [, key, rawValue] = keyValue;
    if (!REQUIRED_SKILL_FRONTMATTER_KEYS.includes(key as typeof REQUIRED_SKILL_FRONTMATTER_KEYS[number])) {
      return `unexpected frontmatter key: ${key}`;
    }
    if (fields.has(key)) {
      return `duplicate frontmatter key: ${key}`;
    }

    const value = stripMatchingQuotes(rawValue.trim());
    if (!value) {
      return `frontmatter value is empty for ${key}`;
    }
    fields.set(key, value);
  }

  for (const key of REQUIRED_SKILL_FRONTMATTER_KEYS) {
    if (!fields.has(key)) {
      return `frontmatter key is missing: ${key}`;
    }
  }

  if (fields.size !== REQUIRED_SKILL_FRONTMATTER_KEYS.length) {
    return "frontmatter contains unexpected keys";
  }

  return undefined;
}

function stripMatchingQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function execSimple(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${cmd} exited with code ${code}`));
    });
  });
}
