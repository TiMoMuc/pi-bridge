import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_CODE_SERVER_EXTENSIONS,
  DEFAULT_CODE_SERVER_IMAGE,
  DEFAULT_SANDBOX_CWD,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_WORKSPACE_ROOT,
  defaultProjectsHostDir,
  enabledTransportNames,
  hasNextcloudTransport,
  hasSignalTransport,
  loadConfig,
  resolveSandboxCwd,
} from "../src/config.js";

describe("loadConfig", () => {
  const original = { ...process.env };

  beforeEach(() => {
    process.env["SIGNAL_PHONE_NUMBER"] = "+15551234567";
    delete process.env["ANTHROPIC_API_KEY"];
    delete process.env["PI_PROVIDER"];
    delete process.env["PI_MODEL"];
    delete process.env["PI_THINKING_LEVEL"];
    delete process.env["BRIDGE_ACCESS_MODE"];
    delete process.env["ADMIN_PHONE"];
    delete process.env["SIGNAL_CLI_URL"];
    delete process.env["WORKSPACE_DIR"];
    delete process.env["BLUEPRINT_DIR"];
    delete process.env["SYSTEM_DIR"];
    delete process.env["BRIDGE_RUNTIME_UID"];
    delete process.env["BRIDGE_RUNTIME_GID"];
    delete process.env["BRIDGE_DOCKER_SOCKET_GID"];
    delete process.env["BRIDGE_DATA_HOST_DIR"];
    delete process.env["BRIDGE_DATA_DIR_HOST"];
    delete process.env["PROJECTS_HOST_DIR"];
    delete process.env["PROJECTS_DIR_HOST"];
    delete process.env["SANDBOX_CWD"];
    delete process.env["CODE_SERVER_IMAGE"];
    delete process.env["CODE_SERVER_BIND_HOST"];
    delete process.env["CODE_SERVER_PORT_START"];
    delete process.env["CODE_SERVER_PUBLIC_URL_TEMPLATE"];
    delete process.env["CODE_SERVER_EXTENSIONS"];
    delete process.env["CODE_SERVER_EXTENSIONS_MODE"];
    delete process.env["CALENDAR_ENABLED"];
    delete process.env["CALENDAR_HTTP_HOST"];
    delete process.env["CALENDAR_HTTP_PORT"];
    delete process.env["CALENDAR_PUBLIC_BASE_URL"];
    delete process.env["CALENDAR_REFRESH_INTERVAL"];
    delete process.env["SESSION_WATCH_ENABLED"];
    delete process.env["SESSION_WATCH_HOST"];
    delete process.env["SESSION_WATCH_PORT"];
    delete process.env["SESSION_WATCH_PUBLIC_BASE_URL"];
    delete process.env["ADMIN_UI_PORT"];
    delete process.env["ADMIN_UI_USER"];
    delete process.env["ADMIN_UI_PASSWORD"];
    delete process.env["DEFAULT_NEW_WORKSPACE_CODE_SERVER_ENABLED"];
    delete process.env["DEFAULT_NEW_WORKSPACE_CALENDAR_ENABLED"];
    delete process.env["DEFAULT_NEW_WORKSPACE_BOOT_ENABLED"];
    delete process.env["NEXTCLOUD_BASE_URL"];
    delete process.env["NEXTCLOUD_BOT_SECRET"];
    delete process.env["NEXTCLOUD_WEBHOOK_HOST"];
    delete process.env["NEXTCLOUD_WEBHOOK_PORT"];
    delete process.env["NEXTCLOUD_WEBHOOK_PATH"];
    delete process.env["NEXTCLOUD_API_USER"];
    delete process.env["NEXTCLOUD_API_PASSWORD"];
    delete process.env["NC_URL"];
    delete process.env["NC_BOT_SECRET"];
    delete process.env["NC_USER"];
    delete process.env["NC_APP_TOKEN"];
    delete process.env["NC_WEBHOOK_HOST"];
    delete process.env["NC_WEBHOOK_PORT"];
    delete process.env["NC_WEBHOOK_PATH"];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(original)) {
      process.env[key] = value;
    }
  });

  it("loads required vars and defaults signal transport from SIGNAL_PHONE_NUMBER", () => {
    const c = loadConfig();
    expect(c.signalPhoneNumber).toBe("+15551234567");
    expect(enabledTransportNames(c)).toEqual(["signal"]);
    expect(hasSignalTransport(c)).toBe(true);
    expect(hasNextcloudTransport(c)).toBe(false);
  });

  it("enables nextcloud when NEXTCLOUD_BASE_URL and NEXTCLOUD_BOT_SECRET are present", () => {
    process.env["NEXTCLOUD_BASE_URL"] = "https://cloud.example.com";
    process.env["NEXTCLOUD_BOT_SECRET"] = "super-secret";
    const c = loadConfig();
    expect(enabledTransportNames(c)).toEqual(["signal", "nextcloud"]);
    expect(c.nextcloud.baseUrl).toBe("https://cloud.example.com");
    expect(c.nextcloud.botSecret).toBe("super-secret");
  });

  it("throws when no transports are configured", () => {
    delete process.env["SIGNAL_PHONE_NUMBER"];
    expect(() => loadConfig()).toThrow("At least one transport must be configured");
  });

  it("applies defaults for optional vars", () => {
    const c = loadConfig();
    expect(c.piProvider).toBe("anthropic");
    expect(c.piModel).toBe("claude-sonnet-4-5");
    expect(c.piThinkingLevel).toBe("off");
    expect(c.bridgeAccessMode).toBe("open");
    expect(c.signalCliUrl).toBe("http://localhost:8080");
    expect(c.bridgeDataDir).toBe("/bridge-data");
    expect(c.projectsDir).toBe("/bridge-data/projects");
    expect(c.adminPhone).toBeUndefined();
    expect(c.runtimeIdentity).toBeUndefined();
    expect(c.sandboxImage).toBe(DEFAULT_SANDBOX_IMAGE);
    expect(c.sandboxNetwork).toBe("none");
    expect(c.sandboxCwd).toBe(DEFAULT_SANDBOX_CWD);
    expect(c.codeServer.image).toBe(DEFAULT_CODE_SERVER_IMAGE);
    expect(c.codeServer.bindHost).toBe("127.0.0.1");
    expect(c.codeServer.portStart).toBe(18440);
    expect(c.codeServer.publicUrlTemplate).toBeUndefined();
    expect(c.codeServer.extensionsMode).toBe("append");
    expect(c.codeServer.extensions).toEqual(DEFAULT_CODE_SERVER_EXTENSIONS);
    expect(c.calendar.enabled).toBe(false);
    expect(c.calendar.bindHost).toBe("0.0.0.0");
    expect(c.calendar.port).toBe(8789);
    expect(c.calendar.publicBaseUrl).toBeUndefined();
    expect(c.calendar.refreshInterval).toBe("PT15M");
    expect(c.sessionWatch).toEqual({
      enabled: false,
      bindHost: "127.0.0.1",
      port: 8791,
      publicBaseUrl: undefined,
    });
    expect(c.adminUi).toBeUndefined();
    expect(c.workspaceDefaults).toEqual({
      codeServerEnabled: false,
      calendarEnabled: false,
      bootEnabled: true,
    });
    expect(c.nextcloud.webhookHost).toBe("0.0.0.0");
    expect(c.nextcloud.webhookPort).toBe(8788);
    expect(c.nextcloud.webhookPath).toBe("/nextcloud-talk-webhook");
    expect(c.nextcloud.apiUser).toBe("");
    expect(c.nextcloud.apiPassword).toBe("");
  });

  it("reads PI_PROVIDER and PI_MODEL", () => {
    process.env["PI_PROVIDER"] = "openai";
    process.env["PI_MODEL"] = "gpt-4o";
    const c = loadConfig();
    expect(c.piProvider).toBe("openai");
    expect(c.piModel).toBe("gpt-4o");
  });

  it.each(["off", "minimal", "low", "medium", "high", "xhigh"])(
    "reads PI_THINKING_LEVEL=%s",
    (thinkingLevel) => {
      process.env["PI_THINKING_LEVEL"] = thinkingLevel;
      expect(loadConfig().piThinkingLevel).toBe(thinkingLevel);
    },
  );

  it("throws on invalid PI_THINKING_LEVEL", () => {
    process.env["PI_THINKING_LEVEL"] = "turbo";
    expect(() => loadConfig()).toThrow("PI_THINKING_LEVEL");
  });

  it("reads BRIDGE_ACCESS_MODE", () => {
    process.env["BRIDGE_ACCESS_MODE"] = "closed";
    const c = loadConfig();
    expect(c.bridgeAccessMode).toBe("closed");
  });

  it("throws on invalid BRIDGE_ACCESS_MODE", () => {
    process.env["BRIDGE_ACCESS_MODE"] = "invite-only";
    expect(() => loadConfig()).toThrow("BRIDGE_ACCESS_MODE");
  });

  it("reads SANDBOX_CWD as a relative path under the fixed workspace root", () => {
    process.env["SANDBOX_CWD"] = "./cowork";
    expect(loadConfig().sandboxCwd).toBe("cowork");
    expect(resolveSandboxCwd(loadConfig().sandboxCwd)).toBe(`${SANDBOX_WORKSPACE_ROOT}/cowork`);
  });

  it("throws on absolute SANDBOX_CWD values", () => {
    process.env["SANDBOX_CWD"] = "/workspace/cowork";
    expect(() => loadConfig()).toThrow("must be relative");
  });

  it("throws on escaping SANDBOX_CWD values", () => {
    process.env["SANDBOX_CWD"] = "../outside";
    expect(() => loadConfig()).toThrow("must stay within");
  });

  it("reads code-server config", () => {
    process.env["CODE_SERVER_IMAGE"] = "custom-code-server:latest";
    process.env["CODE_SERVER_BIND_HOST"] = "0.0.0.0";
    process.env["CODE_SERVER_PORT_START"] = "20000";
    process.env["CODE_SERVER_EXTENSIONS"] = "ms-vscode.live-server,ms-python.python";

    expect(loadConfig().codeServer).toEqual({
      image: "custom-code-server:latest",
      bindHost: "0.0.0.0",
      portStart: 20000,
      publicUrlTemplate: undefined,
      extensionsMode: "append",
      extensions: [...DEFAULT_CODE_SERVER_EXTENSIONS, "ms-python.python"],
    });
  });

  it("overrides the manifest when CODE_SERVER_EXTENSIONS_MODE=override", () => {
    process.env["CODE_SERVER_EXTENSIONS_MODE"] = "override";
    process.env["CODE_SERVER_EXTENSIONS"] = "ms-python.python,bierner.markdown-mermaid";
    const c = loadConfig();
    expect(c.codeServer.extensionsMode).toBe("override");
    expect(c.codeServer.extensions).toEqual(["ms-python.python", "bierner.markdown-mermaid"]);
  });

  it("reads BRIDGE_DATA_DIR and PROJECTS_DIR", () => {
    process.env["BRIDGE_DATA_DIR"] = "/bridge-data";
    process.env["PROJECTS_DIR"] = "/projects";
    const c = loadConfig();
    expect(c.bridgeDataDir).toBe("/bridge-data");
    expect(c.projectsDir).toBe("/projects");
  });

  it("reads BRIDGE_DATA_HOST_DIR and PROJECTS_HOST_DIR", () => {
    process.env["BRIDGE_DATA_HOST_DIR"] = "/srv/bridge-data";
    process.env["PROJECTS_HOST_DIR"] = "/srv/projects";
    const c = loadConfig();
    expect(c.bridgeDataHostDir).toBe("/srv/bridge-data");
    expect(c.projectsHostDir).toBe("/srv/projects");
  });

  it("reads the optional advanced runtime identity override", () => {
    process.env["BRIDGE_RUNTIME_UID"] = "1001";
    process.env["BRIDGE_RUNTIME_GID"] = "1001";
    process.env["BRIDGE_DOCKER_SOCKET_GID"] = "989";

    expect(loadConfig().runtimeIdentity).toEqual({
      uid: 1001,
      gid: 1001,
      dockerSocketGid: 989,
    });
  });

  it("requires BRIDGE_RUNTIME_UID and BRIDGE_RUNTIME_GID together", () => {
    process.env["BRIDGE_RUNTIME_UID"] = "1001";
    expect(() => loadConfig()).toThrow("BRIDGE_RUNTIME_UID and BRIDGE_RUNTIME_GID must be set together");
  });

  it("requires BRIDGE_DOCKER_SOCKET_GID when the runtime identity override is enabled", () => {
    process.env["BRIDGE_RUNTIME_UID"] = "1001";
    process.env["BRIDGE_RUNTIME_GID"] = "1001";
    expect(() => loadConfig()).toThrow("BRIDGE_DOCKER_SOCKET_GID is required");
  });

  it("rejects BRIDGE_DOCKER_SOCKET_GID on its own", () => {
    process.env["BRIDGE_DOCKER_SOCKET_GID"] = "989";
    expect(() => loadConfig()).toThrow("BRIDGE_DOCKER_SOCKET_GID requires BRIDGE_RUNTIME_UID and BRIDGE_RUNTIME_GID");
  });

  it("rejects invalid advanced runtime identity values", () => {
    process.env["BRIDGE_RUNTIME_UID"] = "user";
    expect(() => loadConfig()).toThrow("BRIDGE_RUNTIME_UID must be a non-negative integer");
  });

  it("derives the default projects host dir from the bridge data host dir", () => {
    expect(defaultProjectsHostDir("/srv/bridge-data")).toBe("/srv/bridge-data/projects");
  });

  it("throws when removed host-path env aliases are still present", () => {
    process.env["BRIDGE_DATA_DIR_HOST"] = "/legacy/bridge-data";
    process.env["PROJECTS_DIR_HOST"] = "/legacy/projects";
    expect(() => loadConfig()).toThrow("Removed environment variables detected");
    expect(() => loadConfig()).toThrow("use BRIDGE_DATA_HOST_DIR");
    expect(() => loadConfig()).toThrow("use PROJECTS_HOST_DIR");
  });

  it("reads calendar publisher config", () => {
    process.env["CALENDAR_ENABLED"] = "true";
    process.env["CALENDAR_HTTP_HOST"] = "127.0.0.1";
    process.env["CALENDAR_HTTP_PORT"] = "19001";
    process.env["CALENDAR_PUBLIC_BASE_URL"] = "https://calendar.example.com/base/";
    process.env["CALENDAR_REFRESH_INTERVAL"] = "PT30M";
    process.env["SESSION_WATCH_ENABLED"] = "true";
    process.env["SESSION_WATCH_HOST"] = "0.0.0.0";
    process.env["SESSION_WATCH_PORT"] = "19002";
    process.env["SESSION_WATCH_PUBLIC_BASE_URL"] = "https://watch.example.com/base/";
    process.env["ADMIN_UI_PORT"] = "19003";
    process.env["ADMIN_UI_USER"] = "operator";
    process.env["ADMIN_UI_PASSWORD"] = "secret";
    process.env["DEFAULT_NEW_WORKSPACE_CODE_SERVER_ENABLED"] = "true";
    process.env["DEFAULT_NEW_WORKSPACE_CALENDAR_ENABLED"] = "true";
    process.env["DEFAULT_NEW_WORKSPACE_BOOT_ENABLED"] = "false";

    const config = loadConfig();
    expect(config.calendar).toEqual({
      enabled: true,
      bindHost: "127.0.0.1",
      port: 19001,
      publicBaseUrl: "https://calendar.example.com/base",
      refreshInterval: "PT30M",
    });
    expect(config.sessionWatch).toEqual({
      enabled: true,
      bindHost: "0.0.0.0",
      port: 19002,
      publicBaseUrl: "https://watch.example.com/base",
    });
    expect(config.adminUi).toEqual({
      bindHost: "0.0.0.0",
      port: 19003,
      username: "operator",
      password: "secret",
    });
    expect(config.workspaceDefaults).toEqual({
      codeServerEnabled: true,
      calendarEnabled: true,
      bootEnabled: false,
    });
  });

  it("requires ADMIN_UI_USER and ADMIN_UI_PASSWORD together", () => {
    process.env["ADMIN_UI_USER"] = "operator";
    expect(() => loadConfig()).toThrow("ADMIN_UI_USER and ADMIN_UI_PASSWORD must be set together");
  });

  it("reads code-server public URL templates", () => {
    process.env["CODE_SERVER_PUBLIC_URL_TEMPLATE"] = "https://code-{workspaceKey}.example.com:{port}/";
    expect(loadConfig().codeServer.publicUrlTemplate).toBe("https://code-{workspaceKey}.example.com:{port}/");
  });

  it("rejects invalid CODE_SERVER_PUBLIC_URL_TEMPLATE placeholders", () => {
    process.env["CODE_SERVER_PUBLIC_URL_TEMPLATE"] = "https://code.example.com/{workspacePath}";
    expect(() => loadConfig()).toThrow("CODE_SERVER_PUBLIC_URL_TEMPLATE placeholder");
  });

  it("throws on invalid CODE_SERVER_EXTENSIONS_MODE", () => {
    process.env["CODE_SERVER_EXTENSIONS_MODE"] = "merge";
    expect(() => loadConfig()).toThrow("CODE_SERVER_EXTENSIONS_MODE");
  });

  it("does not require signal when nextcloud alone is configured", () => {
    delete process.env["SIGNAL_PHONE_NUMBER"];
    process.env["NEXTCLOUD_BASE_URL"] = "https://cloud.example.com";
    process.env["NEXTCLOUD_BOT_SECRET"] = "super-secret";
    const c = loadConfig();
    expect(enabledTransportNames(c)).toEqual(["nextcloud"]);
    expect(c.signalPhoneNumber).toBeUndefined();
    expect(c.nextcloud.baseUrl).toBe("https://cloud.example.com");
    expect(c.nextcloud.botSecret).toBe("super-secret");
  });

  it("requires NEXTCLOUD_API_USER and NEXTCLOUD_API_PASSWORD together", () => {
    process.env["NEXTCLOUD_API_USER"] = "bot";
    expect(() => loadConfig()).toThrow("NEXTCLOUD_API_USER and NEXTCLOUD_API_PASSWORD must be set together");
  });

  it("throws when removed Nextcloud env aliases are still present", () => {
    process.env["NC_URL"] = "https://legacy.example.com";
    process.env["NC_BOT_SECRET"] = "legacy-secret";
    expect(() => loadConfig()).toThrow("Removed environment variables detected");
    expect(() => loadConfig()).toThrow("use NEXTCLOUD_BASE_URL");
    expect(() => loadConfig()).toThrow("use NEXTCLOUD_BOT_SECRET");
  });

  it("throws when SYSTEM_DIR is still set", () => {
    process.env["SYSTEM_DIR"] = "/tmp/system";
    expect(() => loadConfig()).toThrow("SYSTEM_DIR");
    expect(() => loadConfig()).toThrow("removed from the operator env surface");
  });
});
