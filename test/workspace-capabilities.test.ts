import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  WorkspaceCapabilityManager,
  defaultWorkspaceCapabilitiesRecord,
  resolveSandboxNetworkName,
  workspaceCapabilityNetworkName,
} from "../src/workspace-capabilities.js";

describe("workspace capabilities", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-capabilities-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("defaults new workspaces to known capabilities disabled", () => {
    expect(defaultWorkspaceCapabilitiesRecord()).toEqual({
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    });
  });

  it("uses the workspace-specific network only when capabilities are enabled", () => {
    expect(resolveSandboxNetworkName("none", "ws_a7b3c9", {
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    })).toBe("none");

    expect(resolveSandboxNetworkName("none", "ws_a7b3c9", {
      pdfApi: { enabled: true },
      spreadsheetRecalc: { enabled: false },
    })).toBe(workspaceCapabilityNetworkName("ws_a7b3c9"));

    expect(resolveSandboxNetworkName("none", "ws_a7b3c9", {
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: true },
    })).toBe(workspaceCapabilityNetworkName("ws_a7b3c9"));
  });

  it("creates a workspace network, copies bundled guidance, and attaches pdf-api when enabled", async () => {
    const bridgeDir = path.join(tmpDir, "workspace", ".bridge");
    const networks = new Set<string>();
    const containerNetworks = new Map<string, Set<string>>();
    containerNetworks.set("pi-bridge-pdf-api", new Set(["pi-bridge-capabilities-internal"]));
    const skillText = [
      "---",
      "name: pdf-api",
      "description: Use when a workspace can call the bundled PDF capability.",
      "version: 0.1.0",
      "---",
      "",
      "Use the PDF API when needed.",
      "",
    ].join("\n");

    const manager = new WorkspaceCapabilityManager({
      project: "pi-bridge",
      execSimple: async (_cmd, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          if (networks.has(args[2])) return "[]";
          throw new Error("missing network");
        }
        if (args[0] === "network" && args[1] === "create") {
          networks.add(args[args.length - 1]);
          return `${args[args.length - 1]}\n`;
        }
        if (args[0] === "cp") {
          expect(args[1]).toBe("pi-bridge-pdf-api:/capability/SKILL.md");
          await fs.writeFile(args[2], skillText, "utf8");
          return "";
        }
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          return args[3] === "pi-bridge-pdf-api" ? "true\n" : "false\n";
        }
        if (args[0] === "inspect" && args[2].includes("NetworkSettings.Networks")) {
          const attached = [...(containerNetworks.get(args[3]) ?? new Set())];
          return `${attached.join("\n")}\n`;
        }
        if (args[0] === "network" && args[1] === "connect") {
          const networkName = args[4];
          const containerName = args[5];
          const attached = containerNetworks.get(containerName) ?? new Set<string>();
          attached.add(networkName);
          containerNetworks.set(containerName, attached);
          return "";
        }
        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      },
    });

    const result = await manager.applyWorkspaceCapabilities("ws_a7b3c9", {
      pdfApi: { enabled: true },
      spreadsheetRecalc: { enabled: false },
    }, bridgeDir);

    expect(result).toEqual({
      attached: ["pdfApi"],
      detached: [],
      missing: [],
      networkCreated: true,
      networkRemoved: false,
    });
    expect(containerNetworks.get("pi-bridge-pdf-api")).toEqual(
      new Set(["pi-bridge-capabilities-internal", "ws_a7b3c9-net"]),
    );
    await expect(
      fs.readFile(path.join(bridgeDir, "capabilities", "pdfApi", "SKILL.md"), "utf8"),
    ).resolves.toBe(skillText);
  });

  it("reports pdf-api as missing when the bundled skill cannot be copied", async () => {
    const bridgeDir = path.join(tmpDir, "workspace", ".bridge");
    const networks = new Set<string>();
    const containerNetworks = new Map<string, Set<string>>();
    containerNetworks.set("pi-bridge-pdf-api", new Set(["pi-bridge-capabilities-internal", "ws_a7b3c9-net"]));

    const manager = new WorkspaceCapabilityManager({
      project: "pi-bridge",
      execSimple: async (_cmd, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          if (networks.has(args[2])) return "[]";
          throw new Error("missing network");
        }
        if (args[0] === "network" && args[1] === "create") {
          networks.add(args[args.length - 1]);
          return `${args[args.length - 1]}\n`;
        }
        if (args[0] === "cp") {
          throw new Error("missing bundled skill");
        }
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          return args[3] === "pi-bridge-pdf-api" ? "true\n" : "false\n";
        }
        if (args[0] === "inspect" && args[2].includes("NetworkSettings.Networks")) {
          const attached = [...(containerNetworks.get(args[3]) ?? new Set())];
          return `${attached.join("\n")}\n`;
        }
        if (args[0] === "network" && args[1] === "disconnect") {
          const networkName = args[2];
          const containerName = args[3];
          const attached = containerNetworks.get(containerName) ?? new Set<string>();
          attached.delete(networkName);
          containerNetworks.set(containerName, attached);
          return "";
        }
        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      },
    });

    await fs.mkdir(path.join(bridgeDir, "capabilities", "pdfApi"), { recursive: true });
    await fs.writeFile(path.join(bridgeDir, "capabilities", "pdfApi", "SKILL.md"), "stale", "utf8");

    const result = await manager.applyWorkspaceCapabilities("ws_a7b3c9", {
      pdfApi: { enabled: true },
      spreadsheetRecalc: { enabled: false },
    }, bridgeDir);

    expect(result.attached).toEqual([]);
    expect(result.missing).toEqual(["pdfApi"]);
    expect(networks.has("ws_a7b3c9-net")).toBe(true);
    expect(containerNetworks.get("pi-bridge-pdf-api")).toEqual(new Set(["pi-bridge-capabilities-internal"]));
    await expect(fs.access(path.join(bridgeDir, "capabilities", "pdfApi", "SKILL.md"))).rejects.toThrow();
  });

  it("blocks exposure when the bundled skill frontmatter is invalid", async () => {
    const bridgeDir = path.join(tmpDir, "workspace", ".bridge");
    const networks = new Set<string>();
    const containerNetworks = new Map<string, Set<string>>();
    containerNetworks.set("pi-bridge-pdf-api", new Set(["pi-bridge-capabilities-internal"]));
    const invalidSkill = [
      "---",
      "name: pdf-api",
      "description: Missing the required version field.",
      "metadata: extra-field",
      "---",
      "",
      "Invalid by contract.",
      "",
    ].join("\n");

    const manager = new WorkspaceCapabilityManager({
      project: "pi-bridge",
      execSimple: async (_cmd, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          if (networks.has(args[2])) return "[]";
          throw new Error("missing network");
        }
        if (args[0] === "network" && args[1] === "create") {
          networks.add(args[args.length - 1]);
          return `${args[args.length - 1]}\n`;
        }
        if (args[0] === "cp") {
          await fs.writeFile(args[2], invalidSkill, "utf8");
          return "";
        }
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          return args[3] === "pi-bridge-pdf-api" ? "true\n" : "false\n";
        }
        if (args[0] === "inspect" && args[2].includes("NetworkSettings.Networks")) {
          const attached = [...(containerNetworks.get(args[3]) ?? new Set())];
          return `${attached.join("\n")}\n`;
        }
        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      },
    });

    const result = await manager.applyWorkspaceCapabilities("ws_a7b3c9", {
      pdfApi: { enabled: true },
      spreadsheetRecalc: { enabled: false },
    }, bridgeDir);

    expect(result.attached).toEqual([]);
    expect(result.missing).toEqual(["pdfApi"]);
    expect(containerNetworks.get("pi-bridge-pdf-api")).toEqual(new Set(["pi-bridge-capabilities-internal"]));
    await expect(fs.access(path.join(bridgeDir, "capabilities", "pdfApi", "SKILL.md"))).rejects.toThrow();
  });

  it("removes the materialized skill and detaches the capability when disabled", async () => {
    const bridgeDir = path.join(tmpDir, "workspace", ".bridge");
    const networkName = "ws_a7b3c9-net";
    const networks = new Set<string>([networkName]);
    const containerNetworks = new Map<string, Set<string>>();
    containerNetworks.set("pi-bridge-pdf-api", new Set(["pi-bridge-capabilities-internal", networkName]));

    await fs.mkdir(path.join(bridgeDir, "capabilities", "pdfApi"), { recursive: true });
    await fs.writeFile(path.join(bridgeDir, "capabilities", "pdfApi", "SKILL.md"), "stale", "utf8");

    const manager = new WorkspaceCapabilityManager({
      project: "pi-bridge",
      execSimple: async (_cmd, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          if (networks.has(args[2])) return "[]";
          throw new Error("missing network");
        }
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          return args[3] === "pi-bridge-pdf-api" ? "true\n" : "false\n";
        }
        if (args[0] === "inspect" && args[2].includes("NetworkSettings.Networks")) {
          const attached = [...(containerNetworks.get(args[3]) ?? new Set())];
          return `${attached.join("\n")}\n`;
        }
        if (args[0] === "network" && args[1] === "disconnect") {
          const network = args[2];
          const containerName = args[3];
          const attached = containerNetworks.get(containerName) ?? new Set<string>();
          attached.delete(network);
          containerNetworks.set(containerName, attached);
          return "";
        }
        if (args[0] === "network" && args[1] === "rm") {
          networks.delete(args[2]);
          return "";
        }
        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      },
    });

    const result = await manager.applyWorkspaceCapabilities("ws_a7b3c9", {
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    }, bridgeDir);

    expect(result).toEqual({
      attached: [],
      detached: ["pdfApi"],
      missing: [],
      networkCreated: false,
      networkRemoved: true,
    });
    await expect(fs.access(path.join(bridgeDir, "capabilities", "pdfApi", "SKILL.md"))).rejects.toThrow();
    expect(containerNetworks.get("pi-bridge-pdf-api")).toEqual(new Set(["pi-bridge-capabilities-internal"]));
  });

  it("attaches the spreadsheet recalc backend under the narrow alias", async () => {
    const bridgeDir = path.join(tmpDir, "workspace", ".bridge");
    const networks = new Set<string>();
    const containerNetworks = new Map<string, Set<string>>();
    containerNetworks.set("pi-bridge-spreadsheet-recalc", new Set(["pi-bridge-capabilities-internal"]));
    const skillText = [
      "---",
      "name: spreadsheet-recalc",
      "description: Use when recalculating workbook formulas through the capability container.",
      "version: 0.1.0",
      "---",
      "",
      "Use the recalc API when needed.",
      "",
    ].join("\n");

    const manager = new WorkspaceCapabilityManager({
      project: "pi-bridge",
      execSimple: async (_cmd, args) => {
        if (args[0] === "network" && args[1] === "inspect") {
          if (networks.has(args[2])) return "[]";
          throw new Error("missing network");
        }
        if (args[0] === "network" && args[1] === "create") {
          networks.add(args[args.length - 1]);
          return `${args[args.length - 1]}\n`;
        }
        if (args[0] === "cp") {
          expect(args[1]).toBe("pi-bridge-spreadsheet-recalc:/capability/SKILL.md");
          await fs.writeFile(args[2], skillText, "utf8");
          return "";
        }
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          return args[3] === "pi-bridge-spreadsheet-recalc" ? "true\n" : "false\n";
        }
        if (args[0] === "inspect" && args[2].includes("NetworkSettings.Networks")) {
          const attached = [...(containerNetworks.get(args[3]) ?? new Set())];
          return `${attached.join("\n")}\n`;
        }
        if (args[0] === "network" && args[1] === "connect") {
          expect(args[3]).toBe("spreadsheet-recalc");
          const networkName = args[4];
          const containerName = args[5];
          const attached = containerNetworks.get(containerName) ?? new Set<string>();
          attached.add(networkName);
          containerNetworks.set(containerName, attached);
          return "";
        }
        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      },
    });

    const result = await manager.applyWorkspaceCapabilities("ws_a7b3c9", {
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: true },
    }, bridgeDir);

    expect(result).toEqual({
      attached: ["spreadsheetRecalc"],
      detached: [],
      missing: [],
      networkCreated: true,
      networkRemoved: false,
    });
    expect(containerNetworks.get("pi-bridge-spreadsheet-recalc")).toEqual(
      new Set(["pi-bridge-capabilities-internal", "ws_a7b3c9-net"]),
    );
    await expect(
      fs.readFile(path.join(bridgeDir, "capabilities", "spreadsheetRecalc", "SKILL.md"), "utf8"),
    ).resolves.toBe(skillText);
  });
});
