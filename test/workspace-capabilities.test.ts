import { describe, expect, it } from "vitest";
import {
  WorkspaceCapabilityManager,
  defaultWorkspaceCapabilitiesRecord,
  resolveSandboxNetworkName,
  workspaceCapabilityNetworkName,
} from "../src/workspace-capabilities.js";

describe("workspace capabilities", () => {
  it("defaults new workspaces to pdfApi disabled", () => {
    expect(defaultWorkspaceCapabilitiesRecord()).toEqual({
      pdfApi: { enabled: false },
    });
  });

  it("uses the workspace-specific network only when capabilities are enabled", () => {
    expect(resolveSandboxNetworkName("none", "ws_a7b3c9", { pdfApi: { enabled: false } })).toBe("none");
    expect(resolveSandboxNetworkName("none", "ws_a7b3c9", { pdfApi: { enabled: true } })).toBe(
      workspaceCapabilityNetworkName("ws_a7b3c9"),
    );
  });

  it("creates a workspace network and attaches pdf-api when enabled", async () => {
    const networks = new Set<string>();
    const containerNetworks = new Map<string, Set<string>>();
    containerNetworks.set("pi-bridge-pdf-api", new Set(["pi-bridge-capabilities-internal"]));

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
    });

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
  });

  it("reports pdf-api as missing when the capability container is not running", async () => {
    const networks = new Set<string>();
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
        if (args[0] === "inspect" && args[2] === "{{.State.Running}}") {
          throw new Error("missing container");
        }
        throw new Error(`Unexpected docker args: ${args.join(" ")}`);
      },
    });

    const result = await manager.applyWorkspaceCapabilities("ws_a7b3c9", {
      pdfApi: { enabled: true },
    });

    expect(result.attached).toEqual([]);
    expect(result.missing).toEqual(["pdfApi"]);
    expect(networks.has("ws_a7b3c9-net")).toBe(true);
  });
});
