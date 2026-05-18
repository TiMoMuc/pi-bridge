import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SandboxManager,
  sandboxConfigFromEnv,
  dockerExecArgs,
} from "../src/sandbox.js";
import type { Config } from "../src/config.js";

// ============================================================================
// sandboxConfigFromEnv
// ============================================================================

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    signalCliUrl: "http://localhost:8080",
    signalPhoneNumber: "+10000000000",
    anthropicApiKey: "",
    piProvider: "anthropic",
    piModel: "claude-sonnet-4-5",
    piThinkingLevel: "off",
    bridgeAccessMode: "open",
    bridgeDataDir: "/workspace",
    projectsDir: "/workspace",
    blueprintDir: "/app/__blueprint__",
    systemDir: "/app/system",
    adminPhone: undefined,
    sandboxImage: "pi-bridge-sandbox:latest",
    sandboxMemory: 536870912,
    sandboxCpus: 1000000000,
    sandboxNetwork: "none",
    sandboxCwd: ".",
    projectsHostDir: "",
    codeServer: {
      image: "pi-bridge-code-server:latest",
      bindHost: "127.0.0.1",
      portStart: 18440,
      extensionsMode: "append",
      extensions: ["ms-vscode.live-server"],
    },
    calendar: {
      enabled: false,
      bindHost: "0.0.0.0",
      port: 8789,
      publicBaseUrl: undefined,
      refreshInterval: "PT15M",
    },
    workspaceDefaults: {
      codeServerEnabled: false,
      calendarEnabled: false,
      bootEnabled: true,
    },
    nextcloud: {
      baseUrl: "",
      botSecret: "",
      webhookHost: "0.0.0.0",
      webhookPort: 8788,
      webhookPath: "/nextcloud-talk-webhook",
      apiUser: "",
      apiPassword: "",
    },
    ...overrides,
  };
}

describe("sandboxConfigFromEnv", () => {
  it("extracts sandbox config from Config", () => {
    const config = makeConfig({
      sandboxImage: "debian:slim",
      sandboxMemory: 1073741824,
      sandboxCpus: 2000000000,
      sandboxNetwork: "bridge",
      sandboxCwd: "./work",
    });
    const result = sandboxConfigFromEnv(config);
    expect(result).toEqual({
      image: "debian:slim",
      memory: 1073741824,
      cpus: 2000000000,
      network: "bridge",
      cwd: "/workspace/work",
      runtimeIdentity: undefined,
    });
  });

  it("threads the optional runtime identity override into sandbox config", () => {
    const result = sandboxConfigFromEnv(makeConfig({
      runtimeIdentity: { uid: 1001, gid: 1001, dockerSocketGid: 989 },
    }));
    expect(result.runtimeIdentity).toEqual({ uid: 1001, gid: 1001, dockerSocketGid: 989 });
  });
});

// ============================================================================
// Docker Operations (unit tests with mock executor)
// ============================================================================

describe("SandboxManager reconciliation", () => {
  it("recreates a running container when the mount validates false inside Docker", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let validationAttempts = 0;

    const mgr = new SandboxManager(
      {
        image: "pi-bridge-sandbox:latest",
        memory: 536870912,
        cpus: 1000000000,
        network: "none",
        cwd: "/workspace",
      },
      {
        execSimple: async (cmd, args) => {
          calls.push({ cmd, args });
          if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
            if (args[3] === "signal-sandbox-signal_-123") throw new Error("missing");
            return "true\n";
          }
          if (args[0] === "inspect" && args[2] === '{{json .Mounts}}') {
            return JSON.stringify([
              { Destination: '/workspace', Source: '/host/users/signal_+123' },
              { Destination: '/workspace/.bridge', Source: '/host/users/signal_+123/.bridge' },
              { Destination: '/workspace/upload', Source: '/host/users/signal_+123/upload' },
            ]);
          }
          if (args[0] === "exec" && args[1] === "pi-sandbox-signal_-123" && args[2] === "sh") {
            validationAttempts += 1;
            if (validationAttempts === 1) throw new Error("broken mount");
            return "";
          }
          return "";
        },
      },
    );

    await mgr.getOrCreateExecutor("signal_+123", "/host/users/signal_+123");

    expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "pi-sandbox-signal_-123")).toBe(true);
    expect(calls.filter(({ args }) => args[0] === "run" && args.includes("pi-sandbox-signal_-123"))).toHaveLength(1);
  });

  it("passes the configured runtime identity into new sandbox containers", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mgr = new SandboxManager(
      {
        image: "pi-bridge-sandbox:latest",
        memory: 536870912,
        cpus: 1000000000,
        network: "none",
        cwd: "/workspace",
        runtimeIdentity: { uid: 1001, gid: 1001, dockerSocketGid: 989 },
      },
      {
        execSimple: async (cmd, args) => {
          calls.push({ cmd, args });
          if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
            throw new Error("missing");
          }
          if (args[0] === "exec") {
            return "";
          }
          return "";
        },
      },
    );

    await mgr.getOrCreateExecutor("signal_+123", "/host/users/signal_+123");

    const runCall = calls.find(({ args }) => args[0] === "run");
    expect(runCall?.args).toContain("--user");
    expect(runCall?.args).toContain("1001:1001");
    expect(runCall?.args).toContain("HOME=/tmp");
  });

  it("reconciliation removes orphaned legacy containers and keeps healthy labelled ones", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-reconcile-"));
    await fs.mkdir(path.join(tmpDir, "users", "signal_+123"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "signal_+123", "work"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "signal_+123", ".bridge"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "signal_+123", "upload"), { recursive: true });

    try {
      const mgr = new SandboxManager(
        {
          image: "pi-bridge-sandbox:latest",
          memory: 536870912,
          cpus: 1000000000,
          network: "none",
          cwd: "/workspace",
        },
        {
          execSimple: async (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === "ps") {
              return [
                "pi-sandbox-signal_-123",
                "signal-sandbox-signal_-999",
              ].join("\n");
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels') && args[3] === "pi-sandbox-signal_-123") {
              return "true\tsandbox\tsignal_+123\tsignal\tpi-bridge\n";
            }
            if (args[0] === "inspect" && args[2] === '{{json .Mounts}}' && args[3] === "pi-sandbox-signal_-123") {
              return JSON.stringify([
                { Destination: "/workspace", Source: path.join(tmpDir, "users", "signal_+123") },
                { Destination: "/workspace/.bridge", Source: path.join(tmpDir, "users", "signal_+123", ".bridge") },
                { Destination: "/workspace/upload", Source: path.join(tmpDir, "users", "signal_+123", "upload") },
              ]);
            }
            if (args[0] === "exec" && args[1] === "pi-sandbox-signal_-123") {
              return "";
            }
            return "";
          },
        },
      );

      await mgr.reconcileExisting(tmpDir, {
        "signal_+123": {
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          status: "active",
          workspacePath: "users/signal_+123",
          primaryTransport: "signal",
          transports: { signal: { sender: "+123" } },
        },
      });

      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "signal-sandbox-signal_-999")).toBe(true);
      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "pi-sandbox-signal_-123")).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reconciliation keeps a labelled container when knownWorkspaces says the workspace exists", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-reconcile-known-"));

    try {
      const hostWorkspacePath = path.join(tmpDir, "host-root");
      const expectedMount = path.join(hostWorkspacePath, "users", "signal_+123");
      const mgr = new SandboxManager(
        {
          image: "pi-bridge-sandbox:latest",
          memory: 536870912,
          cpus: 1000000000,
          network: "none",
          cwd: "/workspace",
        },
        {
          execSimple: async (cmd, args) => {
            calls.push({ cmd, args });
            if (args[0] === "ps") {
              return "pi-sandbox-signal_-123\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels')) {
              return "true\tsandbox\tsignal_+123\tsignal\tpi-bridge\n";
            }
            if (args[0] === "inspect" && args[2] === '{{json .Mounts}}') {
              return JSON.stringify([
                { Destination: "/workspace", Source: expectedMount },
                { Destination: "/workspace/.bridge", Source: path.join(expectedMount, ".bridge") },
                { Destination: "/workspace/upload", Source: path.join(expectedMount, "upload") },
              ]);
            }
            if (args[0] === "exec" && args[1] === "pi-sandbox-signal_-123") {
              return "";
            }
            return "";
          },
        },
      );

      // knownWorkspaces comes from the bridge's container-local workspace root,
      // not from the Docker host path used for sibling container mount checks.
      await mgr.reconcileExisting(hostWorkspacePath, {
        "signal_+123": {
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          status: "active",
          workspacePath: "users/signal_+123",
          primaryTransport: "signal",
          transports: { signal: { sender: "+123" } },
        },
      });

      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "pi-sandbox-signal_-123")).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("Docker-backed Operations (via runner)", () => {
  // These test the Operations factory functions indirectly by importing them.
  // Since they're not exported, we test through the runner's createSenderSession
  // which is already covered by runner.test.ts. Here we test the executor
  // delegation pattern directly with a mock.

  it("adds docker exec -w when a sandbox cwd is provided", () => {
    expect(dockerExecArgs("test-container", "pwd", "/workspace/work")).toEqual([
      "exec",
      "-w",
      "/workspace/work",
      "test-container",
      "sh",
      "-c",
      "pwd",
    ]);
  });

  it("omits docker exec -w when no sandbox cwd is provided", () => {
    expect(dockerExecArgs("test-container", "pwd")).toEqual([
      "exec",
      "test-container",
      "sh",
      "-c",
      "pwd",
    ]);
  });
});
