import { spawn } from "node:child_process";
import { sanitizeWorkspaceKey } from "./sibling-containers.js";

export type WorkspaceCapabilityName = "pdfApi";

export interface CapabilityToggleRecord {
  enabled: boolean;
}

export interface WorkspaceCapabilitiesRecord {
  pdfApi?: CapabilityToggleRecord;
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
const KNOWN_WORKSPACE_CAPABILITIES: WorkspaceCapabilityName[] = ["pdfApi"];
const PDF_API_ALIAS = "pdf-api";

export function defaultWorkspaceCapabilitiesRecord(): WorkspaceCapabilitiesRecord {
  return {
    pdfApi: { enabled: false },
  };
}

export function normalizeWorkspaceCapabilitiesRecord(value: unknown): WorkspaceCapabilitiesRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    pdfApi: normalizeCapabilityToggleRecord(raw["pdfApi"]) ?? { enabled: false },
  };
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
        if (await this.disconnectCapabilityFromWorkspace(capability, networkName)) {
          result.detached.push(capability);
        }
        continue;
      }

      const attached = await this.connectCapabilityToWorkspace(capability, networkName);
      if (attached === "missing") {
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
    switch (capability) {
      case "pdfApi":
        return `${this.project}-pdf-api`;
    }
  }

  capabilityAlias(capability: WorkspaceCapabilityName): string {
    switch (capability) {
      case "pdfApi":
        return PDF_API_ALIAS;
    }
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
