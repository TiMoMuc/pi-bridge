import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CodeServerManager,
  codeServerContainerName,
  codeServerLocalUrl,
  codeServerPublicUrl,
  codeServerStatusUrl,
  codeServerWorkspaceMountPath,
  codeServerStatePaths,
} from "../src/code-server.js";

describe("code-server helpers", () => {
  it("builds deterministic container names", () => {
    expect(codeServerContainerName("signal_+15551234567")).toBe("code-server-signal_-15551234567");
  });

  it("formats local and public URLs", () => {
    expect(codeServerLocalUrl("127.0.0.1", 18440)).toBe("http://127.0.0.1:18440/");
    expect(codeServerLocalUrl("0.0.0.0", 18440)).toBe("http://localhost:18440/");
    expect(codeServerPublicUrl("https://code-{workspaceKey}.example.com/", "ws_a7b3c9", 18440)).toBe(
      "https://code-ws_a7b3c9.example.com/",
    );
    expect(codeServerStatusUrl({ bindHost: "0.0.0.0", publicUrlTemplate: undefined }, "ws_a7b3c9", 18440)).toBe(
      "http://localhost:18440/",
    );
    expect(codeServerStatusUrl({ bindHost: "127.0.0.1", publicUrlTemplate: "https://dev.example.com:{port}/" }, "ws_a7b3c9", 18440)).toBe(
      "https://dev.example.com:18440/",
    );
  });

  it("resolves workspace mount path", () => {
    expect(codeServerWorkspaceMountPath("/host/workspace", "signal_+1")).toBe(
      "/host/workspace/signal_+1",
    );
  });

  it("resolves persistent config and data paths", () => {
    expect(codeServerStatePaths("/host/workspace", "signal_+1")).toEqual({
      configDir: "/host/workspace/code-server/signal_+1/config",
      dataDir: "/host/workspace/code-server/signal_+1/data",
    });
  });
});

describe("CodeServerManager", () => {
  it("stops a workspace container without removing it", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mgr = new CodeServerManager(
      {
        image: "pi-bridge-code-server:latest",
        bindHost: "127.0.0.1",
        portStart: 18440,
        extensionsMode: "append",
        extensions: ["ms-vscode.live-server"],
      },
      "/tmp",
      {
        execSimple: async (cmd: string, args: string[]) => {
          calls.push({ cmd, args });
          return "";
        },
      },
    );

    await mgr.stop("ws_a7b3c9");

    expect(calls).toEqual([
      {
        cmd: "docker",
        args: ["stop", "-t", "5", "code-server-ws_a7b3c9"],
      },
    ]);
  });

  it("stopAll stops discovered code-server sibling containers", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const mgr = new CodeServerManager(
      {
        image: "pi-bridge-code-server:latest",
        bindHost: "127.0.0.1",
        portStart: 18440,
        extensionsMode: "append",
        extensions: ["ms-vscode.live-server"],
      },
      "/tmp",
      {
        execSimple: async (cmd: string, args: string[]) => {
          calls.push({ cmd, args });
          if (args[0] === "ps") {
            return ["code-server-ws_a7b3c9", "code-server-ws_f2d8e1"].join("\n");
          }
          if (args[0] === "inspect" && args[2].includes('Config.Labels') && args[3] === "code-server-ws_a7b3c9") {
            return "true\tcode-server\tws_a7b3c9\tsignal\tpi-bridge\n";
          }
          if (args[0] === "inspect" && args[2].includes('Config.Labels') && args[3] === "code-server-ws_f2d8e1") {
            return "true\tcode-server\tws_f2d8e1\tnextcloud\tpi-bridge\n";
          }
          return "";
        },
      },
    );

    await mgr.stopAll(["ws_a7b3c9", "ws_f2d8e1"]);

    expect(calls.some(({ args }) => args[0] === "stop" && args[3] === "code-server-ws_a7b3c9")).toBe(true);
    expect(calls.some(({ args }) => args[0] === "stop" && args[3] === "code-server-ws_f2d8e1")).toBe(true);
  });

  it("recreates an unlabeled matching container so labels become authoritative", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-test-"));

    try {
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        tmpDir,
        {
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
              return "true\n";
            }
            if (args[0] === "inspect" && args[2].includes('.Destination "/workspace"')) {
              return `${tmpDir}/users/signal_+123\n`;
            }
            if (args[0] === "inspect" && args[2].includes('NetworkSettings.Ports')) {
              return "127.0.0.1:18440\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels')) {
              return "\t\t\t\n";
            }
            return "";
          },
        },
      );

      await mgr.ensureRunning("signal_+123", { password: "secret", port: 18440 }, "signal");

      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "code-server-signal_-123")).toBe(true);
      expect(calls.filter(({ args }) => args[0] === "run" && args.includes("code-server-signal_-123"))).toHaveLength(1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reconciliation removes orphaned containers and stale labelled ones", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-test-"));
    await fs.mkdir(path.join(tmpDir, "signal_+123"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "users", "nextcloud_admin"), { recursive: true });

    try {
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        tmpDir,
        {
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "ps") {
              return [
                "code-server-signal_-123",
                "code-server-nextcloud_admin",
                "code-server-signal_-999",
              ].join("\n");
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels') && args[3] === "code-server-signal_-123") {
              return "true\tcode-server\tsignal_+123\tsignal\tpi-bridge\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels') && args[3] === "code-server-nextcloud_admin") {
              return "true\tcode-server\tnextcloud_admin\tnextcloud\tnextcloud-pi-bridge\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels')) {
              return "\t\t\t\t\n";
            }
            if (args[0] === "inspect" && args[2].includes('.Destination "/workspace"') && args[3] === "code-server-signal_-123") {
              return `${tmpDir}/users/signal_+123\n`;
            }
            if (args[0] === "inspect" && args[2].includes('NetworkSettings.Ports') && args[3] === "code-server-signal_-123") {
              return "127.0.0.1:18440\n";
            }
            return "";
          },
        },
      );

      await mgr.reconcileExisting(["signal_+123", "nextcloud_admin"], {
        "signal_+123": {
          primaryTransport: "signal",
          transports: { signal: { sender: "+123" } },
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          status: "active",
          workspacePath: "signal_+123",
          codeServer: { enabled: true, port: 18440 },
        },
        nextcloud_admin: {
          primaryTransport: "nextcloud",
          transports: { nextcloud: { roomToken: "room-abc", userWhitelist: [] } },
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          status: "active",
          workspacePath: "nextcloud_admin",
          codeServer: { enabled: true, port: 18441 },
        },
      });

      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "code-server-signal_-999")).toBe(true);
      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "code-server-nextcloud_admin")).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("reconciliation keeps a labelled container when knownWorkspaces says the workspace exists", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-reconcile-known-"));

    try {
      const hostWorkspaceDir = path.join(tmpDir, "host-root");
      const expectedMount = path.join(hostWorkspaceDir, "signal_+123");
      await fs.mkdir(expectedMount, { recursive: true });
      const canonicalExpectedMount = await fs.realpath(expectedMount);
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        hostWorkspaceDir,
        {
          project: "pi-bridge",
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "ps") {
              return "code-server-signal_-123\n";
            }
            if (args[0] === "inspect" && args[2].includes('io.pi-bridge.managed')) {
              return "true\tcode-server\tsignal_+123\tsignal\tpi-bridge\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels')) {
              return "code-server\tsignal_+123\tsignal\tpi-bridge\n";
            }
            if (args[0] === "inspect" && args[2] === '{{json .Mounts}}') {
              return JSON.stringify([
                { Destination: '/workspace', Source: canonicalExpectedMount },
                { Destination: '/workspace/.bridge', Source: `${canonicalExpectedMount}/.bridge` },
                { Destination: '/workspace/upload', Source: `${canonicalExpectedMount}/upload` },
                { Destination: '/root/.config', Source: path.join(hostWorkspaceDir, 'code-server', 'signal_+123', 'config') },
                { Destination: '/root/.local/share', Source: path.join(hostWorkspaceDir, 'code-server', 'signal_+123', 'data') },
              ]);
            }
            if (args[0] === "inspect" && args[2].includes('NetworkSettings.Ports')) {
              return "127.0.0.1:18440\n";
            }
            return "";
          },
        },
      );

      // knownWorkspaces comes from the bridge's container-local workspace root,
      // while hostWorkspaceDir points at the Docker-host mount namespace.
      await mgr.reconcileExisting(["signal_+123"], {
        "signal_+123": {
          primaryTransport: "signal",
          transports: { signal: { sender: "+123" } },
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeen: "2026-01-01T00:00:00.000Z",
          status: "active",
          workspacePath: "signal_+123",
          codeServer: { enabled: true, port: 18440 },
        },
      });

      expect(calls.some(({ args }) => args[0] === "rm" && args[2] === "code-server-signal_-123")).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates a new code-server container with the expected args", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-test-"));

    try {
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        tmpDir,
        {
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
              throw new Error("missing");
            }
            return "";
          },
        },
      );

      await mgr.ensureRunning("signal_+123", { password: "secret", port: 18440 }, "signal");

      const runCall = calls.find(({ args }) => args[0] === "run");
      const canonicalWorkspace = await fs.realpath(path.join(tmpDir, "signal_+123"));
      expect(runCall).toBeDefined();
      expect(runCall?.args).toContain("--user");
      expect(runCall?.args).toContain("root");
      expect(runCall?.args).toContain("127.0.0.1:18440:8080");
      expect(runCall?.args).toContain("CS_PASSWORD=secret");
      const canonicalConfigDir = await fs.realpath(path.join(tmpDir, "code-server", "signal_+123", "config"));
      const canonicalDataDir = await fs.realpath(path.join(tmpDir, "code-server", "signal_+123", "data"));
      expect(runCall?.args).toContain(`${canonicalWorkspace}:/workspace`);
      expect(runCall?.args).toContain(`${path.join(canonicalWorkspace, ".bridge") }:/workspace/.bridge:ro`.replace(" ", ""));
      expect(runCall?.args).toContain(`${path.join(canonicalWorkspace, "upload") }:/workspace/upload:ro`.replace(" ", ""));
      expect(runCall?.args).toContain(`${canonicalConfigDir}:/root/.config`);
      expect(runCall?.args).toContain(`${canonicalDataDir}:/root/.local/share`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses the optional runtime identity override for code-server state and process user", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-runtime-identity-"));

    try {
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        tmpDir,
        {
          runtimeIdentity: { uid: 1001, gid: 1001, dockerSocketGid: 989 },
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
              throw new Error("missing");
            }
            return "";
          },
        },
      );

      await mgr.ensureRunning("signal_+123", { password: "secret", port: 18440 }, "signal");

      const runCall = calls.find(({ args }) => args[0] === "run");
      const canonicalConfigDir = await fs.realpath(path.join(tmpDir, "code-server", "signal_+123", "config"));
      const canonicalDataDir = await fs.realpath(path.join(tmpDir, "code-server", "signal_+123", "data"));
      expect(runCall?.args).toContain("--user");
      expect(runCall?.args).toContain("1001:1001");
      expect(runCall?.args).toContain("HOME=/tmp");
      expect(runCall?.args).toContain("XDG_CONFIG_HOME=/tmp/pi-code-server-config");
      expect(runCall?.args).toContain("XDG_DATA_HOME=/tmp/pi-code-server-data");
      expect(runCall?.args).toContain(`${canonicalConfigDir}:/tmp/pi-code-server-config`);
      expect(runCall?.args).toContain(`${canonicalDataDir}:/tmp/pi-code-server-data`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("creates bridge-local directories but mounts host paths into the sibling container", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-paths-test-"));

    try {
      const bridgeProjectsDir = path.join(tmpDir, "bridge-projects");
      const hostProjectsDir = path.join(tmpDir, "host-projects");
      const bridgeDataDir = path.join(tmpDir, "bridge-data");
      const hostBridgeDataDir = path.join(tmpDir, "host-bridge-data");
      const workspacePath = "teams/acme";
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        hostProjectsDir,
        bridgeDataDir,
        {
          bridgeProjectsDir,
          bridgeDataHostDir: hostBridgeDataDir,
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
              throw new Error("missing");
            }
            return "";
          },
        },
      );

      await mgr.ensureRunning(
        "signal_+123",
        workspacePath,
        { password: "secret", port: 18440 },
        "signal",
      );

      await expect(fs.stat(path.join(bridgeProjectsDir, workspacePath, ".bridge"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(bridgeProjectsDir, workspacePath, "upload"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(bridgeDataDir, "code-server", "signal_+123", "config"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(bridgeDataDir, "code-server", "signal_+123", "data"))).resolves.toBeTruthy();
      await expect(fs.stat(path.join(hostProjectsDir, workspacePath))).rejects.toThrow();

      const runCall = calls.find(({ args }) => args[0] === "run");
      expect(runCall).toBeDefined();
      expect(runCall?.args).toContain(`${path.join(hostProjectsDir, workspacePath)}:/workspace`);
      expect(runCall?.args).toContain(`${path.join(hostProjectsDir, workspacePath, ".bridge")}:/workspace/.bridge:ro`);
      expect(runCall?.args).toContain(`${path.join(hostProjectsDir, workspacePath, "upload")}:/workspace/upload:ro`);
      expect(runCall?.args).toContain(`${path.join(hostBridgeDataDir, "code-server", "signal_+123", "config")}:/root/.config`);
      expect(runCall?.args).toContain(`${path.join(hostBridgeDataDir, "code-server", "signal_+123", "data")}:/root/.local/share`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("restarts a stopped matching container instead of recreating it", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-test-"));

    try {
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        tmpDir,
        {
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
              return "false\n";
            }
            if (args[0] === "inspect" && args[2] === '{{json .Mounts}}') {
              return JSON.stringify([
                { Destination: '/workspace', Source: `${tmpDir}/signal_+123` },
                { Destination: '/workspace/.bridge', Source: `${tmpDir}/signal_+123/.bridge` },
                { Destination: '/workspace/upload', Source: `${tmpDir}/signal_+123/upload` },
                { Destination: '/root/.config', Source: `${tmpDir}/code-server/signal_+123/config` },
                { Destination: '/root/.local/share', Source: `${tmpDir}/code-server/signal_+123/data` },
              ]);
            }
            if (args[0] === "inspect" && args[2].includes('NetworkSettings.Ports')) {
              return "127.0.0.1:18440\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels')) {
              return "code-server\tsignal_+123\tsignal\tpi-bridge\n";
            }
            return "";
          },
        },
      );

      await mgr.ensureRunning("signal_+123", { password: "secret", port: 18440 }, "signal");

      expect(calls.some(({ args }) => args[0] === "start" && args[1] === "code-server-signal_-123")).toBe(true);
      expect(calls.some(({ args }) => args[0] === "run")).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("recreates a stale container when mount or port changed", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-server-test-"));

    try {
      const mgr = new CodeServerManager(
        {
          image: "pi-bridge-code-server:latest",
          bindHost: "127.0.0.1",
          portStart: 18440,
          extensionsMode: "append",
          extensions: ["ms-vscode.live-server"],
        },
        tmpDir,
        {
          execSimple: async (cmd: string, args: string[]) => {
            calls.push({ cmd, args });
            if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
              return "true\n";
            }
            if (args[0] === "inspect" && args[2].includes('.Destination "/workspace"')) {
              return `${tmpDir}/users/signal_+123\n`;
            }
            if (args[0] === "inspect" && args[2].includes('NetworkSettings.Ports')) {
              return "127.0.0.1:19999\n";
            }
            if (args[0] === "inspect" && args[2].includes('Config.Labels')) {
              return "code-server\tsignal_+123\tsignal\tpi-bridge\n";
            }
            return "";
          },
        },
      );

      await mgr.ensureRunning("signal_+123", { password: "secret", port: 18440 }, "signal");

      expect(calls.some(({ args }) => args[0] === "rm" && args[1] === "-f")).toBe(true);
      expect(calls.some(({ args }) => args[0] === "run")).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
