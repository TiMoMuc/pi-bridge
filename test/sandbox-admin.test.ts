import { describe, expect, it, vi } from "vitest";
import {
  dockerExecArgs,
  migrateLegacySandboxAdminHistory,
  runSandboxAdminCommand,
} from "../src/sandbox-admin.js";

describe("sandbox-admin", () => {
  it("runs the shared attach → exec → disconnect flow and appends a structured history entry", async () => {
    const execSimple = vi.fn(async (_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "inspect pi-bridge") return "";
      if (joined === "inspect pi-sandbox-ws_a7b3c9") return "";
      if (joined === "inspect -f {{.State.Running}} pi-sandbox-ws_a7b3c9") return "true\n";
      if (joined.includes(".NetworkSettings.Networks") && args.at(-1) === "pi-bridge") return "pi_default\n";
      if (joined.includes(".NetworkSettings.Networks") && args.at(-1) === "pi-sandbox-ws_a7b3c9") return "none\n";
      if (joined === "network connect pi_default pi-sandbox-ws_a7b3c9") return "";
      if (joined === "network disconnect pi_default pi-sandbox-ws_a7b3c9") return "";
      throw new Error(`unexpected docker call: ${joined}`);
    });
    const execCommand = vi.fn(async () => ({ stdout: "done\n", stderr: "", code: 0 }));
    const mkdir = vi.fn(async () => undefined);
    const appendFile = vi.fn(async () => undefined);

    const result = await runSandboxAdminCommand({
      workspaceKey: "ws_a7b3c9",
      command: "apt-get update",
      bridgeDataDir: "/bridge-data",
    }, {
      execSimple,
      execCommand,
      mkdir,
      appendFile,
      now: () => new Date("2026-05-28T12:00:00.000Z"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.attachedHere).toBe(true);
    expect(result.network).toBe("pi_default");
    expect(execCommand).toHaveBeenCalledWith("docker", dockerExecArgs({
      sandboxContainer: "pi-sandbox-ws_a7b3c9",
      user: "0",
      cwd: "/workspace",
      command: "apt-get update",
    }));
    expect(appendFile).toHaveBeenCalledWith(
      "/bridge-data/admin/sandbox-admin-history.jsonl",
      expect.stringContaining('"command":"apt-get update"'),
      "utf8",
    );
    expect(appendFile).toHaveBeenCalledWith(
      "/bridge-data/admin/sandbox-admin-history.jsonl",
      expect.stringContaining('"attachedHere":true'),
      "utf8",
    );
  });

  it("returns exitCode 1 when disconnect fails after a successful command", async () => {
    const execSimple = vi.fn(async (_cmd: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "inspect pi-bridge") return "";
      if (joined === "inspect pi-sandbox-ws_a7b3c9") return "";
      if (joined === "inspect -f {{.State.Running}} pi-sandbox-ws_a7b3c9") return "true\n";
      if (joined.includes(".NetworkSettings.Networks") && args.at(-1) === "pi-bridge") return "pi_default\n";
      if (joined.includes(".NetworkSettings.Networks") && args.at(-1) === "pi-sandbox-ws_a7b3c9") return "none\n";
      if (joined === "network connect pi_default pi-sandbox-ws_a7b3c9") return "";
      if (joined === "network disconnect pi_default pi-sandbox-ws_a7b3c9") throw new Error("disconnect failed");
      throw new Error(`unexpected docker call: ${joined}`);
    });

    const result = await runSandboxAdminCommand({
      workspaceKey: "ws_a7b3c9",
      command: "apt-get update",
      bridgeDataDir: "/bridge-data",
    }, {
      execSimple,
      execCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
      mkdir: vi.fn(async () => undefined),
      appendFile: vi.fn(async () => undefined),
    });

    expect(result.exitCode).toBe(1);
    expect(result.disconnectFailed).toBe(true);
  });

  it("migrates legacy shlog entries into jsonl and preserves malformed blocks as raw records", async () => {
    const appendFile = vi.fn(async () => undefined);
    const rm = vi.fn(async () => undefined);

    const result = await migrateLegacySandboxAdminHistory("/bridge-data", {
      access: vi.fn(async () => undefined),
      readFile: (async () => [
        "# 2026-05-28T12:00:00Z ws=ws_a7b3c9 container=pi-sandbox-ws_a7b3c9 network=pi_default cwd=/workspace user=0 exit=0",
        "docker network connect pi_default pi-sandbox-ws_a7b3c9",
        "docker exec -u 0 -w /workspace pi-sandbox-ws_a7b3c9 sh -lc 'apt-get update'",
        "docker network disconnect pi_default pi-sandbox-ws_a7b3c9",
        "",
        "# malformed block that should still be preserved",
        "docker exec -u 0 -w /workspace pi-sandbox-ws_a7b3c9 sh -lc 'echo hello'",
        "",
      ].join("\n")) as never,
      mkdir: vi.fn(async () => undefined),
      appendFile,
      rm,
    });

    expect(result.migratedCount).toBe(2);
    expect(appendFile).toHaveBeenCalledWith(
      "/bridge-data/admin/sandbox-admin-history.jsonl",
      expect.stringContaining('"migratedFrom":"sandbox-admin-history.shlog"'),
      "utf8",
    );
    expect(appendFile).toHaveBeenCalledWith(
      "/bridge-data/admin/sandbox-admin-history.jsonl",
      expect.stringContaining('"command":"apt-get update"'),
      "utf8",
    );
    expect(appendFile).toHaveBeenCalledWith(
      "/bridge-data/admin/sandbox-admin-history.jsonl",
      expect.stringContaining('"migrationError":"legacy header did not match the expected sandbox-admin-history.shlog format"'),
      "utf8",
    );
    expect(rm).toHaveBeenCalledWith("/bridge-data/admin/sandbox-admin-history.shlog", { force: true });
  });
});
