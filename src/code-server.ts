/**
 * Docker-managed per-workspace code-server containers.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { CodeServerConfig } from "./config.js";
import type { WorkspaceRecord } from "./provisioner.js";
import type { TransportName } from "./transport.js";
import { codeServerStatePaths as bridgeCodeServerStatePaths, normalizeWorkspacePath, workspacePaths } from "./workspace-paths.js";
import {
  SIBLING_PROJECT_LABEL,
  SIBLING_ROLE_LABEL,
  SIBLING_TRANSPORT_LABEL,
  SIBLING_WORKSPACE_LABEL,
  canonicalizePath,
  codeServerContainerName,
  discoverSiblingContainers,
  siblingLabelArgs,
  type SiblingContainerStatus,
} from "./sibling-containers.js";

export { codeServerContainerName } from "./sibling-containers.js";

export interface CodeServerAccess {
  password: string;
  port: number;
}

interface CodeServerManagerDeps {
  execSimple?: typeof execSimple;
  project?: string;
  bridgeProjectsDir?: string;
  bridgeDataHostDir?: string;
}

export function codeServerLocalUrl(bindHost: string, port: number): string {
  const host = bindHost === "0.0.0.0" ? "localhost" : bindHost;
  return `http://${host}:${port}/`;
}

export function codeServerWorkspaceMountPath(
  hostProjectsDir: string,
  workspacePath: string,
): string {
  return workspacePaths(hostProjectsDir, normalizeWorkspacePath(workspacePath)).root;
}

export function codeServerStatePaths(bridgeDataDir: string, workspaceKey: string): {
  configDir: string;
  dataDir: string;
} {
  return bridgeCodeServerStatePaths(bridgeDataDir, workspaceKey);
}

export class CodeServerManager {
  private readonly containers = new Map<string, string>();
  private readonly execSimpleFn: typeof execSimple;
  private readonly project: string;
  private readonly bridgeProjectsDir: string;
  private readonly bridgeDataDir: string;
  private readonly bridgeDataHostDir: string;

  constructor(
    private readonly config: CodeServerConfig,
    private readonly hostProjectsDir: string,
    bridgeDataDirOrDeps: string | CodeServerManagerDeps = hostProjectsDir,
    deps: CodeServerManagerDeps = {},
  ) {
    if (typeof bridgeDataDirOrDeps === "string") {
      this.bridgeProjectsDir = deps.bridgeProjectsDir ?? hostProjectsDir;
      this.bridgeDataDir = bridgeDataDirOrDeps;
      this.bridgeDataHostDir = deps.bridgeDataHostDir ?? this.bridgeDataDir;
      this.execSimpleFn = deps.execSimple ?? execSimple;
      this.project = deps.project ?? process.env["BRIDGE_CONTAINER_NAME"] ?? "pi-bridge";
    } else {
      this.bridgeProjectsDir = bridgeDataDirOrDeps.bridgeProjectsDir ?? hostProjectsDir;
      this.bridgeDataDir = hostProjectsDir;
      this.bridgeDataHostDir = bridgeDataDirOrDeps.bridgeDataHostDir ?? this.bridgeDataDir;
      this.execSimpleFn = bridgeDataDirOrDeps.execSimple ?? execSimple;
      this.project = bridgeDataDirOrDeps.project ?? process.env["BRIDGE_CONTAINER_NAME"] ?? "pi-bridge";
    }
  }

  async validate(): Promise<void> {
    try {
      await this.execSimpleFn("docker", ["--version"]);
    } catch {
      throw new Error("Docker is not available. Install Docker for code-server sibling containers.");
    }
  }

  async ensureRunning(
    workspaceKey: string,
    workspacePathOrAccess: string | CodeServerAccess,
    accessOrTransport: CodeServerAccess | TransportName | "unknown",
    transport: TransportName | "unknown" = "unknown",
  ): Promise<void> {
    const workspacePath = typeof workspacePathOrAccess === "string" ? workspacePathOrAccess : workspaceKey;
    const access = typeof workspacePathOrAccess === "string"
      ? accessOrTransport as CodeServerAccess
      : workspacePathOrAccess;
    const effectiveTransport = typeof workspacePathOrAccess === "string"
      ? transport
      : accessOrTransport as TransportName | "unknown";

    const containerName = codeServerContainerName(workspaceKey);
    const bridgeWorkspacePath = workspacePaths(this.bridgeProjectsDir, normalizeWorkspacePath(workspacePath)).root;
    const hostWorkspacePath = codeServerWorkspaceMountPath(
      this.hostProjectsDir,
      workspacePath,
    );
    const bridgeStatePaths = codeServerStatePaths(this.bridgeDataDir, workspaceKey);
    const hostStatePaths = codeServerStatePaths(this.bridgeDataHostDir, workspaceKey);

    await fs.mkdir(bridgeWorkspacePath, { recursive: true });
    await fs.mkdir(path.join(bridgeWorkspacePath, ".bridge"), { recursive: true });
    await fs.mkdir(path.join(bridgeWorkspacePath, "upload"), { recursive: true });
    await fs.mkdir(bridgeStatePaths.configDir, { recursive: true });
    await fs.mkdir(bridgeStatePaths.dataDir, { recursive: true });

    const canonicalWorkspacePath = await canonicalizePath(hostWorkspacePath);
    const canonicalStatePaths = {
      configDir: await canonicalizePath(hostStatePaths.configDir),
      dataDir: await canonicalizePath(hostStatePaths.dataDir),
    };

    const state = await this.inspectContainer(containerName);

    if (state === "running" || state === "stopped") {
      const [existingMounts, existingPort, labelsMatch] = await Promise.all([
        this.inspectCanonicalMounts(containerName),
        this.inspectPublishedPort(containerName),
        this.inspectExpectedLabels(containerName, workspaceKey, effectiveTransport),
      ]);
      const expectedPort = `${this.config.bindHost}:${access.port}`;
      if (codeServerMountsMatch(existingMounts, canonicalWorkspacePath, canonicalStatePaths) && existingPort === expectedPort && labelsMatch) {
        if (state === "stopped") {
          await this.execSimpleFn("docker", ["start", containerName]);
          console.log(`[code-server] Restarted stopped container: ${containerName}`);
        } else {
          console.log(`[code-server] Reattached to running container: ${containerName}`);
        }
        this.containers.set(workspaceKey, containerName);
        return;
      }

      console.log(
        `[code-server] Stale container config on ${containerName} (${formatCodeServerMountSummary(existingMounts)}, ${existingPort ?? "no-port"}, labels=${labelsMatch ? "ok" : "stale"}), recreating`,
      );
      await this.removeContainer(containerName);
    }

    await this.createContainer(containerName, canonicalWorkspacePath, canonicalStatePaths, access, workspaceKey, effectiveTransport);
    this.containers.set(workspaceKey, containerName);
    console.log(`[code-server] Ensured ${containerName} on ${codeServerLocalUrl(this.config.bindHost, access.port)}`);
  }

  async recreate(
    workspaceKey: string,
    workspacePathOrAccess: string | CodeServerAccess,
    accessOrTransport: CodeServerAccess | TransportName | "unknown",
    transport: TransportName | "unknown" = "unknown",
  ): Promise<void> {
    await this.removeContainer(codeServerContainerName(workspaceKey));
    this.containers.delete(workspaceKey);
    if (typeof workspacePathOrAccess === "string") {
      await this.ensureRunning(workspaceKey, workspacePathOrAccess, accessOrTransport as CodeServerAccess, transport);
      return;
    }
    await this.ensureRunning(workspaceKey, workspacePathOrAccess, accessOrTransport as TransportName | "unknown");
  }

  async stop(workspaceKey: string): Promise<void> {
    await this.stopContainer(codeServerContainerName(workspaceKey));
    this.containers.delete(workspaceKey);
  }

  async stopAll(knownWorkspaces: string[]): Promise<void> {
    const discovered = (await discoverSiblingContainers(this.execSimpleFn, knownWorkspaces))
      .filter((container) => container.role === "code-server" && container.workspaceKey);

    if (discovered.length === 0) return;

    await Promise.allSettled(
      discovered.map((container) => this.stopContainer(container.name)),
    );

    this.containers.clear();
  }

  async reconcileExisting(
    knownWorkspaces: string[],
    workspaces: Record<string, WorkspaceRecord>,
  ): Promise<void> {
    const discovered = (await discoverSiblingContainers(this.execSimpleFn, knownWorkspaces))
      .filter((container) => container.role === "code-server");

    if (discovered.length === 0) {
      console.log("[code-server] Reconciliation: no sibling code-server containers found");
      return;
    }

    const summary: Record<SiblingContainerStatus, number> = {
      healthy: 0,
      stale: 0,
      orphaned: 0,
      legacy: 0,
    };

    for (const container of discovered) {
      const workspaceKey = container.workspaceKey;
      if (!workspaceKey) {
        summary.orphaned += 1;
        console.warn(`[code-server] Reconciliation: removing orphaned container ${container.name} (workspace unknown)`);
        await this.removeContainer(container.name);
        continue;
      }

      if (!knownWorkspaces.includes(workspaceKey) || !workspaces[workspaceKey]) {
        summary.orphaned += 1;
        console.warn(`[code-server] Reconciliation: removing orphaned container ${container.name} (workspace missing: ${workspaceKey})`);
        await this.removeContainer(container.name);
        continue;
      }

      if (!container.labelled) {
        summary.legacy += 1;
        console.warn(`[code-server] Reconciliation: removing unlabeled legacy container ${container.name} for ${workspaceKey}; it will be recreated on restore or explicit up`);
        await this.removeContainer(container.name);
        continue;
      }

      const expectedMountRaw = codeServerWorkspaceMountPath(
        this.hostProjectsDir,
        workspaces[workspaceKey]?.workspacePath ?? workspaceKey,
      );
      const expectedMount = await canonicalizePath(expectedMountRaw);
      const expectedPortNumber = workspaces[workspaceKey]?.codeServer?.port;
      const expectedPort = expectedPortNumber ? `${this.config.bindHost}:${expectedPortNumber}` : null;
      const expectedTransport = workspaces[workspaceKey]?.primaryTransport ?? "unknown";
      const statePaths = codeServerStatePaths(this.bridgeDataHostDir, workspaceKey);
      const canonicalStatePaths = {
        configDir: await canonicalizePath(statePaths.configDir),
        dataDir: await canonicalizePath(statePaths.dataDir),
      };
      const [existingMounts, existingPort, labelsMatch] = await Promise.all([
        this.inspectCanonicalMounts(container.name),
        this.inspectPublishedPort(container.name),
        this.inspectExpectedLabels(container.name, workspaceKey, expectedTransport),
      ]);
      const healthy = codeServerMountsMatch(existingMounts, expectedMount, canonicalStatePaths)
        && (!expectedPort || existingPort === expectedPort)
        && labelsMatch;
      if (!healthy) {
        summary.stale += 1;
        console.warn(`[code-server] Reconciliation: removing stale container ${container.name} for ${workspaceKey}`);
        await this.removeContainer(container.name);
        continue;
      }

      summary.healthy += 1;
      console.log(`[code-server] Reconciliation: healthy ${container.name} (${workspaceKey})`);
    }

    console.log(
      `[code-server] Reconciliation summary: healthy=${summary.healthy}, stale=${summary.stale}, orphaned=${summary.orphaned}, legacy=${summary.legacy}`,
    );
  }

  private async createContainer(
    name: string,
    workspacePath: string,
    statePaths: { configDir: string; dataDir: string },
    access: CodeServerAccess,
    workspaceKey: string,
    transport: TransportName | "unknown",
  ): Promise<void> {
    const args = [
      "run", "-d",
      "--name", name,
      ...siblingLabelArgs({
        role: "code-server",
        workspaceKey,
        transport,
        project: this.project,
      }),
      "--restart", "unless-stopped",
      "--user", "root",
      "-p", `${this.config.bindHost}:${access.port}:8080`,
      "-e", "CS_BIND_ADDR=0.0.0.0:8080",
      "-e", "CS_AUTH=password",
      "-e", `CS_PASSWORD=${access.password}`,
      "-e", "CS_WORKSPACE=/workspace",
      "-e", "CS_PROFILE=minimal",
      "-e", "CS_DISABLE_AI=true",
      "-e", "CS_DISABLE_TELEMETRY=true",
      "-e", "CS_DISABLE_PROXY=false",
      "-e", "CS_DISABLE_GETTING_STARTED=true",
      "-e", "CS_DISABLE_DOWNLOADS=false",
      "-e", "CS_HIDE_ACTIVITY_BAR=true",
      "-e", "CS_HIDE_SECONDARY_SIDEBAR=true",
      "-e", "CS_HIDE_STATUS_BAR=false",
      "-e", "CS_HIDE_MENU_BAR=true",
      "-e", "CS_TRUST_WORKSPACE=false",
      "-e", `CS_EXTRA_EXTENSIONS=${this.config.extensions.join(",")}`,
      "-v", `${workspacePath}:/workspace`,
      "-v", `${path.join(workspacePath, ".bridge")}:/workspace/.bridge:ro`,
      "-v", `${path.join(workspacePath, "upload")}:/workspace/upload:ro`,
      "-v", `${statePaths.configDir}:/root/.config`,
      "-v", `${statePaths.dataDir}:/root/.local/share`,
      "-w", "/workspace",
      this.config.image,
    ];

    await this.execSimpleFn("docker", args);
  }

  private async inspectContainer(name: string): Promise<"running" | "stopped" | "none"> {
    try {
      const result = await this.execSimpleFn("docker", ["inspect", "-f", "{{.State.Running}}", name]);
      return result.trim() === "true" ? "running" : "stopped";
    } catch {
      return "none";
    }
  }

  private async inspectCanonicalMounts(name: string): Promise<Record<string, string>> {
    const mounts = await this.inspectMounts(name);
    const canonical: Record<string, string> = {};
    for (const [destination, source] of Object.entries(mounts)) {
      canonical[destination] = await canonicalizePath(source);
    }
    return canonical;
  }

  private async inspectMounts(name: string): Promise<Record<string, string>> {
    try {
      const result = await this.execSimpleFn("docker", [
        "inspect",
        "-f",
        '{{json .Mounts}}',
        name,
      ]);
      const mounts = JSON.parse(result.trim()) as Array<{ Destination?: string; Source?: string }>;
      const relevant: Record<string, string> = {};
      for (const mount of mounts) {
        if (!mount.Destination || !mount.Source) continue;
        if (
          mount.Destination === "/workspace"
          || mount.Destination === "/workspace/.bridge"
          || mount.Destination === "/workspace/upload"
          || mount.Destination === "/root/.config"
          || mount.Destination === "/root/.local/share"
        ) {
          relevant[mount.Destination] = mount.Source;
        }
      }
      return relevant;
    } catch {
      return {};
    }
  }

  private async inspectPublishedPort(name: string): Promise<string | null> {
    try {
      const result = await this.execSimpleFn("docker", [
        "inspect", "-f",
        '{{with (index (index .NetworkSettings.Ports "8080/tcp") 0)}}{{.HostIp}}:{{.HostPort}}{{end}}',
        name,
      ]);
      return result.trim() || null;
    } catch {
      return null;
    }
  }

  private async inspectExpectedLabels(
    name: string,
    workspaceKey: string,
    transport: TransportName | "unknown",
  ): Promise<boolean> {
    try {
      const result = await this.execSimpleFn("docker", [
        "inspect",
        "-f",
        `{{index .Config.Labels "${SIBLING_ROLE_LABEL}"}}\t{{index .Config.Labels "${SIBLING_WORKSPACE_LABEL}"}}\t{{index .Config.Labels "${SIBLING_TRANSPORT_LABEL}"}}\t{{index .Config.Labels "${SIBLING_PROJECT_LABEL}"}}`,
        name,
      ]);
      const [role, workspace, actualTransport, project] = result.trimEnd().split("\t");
      return role === "code-server"
        && workspace === workspaceKey
        && actualTransport === transport
        && project === this.project;
    } catch {
      return false;
    }
  }

  private async stopContainer(name: string): Promise<void> {
    try {
      await this.execSimpleFn("docker", ["stop", "-t", "5", name]);
    } catch {
      // ignore missing containers
    }
  }

  private async removeContainer(name: string): Promise<void> {
    try {
      await this.execSimpleFn("docker", ["rm", "-f", name]);
    } catch {
      // ignore missing containers
    }
  }
}

function codeServerMountsMatch(
  mounts: Record<string, string>,
  workspaceRoot: string,
  statePaths: { configDir: string; dataDir: string },
): boolean {
  return mounts["/workspace"] === workspaceRoot
    && mounts["/workspace/.bridge"] === path.join(workspaceRoot, ".bridge")
    && mounts["/workspace/upload"] === path.join(workspaceRoot, "upload")
    && mounts["/root/.config"] === statePaths.configDir
    && mounts["/root/.local/share"] === statePaths.dataDir;
}

function formatCodeServerMountSummary(mounts: Record<string, string>): string {
  return Object.entries(mounts).map(([dest, src]) => `${dest}=${src}`).join(", ") || "no-mounts";
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
