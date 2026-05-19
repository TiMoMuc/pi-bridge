import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { UserProvisioner } from "../src/provisioner.js";

describe("UserProvisioner", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let blueprintDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "provisioner-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    blueprintDir = path.join(tmpDir, "blueprint");

    await fs.mkdir(path.join(blueprintDir, "events"), { recursive: true });
    await fs.mkdir(path.join(blueprintDir, "skills"), { recursive: true });
    await fs.writeFile(path.join(blueprintDir, "AGENTS.md"), "# Agent\n");
    await fs.writeFile(path.join(blueprintDir, "orient.py"), "print('boot')\n");
    await fs.writeFile(path.join(blueprintDir, ".gitignore"), "sessions/\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createProvisioner(overrides: {
    workspaceDefaults?: {
      codeServerEnabled: boolean;
      calendarEnabled: boolean;
      bootEnabled: boolean;
    };
  } = {}): UserProvisioner {
    return new UserProvisioner(workspaceDir, workspaceDir, blueprintDir, {
      codeServer: {
        bindHost: "127.0.0.1",
        portStart: 18440,
      },
      calendar: {
        enabled: true,
        bindHost: "0.0.0.0",
        port: 8789,
        publicBaseUrl: "https://calendar.example.com",
      },
      workspaceDefaults: overrides.workspaceDefaults,
      modelDefaults: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "off",
      },
    });
  }

  async function editWorkspaceRecord(
    workspaceKey: string,
    fn: (record: Record<string, unknown>) => void,
  ): Promise<void> {
    const registryPath = path.join(workspaceDir, "admin", "workspace.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, Record<string, unknown>>;
    fn(registry[workspaceKey]);
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
  }

  it("provisions a new signal workspace with an opaque ws_ key", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const result = await prov.ensureProvisioned("signal", "+15551234567", { defaultCodeServerEnabled: true });
    expect(result.isNew).toBe(true);
    expect(result.workspaceKey).toMatch(/^ws_[0-9a-f]{6}$/);
    expect(result.record.primaryTransport).toBe("signal");
    expect(result.record.transports.signal?.sender).toBe("+15551234567");
    expect(result.record.codeServer?.enabled).toBe(true);
    expect(result.record.codeServer?.password).toBeTruthy();
    expect(result.record.codeServer?.port).toBe(18440);
    expect(result.record.calendar?.enabled).toBe(false);
    expect(result.record.boot?.enabled).toBe(true);
    expect(result.record.capabilities).toEqual({
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    });
    expect(result.record.experimental).toBeUndefined();

    const userDir = path.join(workspaceDir, result.workspaceKey);
    expect((await fs.stat(userDir)).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(userDir, "cowork"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(userDir, ".bridge", "sessions"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(userDir, ".bridge", "git", "HEAD"))).isFile()).toBe(true);
    expect(await fs.readFile(path.join(userDir, ".git"), "utf8")).toBe("gitdir: .bridge/git\n");
    await expect(fs.access(path.join(userDir, ".bridge", "code-server", "access.md"))).rejects.toThrow();
  });

  it("applies provisioning defaults for new workspaces", async () => {
    const prov = createProvisioner({
      workspaceDefaults: {
        codeServerEnabled: true,
        calendarEnabled: true,
        bootEnabled: false,
      },
    });
    await prov.initialize();

    const result = await prov.ensureProvisioned("signal", "+1999");
    expect(result.record.codeServer?.enabled).toBe(true);
    expect(result.record.calendar?.enabled).toBe(true);
    expect(result.record.codeServer?.password).toBeTruthy();
    expect(result.record.calendar?.token).toBeTruthy();
    expect(result.record.boot).toEqual({ enabled: false });
    expect(result.record.capabilities).toEqual({
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    });
    expect(result.record.experimental).toBeUndefined();
    expect(result.record.piThinkingLevel).toBe("off");
  });

  it("writes env-backed boot defaults into pending workspace records", async () => {
    const prov = createProvisioner({
      workspaceDefaults: {
        codeServerEnabled: false,
        calendarEnabled: false,
        bootEnabled: false,
      },
    });
    await prov.initialize();

    const result = await prov.ensurePendingRequest("signal", "+1777");
    expect(result.record.status).toBe("pending");
    expect(result.record.boot).toEqual({ enabled: false });
    expect(result.record.capabilities).toEqual({
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    });
  });

  it("builds a reverse index lookup for signal and nextcloud bindings", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const signal = await prov.ensureProvisioned("signal", "+111");
    const signalGroup = await prov.ensureProvisioned("signal", "group-abc", {
      binding: { groupId: "group-abc", userWhitelist: ["+111"] },
    });
    const nextcloud = await prov.ensureProvisioned("nextcloud", "room-abc");

    expect(prov.lookup("signal", "+111")).toBe(signal.workspaceKey);
    expect(prov.lookup("signal", "group-abc")).toBe(signalGroup.workspaceKey);
    expect(prov.lookup("nextcloud", "room-abc")).toBe(nextcloud.workspaceKey);
    expect(prov.lookup("signal", "+999")).toBeUndefined();
  });

  it("returns the existing workspace when a binding is already provisioned", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const first = await prov.ensureProvisioned("signal", "+111");
    const second = await prov.ensureProvisioned("signal", "+111");

    expect(second.isNew).toBe(false);
    expect(second.workspaceKey).toBe(first.workspaceKey);
  });

  it("allocates unique code-server ports across workspaces", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const a = await prov.ensureProvisioned("signal", "+111", { defaultCodeServerEnabled: true });
    const b = await prov.ensureProvisioned("signal", "+222", { defaultCodeServerEnabled: true });

    expect(a.record.codeServer?.port).toBe(18440);
    expect(b.record.codeServer?.port).toBe(18441);
  });

  it("provisions a signal group binding with optional participant whitelist", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const result = await prov.ensureProvisioned("signal", "group-abc", {
      binding: { groupId: "group-abc", userWhitelist: ["+15550001111", "+15550002222"] },
    });

    expect(result.record.transports.signal?.groupId).toBe("group-abc");
    expect(result.record.transports.signal?.sender).toBeUndefined();
    expect(result.record.transports.signal?.userWhitelist).toEqual(["+15550001111", "+15550002222"]);
  });

  it("reprovision wipes workspace files but preserves registry metadata", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const { workspaceKey } = await prov.ensureProvisioned("nextcloud", "room-abc", { defaultCodeServerEnabled: true });
    const extraFile = path.join(workspaceDir, workspaceKey, "extra.txt");
    await fs.writeFile(extraFile, "wipe me");

    await prov.reprovision(workspaceKey);

    await expect(fs.access(extraFile)).rejects.toThrow();
    const record = prov.getWorkspace(workspaceKey);
    expect(record?.transports.nextcloud?.roomToken).toBe("room-abc");
    expect(record?.codeServer?.password).toBeTruthy();
  });

  it("can toggle code-server enablement after provisioning", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const { workspaceKey } = await prov.ensureProvisioned("signal", "+111");
    expect(prov.getWorkspace(workspaceKey)?.codeServer?.enabled).toBe(false);

    await editWorkspaceRecord(workspaceKey, (record) => {
      const codeServer = record["codeServer"] as { enabled?: boolean };
      codeServer.enabled = true;
    });
    await prov.reload();
    await prov.ensureCodeServerAccess(workspaceKey);
    expect(prov.getWorkspace(workspaceKey)?.codeServer?.enabled).toBe(true);

    await editWorkspaceRecord(workspaceKey, (record) => {
      const codeServer = record["codeServer"] as { enabled?: boolean };
      codeServer.enabled = false;
    });
    await prov.reload();
    expect(prov.getWorkspace(workspaceKey)?.codeServer?.enabled).toBe(false);
  });

  it("can enable calendar access without mirroring a subscription doc into the workspace", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const { workspaceKey } = await prov.ensureProvisioned("signal", "+111");
    expect(prov.getWorkspace(workspaceKey)?.calendar?.enabled).toBe(false);

    await editWorkspaceRecord(workspaceKey, (record) => {
      const calendar = record["calendar"] as { enabled?: boolean };
      calendar.enabled = true;
    });
    await prov.reload();
    const calendar = await prov.ensureCalendarAccess(workspaceKey);
    expect(calendar?.enabled).toBe(true);
    expect(calendar?.token).toBeTruthy();

    await expect(
      fs.access(path.join(workspaceDir, workspaceKey, ".bridge", "calendar", "calendar-subscription.md")),
    ).rejects.toThrow();
  });

  it("reads updated workspace metadata live from disk", async () => {
    const prov = createProvisioner();
    await prov.initialize();

    const { workspaceKey } = await prov.ensureProvisioned("signal", "+111");
    await editWorkspaceRecord(workspaceKey, (record) => {
      const calendar = record["calendar"] as { enabled?: boolean };
      calendar.enabled = true;
    });
    await prov.reload();
    const calendar = await prov.ensureCalendarAccess(workspaceKey);

    const registryPath = path.join(workspaceDir, "admin", "workspace.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, { label?: string; calendar?: { token?: string } }>;
    registry[workspaceKey].label = "Renamed";
    registry[workspaceKey].calendar!.token = `${calendar?.token}-updated`;
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));

    const live = await prov.getWorkspaceLive(workspaceKey);
    expect(live?.label).toBe("Renamed");
    expect(live?.calendar?.token).toBe(`${calendar?.token}-updated`);
  });

  it("writes explicit feature blocks into older workspace records during shape reconciliation", async () => {
    const adminDir = path.join(workspaceDir, "admin");
    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(path.join(adminDir, "workspace.json"), JSON.stringify({
      ws_a7b3c9: {
        createdAt: "2026-04-08T00:00:00.000Z",
        lastSeen: "2026-04-08T00:00:00.000Z",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
      },
    }, null, 2));

    const prov = createProvisioner();
    await prov.initialize();
    const updated = await prov.reconcileDesiredStateShape();
    expect(updated).toEqual(["ws_a7b3c9"]);

    const raw = JSON.parse(await fs.readFile(path.join(adminDir, "workspace.json"), "utf8")) as Record<string, {
      provisionedAt?: string;
      codeServer?: { enabled?: boolean };
      calendar?: { enabled?: boolean };
      boot?: { enabled?: boolean };
      capabilities?: {
        pdfApi?: { enabled?: boolean };
        spreadsheetRecalc?: { enabled?: boolean };
      };
      experimental?: Record<string, unknown>;
    }>;
    expect(raw.ws_a7b3c9?.provisionedAt).toBe("2026-04-08T00:00:00.000Z");
    expect(raw.ws_a7b3c9?.codeServer?.enabled).toBe(false);
    expect(raw.ws_a7b3c9?.calendar?.enabled).toBe(false);
    expect(raw.ws_a7b3c9?.boot).toEqual({ enabled: true });
    expect(raw.ws_a7b3c9?.capabilities).toEqual({
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    });
    expect(raw.ws_a7b3c9?.experimental).toBeUndefined();
  });

  it("does not synthesize provisionedAt when a pending workspace is manually approved", async () => {
    const adminDir = path.join(workspaceDir, "admin");
    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(path.join(adminDir, "workspace.json"), JSON.stringify({
      ws_a7b3c9: {
        createdAt: "2026-04-08T00:00:00.000Z",
        lastSeen: "2026-04-08T00:00:00.000Z",
        status: "active",
        workspacePath: "rooms/acme",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
        codeServer: { enabled: false },
        calendar: { enabled: false },
        boot: { enabled: true },
      },
    }, null, 2));

    const prov = createProvisioner();
    await prov.initialize();
    const updated = await prov.reconcileDesiredStateShape();
    expect(updated).toEqual(["ws_a7b3c9"]);

    const raw = JSON.parse(await fs.readFile(path.join(adminDir, "workspace.json"), "utf8")) as Record<string, {
      provisionedAt?: string;
      capabilities?: {
        pdfApi?: { enabled?: boolean };
        spreadsheetRecalc?: { enabled?: boolean };
      };
    }>;
    expect(raw.ws_a7b3c9?.provisionedAt).toBeUndefined();
    expect(raw.ws_a7b3c9?.capabilities).toEqual({
      pdfApi: { enabled: false },
      spreadsheetRecalc: { enabled: false },
    });

    await prov.reload();
    expect(prov.getWorkspace("ws_a7b3c9")?.provisionedAt).toBeUndefined();
  });

  it("preserves legacy experimental blocks when rewriting existing workspace metadata", async () => {
    const adminDir = path.join(workspaceDir, "admin");
    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(path.join(adminDir, "workspace.json"), JSON.stringify({
      ws_a7b3c9: {
        createdAt: "2026-04-08T00:00:00.000Z",
        lastSeen: "2026-04-08T00:00:00.000Z",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
        experimental: { noAutoSkills: true },
      },
    }, null, 2));

    const prov = createProvisioner();
    await prov.initialize();
    await prov.updateLastSeen("ws_a7b3c9");

    const raw = JSON.parse(await fs.readFile(path.join(adminDir, "workspace.json"), "utf8")) as Record<string, {
      experimental?: Record<string, unknown>;
    }>;
    expect(raw.ws_a7b3c9?.experimental).toEqual({ noAutoSkills: true });
  });

  it("rejects duplicate transport bindings while building the reverse index", async () => {
    const adminDir = path.join(workspaceDir, "admin");
    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(path.join(adminDir, "workspace.json"), JSON.stringify({
      ws_a7b3c9: {
        createdAt: "2026-04-08T00:00:00.000Z",
        lastSeen: "2026-04-08T00:00:00.000Z",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
      },
      ws_f2d8e1: {
        createdAt: "2026-04-08T00:00:00.000Z",
        lastSeen: "2026-04-08T00:00:00.000Z",
        primaryTransport: "signal",
        transports: { signal: { sender: "+15551234567" } },
      },
    }, null, 2));

    const prov = createProvisioner();
    await expect(prov.initialize()).rejects.toThrow("Duplicate workspace transport binding");
  });
});
