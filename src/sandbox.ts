/**
 * Docker sandbox: per-workspace container lifecycle.
 *
 * Uses the Docker CLI (`docker`) rather than the Engine REST API — simpler,
 * no extra dependencies, same pattern as pi-mono/packages/mom/src/sandbox.ts.
 *
 * Container lifecycle:
 *   - Created on first message → stays running (tail -f /dev/null)
 *   - Bridge does `docker exec` for every tool call
 *   - Reattaches to existing containers on restart
 *   - Stopped on SIGTERM
 *
 * Container naming: pi-sandbox-{sanitized-workspace-key}
 *   Legacy containers may still use signal-sandbox-{sanitized-workspace-key}.
 *
 * Filesystem: the host workspace root is bind-mounted to /workspace inside the container.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { resolveSandboxCwd, SANDBOX_WORKSPACE_ROOT, type Config, type RuntimeIdentityConfig } from "./config.js";
import type { WorkspaceRecord } from "./provisioner.js";
import type { TransportName } from "./transport.js";
import { WORKSPACE_BRIDGE_DIRNAME, WORKSPACE_UPLOAD_DIRNAME, workspacePaths } from "./workspace-paths.js";
import {
  LEGACY_SANDBOX_CONTAINER_PREFIX,
  canonicalizePath,
  discoverSiblingContainers,
  sandboxContainerName,
  sanitizeWorkspaceKey,
  siblingLabelArgs,
  type SiblingContainerStatus,
} from "./sibling-containers.js";

const SANDBOX_MOUNT_ROOT = SANDBOX_WORKSPACE_ROOT;

// ============================================================================
// Types
// ============================================================================

export interface SandboxConfig {
  image: string;       // e.g. "pi-bridge-sandbox:latest"
  memory: number;      // bytes, e.g. 536870912 (512MB)
  cpus: number;        // nanoCPUs, e.g. 1_000_000_000 (1 CPU)
  network: string;     // Docker network name, e.g. "none" or "bridge"
  cwd: string;         // in-container cwd for sandboxed tool execution
  runtimeIdentity?: RuntimeIdentityConfig;
}

export function sandboxConfigFromEnv(config: Config): SandboxConfig {
  return {
    image: config.sandboxImage,
    memory: config.sandboxMemory,
    cpus: config.sandboxCpus,
    network: config.sandboxNetwork,
    cwd: resolveSandboxCwd(config.sandboxCwd),
    runtimeIdentity: config.runtimeIdentity,
  };
}

/**
 * Auto-detect the host-side path that is bind-mounted to a container path.
 * Uses `docker inspect` on the bridge's own container. This is the Docker-in-Docker
 * pattern: the bridge runs inside Docker and needs host paths for sibling container mounts.
 *
 * @param containerName - the bridge container name (e.g. "pi-bridge")
 * @param containerPath - the mount destination inside the bridge (e.g. "/workspace")
 * @returns the host-side source path, or null if not found
 */
export async function detectHostMount(
  containerName: string,
  containerPath: string,
): Promise<string | null> {
  try {
    const result = await execSimple("docker", [
      "inspect", containerName,
      "--format",
      `{{range .Mounts}}{{if eq .Destination "${containerPath}"}}{{.Source}}{{end}}{{end}}`,
    ]);
    const hostPath = result.trim();
    return hostPath || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Executor interface (same as mom)
// ============================================================================

export interface ExecOptions {
  timeout?: number;
  signal?: AbortSignal;
  cwd?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Executor {
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
}

// ============================================================================
// Docker executor (sandbox)
// ============================================================================

export class DockerExecutor implements Executor {
  constructor(private readonly container: string) {}

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    return execCommand(
      "docker",
      dockerExecArgs(this.container, command, options?.cwd),
      { timeout: options?.timeout, signal: options?.signal },
    );
  }
}

export function dockerExecArgs(container: string, command: string, cwd?: string): string[] {
  return [
    "exec",
    ...(cwd ? ["-w", cwd] : []),
    container,
    "sh",
    "-c",
    command,
  ];
}

// ============================================================================
// Sandbox manager — creates/reuses containers per sandbox ID
// ============================================================================

interface SandboxManagerDeps {
  execSimple?: typeof execSimple;
  project?: string;
}

export class SandboxManager {
  private readonly containers = new Map<string, string>(); // sandboxId → containerName
  private readonly execSimpleFn: typeof execSimple;
  private readonly project: string;

  constructor(
    private readonly sandboxConfig: SandboxConfig,
    deps: SandboxManagerDeps = {},
  ) {
    this.execSimpleFn = deps.execSimple ?? execSimple;
    this.project = deps.project ?? process.env["BRIDGE_CONTAINER_NAME"] ?? "pi-bridge";
  }

  /**
   * Get or create a container for the given workspace key.
   * workspacePath is the host path to bind-mount into the container.
   */
  async getOrCreateExecutor(
    sandboxId: string,
    workspacePath: string,
    transport: TransportName | "unknown" = "unknown",
  ): Promise<DockerExecutor> {
    const containerName = this.containerName(sandboxId);
    const canonicalWorkspacePath = await canonicalizePath(workspacePath);

    await this.removeLegacyContainerIfPresent(sandboxId);

    const state = await this.inspectContainer(containerName);
    if (state === "running" || state === "stopped") {
      const existingMounts = await this.inspectCanonicalMounts(containerName);
      const mountMatches = mountsMatch(existingMounts, canonicalWorkspacePath);
      if (mountMatches) {
        if (state === "stopped") {
          await this.execSimpleFn("docker", ["start", containerName]);
          console.log(`[sandbox] Restarted stopped container: ${containerName}`);
        }

        const healthy = await this.validateWorkspaceMount(containerName);
        if (healthy) {
          if (state === "running") {
            console.log(`[sandbox] Reattached to running container: ${containerName}`);
          }
          this.containers.set(sandboxId, containerName);
          return new DockerExecutor(containerName);
        }

        console.warn(`[sandbox] Broken mount on ${containerName}; recreating`);
      } else {
        console.log(`[sandbox] Stale mount on ${containerName} (${formatMountSummary(existingMounts)} != ${canonicalWorkspacePath}), recreating`);
      }

      await this.removeContainerByName(containerName);
    }

    await this.createContainer(containerName, canonicalWorkspacePath, sandboxId, transport);
    const healthy = await this.validateWorkspaceMount(containerName);
    if (!healthy) {
      await this.removeContainerByName(containerName);
      throw new Error(
        `Sandbox ${containerName} failed validation after create — expected ${SANDBOX_MOUNT_ROOT} and ${this.sandboxConfig.cwd} to exist.`,
      );
    }

    this.containers.set(sandboxId, containerName);
    console.log(`[sandbox] Created container: ${containerName}`);
    return new DockerExecutor(containerName);
  }

  /** Stop all managed containers. Called on SIGTERM. */
  async stopAll(): Promise<void> {
    const entries = [...this.containers.entries()];
    if (entries.length === 0) return;

    console.log(`[sandbox] Stopping ${entries.length} containers...`);
    await Promise.allSettled(
      entries.map(([, name]) => this.execSimpleFn("docker", ["stop", "-t", "5", name])),
    );
    this.containers.clear();
    console.log("[sandbox] All containers stopped");
  }

  /** Stop a specific sandbox container. */
  async stop(sandboxId: string): Promise<void> {
    const containerName = this.containerName(sandboxId);
    try {
      await this.execSimpleFn("docker", ["stop", "-t", "5", containerName]);
    } catch {
      // Already stopped
    }
    this.containers.delete(sandboxId);
  }

  /** Remove a specific sandbox container so the next access recreates it. */
  async remove(sandboxId: string): Promise<void> {
    await this.removeContainerByName(this.containerName(sandboxId));
    await this.removeLegacyContainerIfPresent(sandboxId);
    this.containers.delete(sandboxId);
  }

  async reconcileExisting(
    hostProjectsDir: string,
    workspaces: Record<string, WorkspaceRecord>,
  ): Promise<void> {
    const knownWorkspaces = Object.keys(workspaces);
    const discovered = (await discoverSiblingContainers(this.execSimpleFn, knownWorkspaces))
      .filter((container) => container.role === "sandbox");

    if (discovered.length === 0) {
      console.log("[sandbox] Reconciliation: no sibling sandbox containers found");
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
        console.warn(`[sandbox] Reconciliation: removing orphaned container ${container.name} (workspace unknown)`);
        await this.removeContainerByName(container.name);
        continue;
      }

      if (!knownWorkspaces.includes(workspaceKey)) {
        summary.orphaned += 1;
        console.warn(`[sandbox] Reconciliation: removing orphaned container ${container.name} (workspace missing: ${workspaceKey})`);
        await this.removeContainerByName(container.name);
        continue;
      }

      const record = workspaces[workspaceKey];
      if (!record) {
        summary.orphaned += 1;
        console.warn(`[sandbox] Reconciliation: removing orphaned container ${container.name} (workspace record missing: ${workspaceKey})`);
        await this.removeContainerByName(container.name);
        continue;
      }

      const workspacePath = workspacePaths(hostProjectsDir, record.workspacePath).root;

      if (container.legacy || !container.labelled) {
        summary.legacy += 1;
        console.warn(`[sandbox] Reconciliation: removing legacy container ${container.name} for ${workspaceKey}; it will be recreated with labels on next use`);
        await this.removeContainerByName(container.name);
        continue;
      }

      const expectedMount = await canonicalizePath(workspacePath);
      const existingMounts = await this.inspectCanonicalMounts(container.name);
      const healthy = mountsMatch(existingMounts, expectedMount) && await this.validateWorkspaceMount(container.name);
      if (!healthy) {
        summary.stale += 1;
        console.warn(`[sandbox] Reconciliation: removing stale container ${container.name} for ${workspaceKey}`);
        await this.removeContainerByName(container.name);
        continue;
      }

      summary.healthy += 1;
      console.log(`[sandbox] Reconciliation: healthy ${container.name} (${workspaceKey})`);
    }

    console.log(
      `[sandbox] Reconciliation summary: healthy=${summary.healthy}, stale=${summary.stale}, orphaned=${summary.orphaned}, legacy=${summary.legacy}`,
    );
  }

  /** Validate Docker is available. Call once at startup. */
  async validate(): Promise<void> {
    try {
      await this.execSimpleFn("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    } catch {
      throw new Error(
        "Docker is not available or the bridge cannot access the Docker daemon. Check Docker, /var/run/docker.sock, and any configured BRIDGE_RUNTIME_UID / BRIDGE_RUNTIME_GID / BRIDGE_DOCKER_SOCKET_GID values.",
      );
    }
  }

  // ---------- internals ----------

  private containerName(sandboxId: string): string {
    return sandboxContainerName(sandboxId);
  }

  private legacyContainerName(sandboxId: string): string {
    return `${LEGACY_SANDBOX_CONTAINER_PREFIX}${sanitizeWorkspaceKey(sandboxId)}`;
  }

  private async inspectContainer(name: string): Promise<"running" | "stopped" | "none"> {
    try {
      const result = await this.execSimpleFn("docker", [
        "inspect", "-f", "{{.State.Running}}", name,
      ]);
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
        if (mount.Destination === "/workspace" || mount.Destination === "/workspace/.bridge" || mount.Destination === "/workspace/upload") {
          relevant[mount.Destination] = mount.Source;
        }
      }
      return relevant;
    } catch {
      return {};
    }
  }

  private async validateWorkspaceMount(name: string): Promise<boolean> {
    try {
      await this.execSimpleFn("docker", [
        "exec",
        name,
        "sh",
        "-c",
        this.validateWorkspaceCommand(),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  private validateWorkspaceCommand(): string {
    return [
      `test -d ${shellArg(SANDBOX_MOUNT_ROOT)}`,
      `test -d ${shellArg(this.sandboxConfig.cwd)}`,
      `test -d ${shellArg(path.posix.join(SANDBOX_MOUNT_ROOT, WORKSPACE_BRIDGE_DIRNAME))}`,
      `test -d ${shellArg(path.posix.join(SANDBOX_MOUNT_ROOT, WORKSPACE_UPLOAD_DIRNAME))}`,
    ].join(" && ");
  }

  private async createContainer(
    name: string,
    workspacePath: string,
    sandboxId: string,
    transport: TransportName | "unknown",
  ): Promise<void> {
    const { image, memory, cpus, network, runtimeIdentity } = this.sandboxConfig;
    const runtimeUser = runtimeIdentity ? `${runtimeIdentity.uid}:${runtimeIdentity.gid}` : undefined;

    const args = [
      "run", "-d",
      "--name", name,
      ...siblingLabelArgs({
        role: "sandbox",
        workspaceKey: sandboxId,
        transport,
        project: this.project,
      }),
      ...(runtimeUser ? ["--user", runtimeUser, "-e", "HOME=/tmp"] : []),
      "--memory", String(memory),
      "--cpus", String(cpus / 1_000_000_000), // Docker CLI uses fractional CPUs
      "--network", network,
      "-v", `${workspacePath}:/workspace`,
      "-v", `${path.join(workspacePath, WORKSPACE_BRIDGE_DIRNAME)}:/workspace/.bridge:ro`,
      "-v", `${path.join(workspacePath, WORKSPACE_UPLOAD_DIRNAME)}:/workspace/upload:ro`,
      "-w", "/workspace",
      image,
      "tail", "-f", "/dev/null",
    ];

    await this.execSimpleFn("docker", args);
  }

  private async removeLegacyContainerIfPresent(sandboxId: string): Promise<void> {
    const legacyName = this.legacyContainerName(sandboxId);
    const state = await this.inspectContainer(legacyName);
    if (state === "none") return;
    console.warn(`[sandbox] Removing legacy container ${legacyName}; it will be recreated as ${this.containerName(sandboxId)}`);
    await this.removeContainerByName(legacyName);
  }

  private async removeContainerByName(name: string): Promise<void> {
    try {
      await this.execSimpleFn("docker", ["rm", "-f", name]);
    } catch {
      // ignore missing containers
    }
  }
}

// ============================================================================
// Mount comparison helpers
// ============================================================================

function mountsMatch(mounts: Record<string, string>, workspaceRoot: string): boolean {
  return mounts["/workspace"] === workspaceRoot
    && mounts["/workspace/.bridge"] === path.join(workspaceRoot, WORKSPACE_BRIDGE_DIRNAME)
    && mounts["/workspace/upload"] === path.join(workspaceRoot, WORKSPACE_UPLOAD_DIRNAME);
}

function formatMountSummary(mounts: Record<string, string>): string {
  return Object.entries(mounts).map(([dest, src]) => `${dest}=${src}`).join(", ") || "no-mounts";
}

// ============================================================================
// Shell helpers
// ============================================================================

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function execCommand(
  cmd: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: cmd !== "docker", // Only detach for direct shell commands
      cwd: options?.cwd,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeoutHandle =
      options?.timeout && options.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            killProcess(child.pid!);
          }, options.timeout * 1000)
        : undefined;

    const onAbort = () => {
      if (child.pid) killProcess(child.pid);
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (stdout.length > 10 * 1024 * 1024) {
        stdout = stdout.slice(0, 10 * 1024 * 1024);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
      if (stderr.length > 10 * 1024 * 1024) {
        stderr = stderr.slice(0, 10 * 1024 * 1024);
      }
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (options?.signal) {
        options.signal.removeEventListener("abort", onAbort);
      }

      if (options?.signal?.aborted) {
        reject(new Error(`${stdout}\n${stderr}\nCommand aborted`.trim()));
        return;
      }

      if (timedOut) {
        reject(
          new Error(
            `${stdout}\n${stderr}\nCommand timed out after ${options?.timeout} seconds`.trim(),
          ),
        );
        return;
      }

      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });
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

function killProcess(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already dead
    }
  }
}
