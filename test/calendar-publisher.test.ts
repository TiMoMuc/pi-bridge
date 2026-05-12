import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CalendarPublisher } from "../src/calendar-publisher.js";
import { UserProvisioner } from "../src/provisioner.js";

describe("CalendarPublisher", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let blueprintDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-publisher-test-"));
    workspaceDir = path.join(tmpDir, "workspace");
    blueprintDir = path.join(tmpDir, "blueprint");

    await fs.mkdir(path.join(blueprintDir, "events"), { recursive: true });
    await fs.writeFile(path.join(blueprintDir, "AGENTS.md"), "# Agent\n");
    await fs.writeFile(path.join(blueprintDir, "orient.py"), "print('boot')\n");
    await fs.writeFile(path.join(blueprintDir, ".gitignore"), "sessions/\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("serves a token-protected ICS feed", async () => {
    const provisioner = new UserProvisioner(workspaceDir, workspaceDir, blueprintDir, {
      calendar: {
        enabled: true,
        bindHost: "127.0.0.1",
        port: 0,
        publicBaseUrl: "https://calendar.example.com",
      },
      modelDefaults: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "off",
      },
    });
    await provisioner.initialize();
    const { workspaceKey } = await provisioner.ensureProvisioned("signal", "+15551234567");
    const registryPath = path.join(workspaceDir, "admin", "workspace.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, { calendar?: { enabled?: boolean } }>;
    registry[workspaceKey].calendar!.enabled = true;
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    await provisioner.reload();
    const calendar = await provisioner.ensureCalendarAccess(workspaceKey);
    await fs.writeFile(
      path.join(workspaceDir, workspaceKey, ".events", "future.json"),
      JSON.stringify({
        type: "one-shot",
        text: "Review the roadmap",
        at: "2099-01-01T10:00:00Z",
      }),
    );

    const publisher = new CalendarPublisher({
      enabled: true,
      bindHost: "127.0.0.1",
      port: 0,
      publicBaseUrl: undefined,
      refreshInterval: "PT15M",
    }, provisioner);
    await publisher.start();

    const address = publisher.address();
    expect(address).toBeTruthy();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/calendar/${workspaceKey}/${calendar?.token}.ics`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(await response.text()).toContain("Review the roadmap");

    const forbidden = await fetch(`http://127.0.0.1:${port}/calendar/${workspaceKey}/wrong-token.ics`);
    expect(forbidden.status).toBe(404);

    await publisher.stop();
  });

  it("uses applied provisioner state for calendar enablement", async () => {
    const provisioner = new UserProvisioner(workspaceDir, workspaceDir, blueprintDir, {
      calendar: {
        enabled: true,
        bindHost: "127.0.0.1",
        port: 0,
        publicBaseUrl: undefined,
      },
      modelDefaults: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "off",
      },
    });
    await provisioner.initialize();
    const { workspaceKey } = await provisioner.ensureProvisioned("signal", "+15551234567");
    const registryPath = path.join(workspaceDir, "admin", "workspace.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Record<string, { calendar?: { enabled?: boolean } }>;
    registry[workspaceKey].calendar!.enabled = true;
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    await provisioner.reload();
    const calendar = await provisioner.ensureCalendarAccess(workspaceKey);

    const publisher = new CalendarPublisher({
      enabled: true,
      bindHost: "127.0.0.1",
      port: 0,
      publicBaseUrl: undefined,
      refreshInterval: "PT15M",
    }, provisioner);
    await publisher.start();

    const address = publisher.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const ok = await fetch(`http://127.0.0.1:${port}/calendar/${workspaceKey}/${calendar?.token}.ics`);
    expect(ok.status).toBe(200);

    registry[workspaceKey].calendar!.enabled = false;
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    await provisioner.reload();

    const disabled = await fetch(`http://127.0.0.1:${port}/calendar/${workspaceKey}/${calendar?.token}.ics`);
    expect(disabled.status).toBe(404);

    await publisher.stop();
  });
});
