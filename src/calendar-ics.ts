import { Cron } from "croner";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceRecord } from "./provisioner.js";

const ICS_PRODID = "-//pi-bridge//workspace-calendar//EN";
const DEFAULT_EVENT_DURATION = "PT1M";
const WEEKDAY_MAP = new Map<string, string>([
  ["0", "SU"],
  ["1", "MO"],
  ["2", "TU"],
  ["3", "WE"],
  ["4", "TH"],
  ["5", "FR"],
  ["6", "SA"],
  ["7", "SU"],
]);

interface ImmediateScheduledEvent {
  type: "immediate";
  text: string;
}

interface OneShotScheduledEvent {
  type: "one-shot";
  text: string;
  at: string;
}

interface PeriodicScheduledEvent {
  type: "periodic";
  text: string;
  schedule: string;
  timezone: string;
}

type ScheduledEvent = ImmediateScheduledEvent | OneShotScheduledEvent | PeriodicScheduledEvent;

interface EventFileRecord {
  filename: string;
  event: ScheduledEvent;
  modifiedAt: Date;
}

interface SupportedPeriodicSpec {
  frequency: "DAILY" | "WEEKLY" | "MONTHLY";
  hour: number;
  minute: number;
  byDay?: string[];
  byMonthDay?: number;
}

export interface RenderCalendarFeedOptions {
  workspaceKey: string;
  workspaceRecord: WorkspaceRecord;
  eventsDir: string;
  refreshInterval: string;
  now?: Date;
}

export interface RenderCalendarFeedResult {
  content: string;
  warnings: string[];
  eventCount: number;
}

export async function renderCalendarFeed(options: RenderCalendarFeedOptions): Promise<RenderCalendarFeedResult> {
  const now = options.now ?? new Date();
  const { events, warnings } = await readEventFiles(options.eventsDir);
  const eventLines: string[] = [];
  let eventCount = 0;
  let latestModifiedAt = new Date(0);

  for (const entry of events) {
    if (entry.modifiedAt > latestModifiedAt) {
      latestModifiedAt = entry.modifiedAt;
    }

    if (entry.event.type === "immediate") {
      warnings.push(`${entry.filename}: immediate events are omitted from calendar feeds`);
      continue;
    }

    if (entry.event.type === "one-shot") {
      const lines = renderOneShotEvent(options.workspaceKey, entry, now);
      if (!lines) continue;
      eventLines.push(...lines);
      eventCount += 1;
      continue;
    }

    const renderedPeriodic = renderPeriodicEvent(options.workspaceKey, entry, now);
    if (!renderedPeriodic) {
      warnings.push(`${entry.filename}: unsupported or invalid periodic schedule (${entry.event.schedule})`);
      continue;
    }
    eventLines.push(...renderedPeriodic);
    eventCount += 1;
  }

  const calendarName = options.workspaceRecord.calendar?.name
    ?? (options.workspaceRecord.label ? `${options.workspaceRecord.label} — Workspace Events` : `Workspace Events (${options.workspaceKey})`);
  const publishedAt = latestModifiedAt.getTime() > 0 ? latestModifiedAt : now;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${escapeText(options.refreshInterval)}`,
    `X-PUBLISHED-TTL:${escapeText(options.refreshInterval)}`,
    `LAST-MODIFIED:${formatUtc(publishedAt)}`,
    ...eventLines,
    "END:VCALENDAR",
  ];

  return {
    content: toIcs(lines),
    warnings,
    eventCount,
  };
}

async function readEventFiles(eventsDir: string): Promise<{ events: EventFileRecord[]; warnings: string[] }> {
  let entries: Dirent[] = [];
  const warnings: string[] = [];
  try {
    entries = await fs.readdir(eventsDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { events: [], warnings };
    }
    throw err;
  }

  const events: EventFileRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(eventsDir, entry.name);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(filePath, "utf8"),
        fs.stat(filePath),
      ]);
      const event = parseScheduledEvent(JSON.parse(raw) as Record<string, unknown>);
      if (!event) {
        warnings.push(`${entry.name}: invalid event payload`);
        continue;
      }
      events.push({
        filename: entry.name,
        event,
        modifiedAt: stat.mtime,
      });
    } catch (err) {
      warnings.push(`${entry.name}: failed to read (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  events.sort((a, b) => a.filename.localeCompare(b.filename));
  return { events, warnings };
}

function parseScheduledEvent(value: Record<string, unknown>): ScheduledEvent | undefined {
  if (typeof value.type !== "string" || typeof value.text !== "string") return undefined;

  if (value.type === "immediate") {
    return {
      type: "immediate",
      text: value.text,
    };
  }

  if (value.type === "one-shot" && typeof value.at === "string") {
    return {
      type: "one-shot",
      text: value.text,
      at: value.at,
    };
  }

  if (
    value.type === "periodic"
    && typeof value.schedule === "string"
    && typeof value.timezone === "string"
  ) {
    return {
      type: "periodic",
      text: value.text,
      schedule: value.schedule,
      timezone: value.timezone,
    };
  }

  return undefined;
}

function renderOneShotEvent(
  workspaceKey: string,
  entry: EventFileRecord,
  now: Date,
): string[] | undefined {
  if (entry.event.type !== "one-shot") return undefined;

  const when = new Date(entry.event.at);
  if (Number.isNaN(when.getTime()) || when.getTime() <= now.getTime()) {
    return undefined;
  }

  return [
    "BEGIN:VEVENT",
    `UID:${eventUid(workspaceKey, entry.filename)}`,
    `DTSTAMP:${formatUtc(entry.modifiedAt)}`,
    `LAST-MODIFIED:${formatUtc(entry.modifiedAt)}`,
    `DTSTART:${formatUtc(when)}`,
    `DURATION:${DEFAULT_EVENT_DURATION}`,
    `SUMMARY:${escapeText(summarize(entry.event.text))}`,
    `DESCRIPTION:${escapeText(entry.event.text)}`,
    "STATUS:CONFIRMED",
    "TRANSP:TRANSPARENT",
    "X-PI-TYPE:one-shot",
    `X-PI-AT:${escapeText(entry.event.at)}`,
    "END:VEVENT",
  ];
}

function renderPeriodicEvent(
  workspaceKey: string,
  entry: EventFileRecord,
  now: Date,
): string[] | undefined {
  if (entry.event.type !== "periodic") return undefined;

  const supported = parseSupportedPeriodicSchedule(entry.event.schedule);
  if (!supported) return undefined;

  let nextRun: Date | null = null;
  try {
    nextRun = new Cron(entry.event.schedule, { timezone: entry.event.timezone }).nextRun(now);
  } catch {
    return undefined;
  }
  if (!nextRun) return undefined;

  const dtStart = formatLocalDateTime(nextRun, entry.event.timezone);
  return [
    "BEGIN:VEVENT",
    `UID:${eventUid(workspaceKey, entry.filename)}`,
    `DTSTAMP:${formatUtc(entry.modifiedAt)}`,
    `LAST-MODIFIED:${formatUtc(entry.modifiedAt)}`,
    `DTSTART;TZID=${escapeParam(entry.event.timezone)}:${dtStart}`,
    `DURATION:${DEFAULT_EVENT_DURATION}`,
    `RRULE:${buildRRule(supported)}`,
    `SUMMARY:${escapeText(summarize(entry.event.text))}`,
    `DESCRIPTION:${escapeText(entry.event.text)}`,
    "STATUS:CONFIRMED",
    "TRANSP:TRANSPARENT",
    "X-PI-TYPE:periodic",
    `X-PI-SCHEDULE:${escapeText(entry.event.schedule)}`,
    `X-PI-TIMEZONE:${escapeText(entry.event.timezone)}`,
    "END:VEVENT",
  ];
}

function parseSupportedPeriodicSchedule(schedule: string): SupportedPeriodicSpec | undefined {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;

  const [minuteRaw, hourRaw, dayOfMonthRaw, monthRaw, dayOfWeekRaw] = parts;
  const minute = parseSimpleInteger(minuteRaw, 0, 59);
  const hour = parseSimpleInteger(hourRaw, 0, 23);
  if (minute === undefined || hour === undefined || monthRaw !== "*") {
    return undefined;
  }

  if (dayOfMonthRaw === "*" && dayOfWeekRaw === "*") {
    return { frequency: "DAILY", hour, minute };
  }

  if (dayOfMonthRaw === "*" && dayOfWeekRaw !== "*") {
    const byDay = dayOfWeekRaw
      .split(",")
      .map((value) => WEEKDAY_MAP.get(value.trim()))
      .filter((value): value is string => !!value);
    const uniqueByDay = [...new Set(byDay)];
    if (uniqueByDay.length === 0 || uniqueByDay.length !== dayOfWeekRaw.split(",").filter(Boolean).length) {
      return undefined;
    }
    return { frequency: "WEEKLY", hour, minute, byDay: uniqueByDay };
  }

  if (dayOfWeekRaw === "*") {
    const byMonthDay = parseSimpleInteger(dayOfMonthRaw, 1, 31);
    if (byMonthDay === undefined) return undefined;
    return { frequency: "MONTHLY", hour, minute, byMonthDay };
  }

  return undefined;
}

function buildRRule(spec: SupportedPeriodicSpec): string {
  if (spec.frequency === "DAILY") {
    return "FREQ=DAILY";
  }
  if (spec.frequency === "WEEKLY") {
    return `FREQ=WEEKLY;BYDAY=${spec.byDay?.join(",")}`;
  }
  return `FREQ=MONTHLY;BYMONTHDAY=${spec.byMonthDay}`;
}

function eventUid(workspaceKey: string, filename: string): string {
  return `${workspaceKey}:${filename}`;
}

function summarize(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const summary = firstLine && firstLine.length > 0 ? firstLine : "Workspace event";
  return summary.length <= 80 ? summary : `${summary.slice(0, 77)}...`;
}

function parseSimpleInteger(raw: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function escapeParam(value: string): string {
  return value.replace(/([\\;,:"])/g, "\\$1");
}

function formatUtc(value: Date): string {
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}

function formatLocalDateTime(value: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

function toIcs(lines: string[]): string {
  return lines.flatMap(foldLine).join("\r\n") + "\r\n";
}

function foldLine(line: string): string[] {
  if (line.length <= 73) return [line];

  const segments: string[] = [];
  let remaining = line;
  let first = true;
  while (remaining.length > 73) {
    const chunk = remaining.slice(0, 73);
    segments.push(first ? chunk : ` ${chunk}`);
    remaining = remaining.slice(73);
    first = false;
  }
  segments.push(first ? remaining : ` ${remaining}`);
  return segments;
}
