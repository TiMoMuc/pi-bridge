import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { CalendarConfig } from "./config.js";
import { CALENDAR_ROUTE_PREFIX } from "./calendar.js";
import { renderCalendarFeed } from "./calendar-ics.js";
import { UserProvisioner } from "./provisioner.js";

const HEALTH_PATH = "/healthz";

export class CalendarPublisher {
  private server: http.Server | undefined;
  private listenReady: Promise<void> | undefined;

  constructor(
    private readonly config: CalendarConfig,
    private readonly provisioner: UserProvisioner,
  ) {}

  async start(): Promise<void> {
    if (!this.config.enabled) return;
    if (this.server) return;

    this.listenReady = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.config.port, this.config.bindHost, () => {
        this.server = server;
        const address = server.address();
        const printable = typeof address === "string"
          ? address
          : `${address?.address ?? this.config.bindHost}:${address?.port ?? this.config.port}`;
        console.log(`[calendar] Subscription feed listening on ${printable}${CALENDAR_ROUTE_PREFIX}`);
        resolve();
      });
    });

    await this.listenReady;
  }

  address(): string | AddressInfo | null {
    return this.server?.address() ?? null;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = undefined;
    this.listenReady = undefined;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const pathname = req.url ? new URL(req.url, "http://localhost").pathname : "/";

      if (method === "GET" && pathname === HEALTH_PATH) {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (method !== "GET") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("method not allowed");
        return;
      }

      const route = parseCalendarRoute(pathname);
      if (!route) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const workspace = this.provisioner.getWorkspace(route.workspaceKey);
      if (!workspace?.calendar?.enabled || !workspace.calendar.token || workspace.calendar.token !== route.token) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const paths = this.provisioner.getWorkspacePaths(route.workspaceKey);
      if (!paths) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      const eventsDir = paths.eventsDir;
      const feed = await renderCalendarFeed({
        workspaceKey: route.workspaceKey,
        workspaceRecord: workspace,
        eventsDir,
        refreshInterval: this.config.refreshInterval,
      });

      for (const warning of feed.warnings) {
        console.log(`[calendar] ${route.workspaceKey}: ${warning}`);
      }

      res.writeHead(200, {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="${route.workspaceKey}.ics"`,
        "Cache-Control": "private, no-cache",
      });
      res.end(feed.content);
    } catch (err) {
      console.error("[calendar] Request handling failed:", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("internal server error");
    }
  }
}

function parseCalendarRoute(pathname: string): { workspaceKey: string; token: string } | undefined {
  const prefix = `${CALENDAR_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(".ics")) return undefined;

  const trimmed = pathname.slice(prefix.length, -4);
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return undefined;

  try {
    const workspaceKey = decodeURIComponent(trimmed.slice(0, slash));
    const token = decodeURIComponent(trimmed.slice(slash + 1));
    if (!workspaceKey || !token) return undefined;
    return { workspaceKey, token };
  } catch {
    return undefined;
  }
}
