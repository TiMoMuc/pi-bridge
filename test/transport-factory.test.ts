import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createTransports } from "../src/transports/index.js";
import { NextcloudTransport } from "../src/transports/nextcloud.js";
import { SignalTransport } from "../src/transports/signal.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    signalCliUrl: "http://localhost:8080",
    signalPhoneNumber: "+15551234567",
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

describe("createTransports", () => {
  it("returns SignalTransport when only signal is configured", () => {
    const transports = createTransports(makeConfig());
    expect(transports).toHaveLength(1);
    expect(transports[0]).toBeInstanceOf(SignalTransport);
    expect(transports[0]?.name).toBe("signal");
  });

  it("returns both transports when signal and nextcloud are configured", () => {
    const transports = createTransports(makeConfig({
      nextcloud: {
        ...makeConfig().nextcloud,
        baseUrl: "https://cloud.example.com",
        botSecret: "super-secret",
      },
    }));

    expect(transports).toHaveLength(2);
    expect(transports[0]).toBeInstanceOf(SignalTransport);
    expect(transports[1]).toBeInstanceOf(NextcloudTransport);
  });

  it("returns NextcloudTransport when only nextcloud is configured", () => {
    const transports = createTransports(makeConfig({
      signalPhoneNumber: undefined,
      nextcloud: {
        ...makeConfig().nextcloud,
        baseUrl: "https://cloud.example.com",
        botSecret: "super-secret",
      },
    }));
    expect(transports).toHaveLength(1);
    expect(transports[0]).toBeInstanceOf(NextcloudTransport);
    expect(transports[0]?.name).toBe("nextcloud");
  });
});
