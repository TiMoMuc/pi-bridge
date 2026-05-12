import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { renderCalendarFeed } from "../src/calendar-ics.js";
import type { WorkspaceRecord } from "../src/provisioner.js";

describe("renderCalendarFeed", () => {
  let tmpDir: string;
  let eventsDir: string;
  let workspaceRecord: WorkspaceRecord;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "calendar-ics-test-"));
    eventsDir = path.join(tmpDir, "events");
    await fs.mkdir(eventsDir, { recursive: true });

    workspaceRecord = {
      createdAt: "2026-04-14T00:00:00.000Z",
      lastSeen: "2026-04-14T00:00:00.000Z",
      status: "active",
      workspacePath: "users/ws_a7b3c9",
      label: "Tillmann",
      primaryTransport: "signal",
      transports: { signal: { sender: "+15551234567", userWhitelist: [] } },
      calendar: {
        enabled: true,
        token: "secret-token",
        name: "Workspace Events",
      },
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("renders future one-shot and supported periodic events as ICS", async () => {
    await fs.writeFile(
      path.join(eventsDir, "future.json"),
      JSON.stringify({
        type: "one-shot",
        text: "Review the roadmap",
        at: "2026-04-15T09:30:00+02:00",
      }),
    );
    await fs.writeFile(
      path.join(eventsDir, "daily.json"),
      JSON.stringify({
        type: "periodic",
        text: "Daily lifecycle review",
        schedule: "0 3 * * *",
        timezone: "Europe/Berlin",
      }),
    );

    const result = await renderCalendarFeed({
      workspaceKey: "ws_a7b3c9",
      workspaceRecord,
      eventsDir,
      refreshInterval: "PT15M",
      now: new Date("2026-04-14T00:00:00.000Z"),
    });

    expect(result.eventCount).toBe(2);
    expect(result.content).toContain("BEGIN:VCALENDAR\r\n");
    expect(result.content).toContain("X-WR-CALNAME:Workspace Events\r\n");
    expect(result.content).toContain("UID:ws_a7b3c9:future.json\r\n");
    expect(result.content).toContain("SUMMARY:Review the roadmap\r\n");
    expect(result.content).toContain("DESCRIPTION:Review the roadmap\r\n");
    expect(result.content).toContain("DTSTART:20260415T073000Z\r\n");
    expect(result.content).toContain("UID:ws_a7b3c9:daily.json\r\n");
    expect(result.content).toContain("DTSTART;TZID=Europe/Berlin:20260414T030000\r\n");
    expect(result.content).toContain("RRULE:FREQ=DAILY\r\n");
    expect(result.content).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT15M\r\n");
    expect(result.warnings).toEqual([]);
  });

  it("omits immediate, past, and unsupported periodic events", async () => {
    await fs.writeFile(
      path.join(eventsDir, "immediate.json"),
      JSON.stringify({ type: "immediate", text: "now" }),
    );
    await fs.writeFile(
      path.join(eventsDir, "past.json"),
      JSON.stringify({
        type: "one-shot",
        text: "already fired",
        at: "2026-04-13T09:30:00+02:00",
      }),
    );
    await fs.writeFile(
      path.join(eventsDir, "unsupported.json"),
      JSON.stringify({
        type: "periodic",
        text: "Odd cron",
        schedule: "*/17 * * * *",
        timezone: "Europe/Berlin",
      }),
    );

    const result = await renderCalendarFeed({
      workspaceKey: "ws_a7b3c9",
      workspaceRecord,
      eventsDir,
      refreshInterval: "PT15M",
      now: new Date("2026-04-14T00:00:00.000Z"),
    });

    expect(result.eventCount).toBe(0);
    expect(result.content).not.toContain("immediate.json");
    expect(result.content).not.toContain("past.json");
    expect(result.content).not.toContain("unsupported.json");
    expect(result.warnings).toEqual([
      "immediate.json: immediate events are omitted from calendar feeds",
      "unsupported.json: unsupported or invalid periodic schedule (*/17 * * * *)",
    ]);
  });
});
