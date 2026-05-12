import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { SessionWatchConfig } from "./config.js";
import type { UserProvisioner } from "./provisioner.js";

const HEALTH_PATH = "/healthz";
const WATCH_ROUTE_PREFIX = "/watch";
const HEARTBEAT_MS = 15000;

type SessionWatchLevel = "info" | "warn" | "error";

export type SessionWatchEvent =
  | { type: "run_start"; runId: string; at: string }
  | { type: "text_delta"; runId: string; delta: string }
  | { type: "tool_start"; runId: string; toolCallId: string; toolName: string; summary: string }
  | { type: "tool_end"; runId: string; toolCallId: string; toolName: string; isError: boolean; preview?: string }
  | { type: "status"; runId: string; at: string; label: string; level: SessionWatchLevel }
  | { type: "run_end"; runId: string; at: string; stopReason?: string; error?: string };

export interface SessionWatchSink {
  publish(workspaceKey: string, event: SessionWatchEvent): void;
}

export class SessionWatchServer implements SessionWatchSink {
  private server: http.Server | undefined;
  private listenReady: Promise<void> | undefined;
  private listeners = new Map<string, Set<(event: SessionWatchEvent) => void>>();
  private streamClosers = new Set<() => void>();

  constructor(
    private readonly config: SessionWatchConfig,
    private readonly provisioner: Pick<UserProvisioner, "getWorkspace">,
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
        console.log(`[session-watch] Live watch listening on ${printable}${WATCH_ROUTE_PREFIX}`);
        resolve();
      });
    });

    await this.listenReady;
  }

  address(): string | AddressInfo | null {
    return this.server?.address() ?? null;
  }

  publish(workspaceKey: string, event: SessionWatchEvent): void {
    for (const listener of this.listeners.get(workspaceKey) ?? []) {
      listener(event);
    }
  }

  async stop(): Promise<void> {
    this.listeners.clear();
    for (const closeStream of [...this.streamClosers]) {
      closeStream();
    }
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

      const eventRoute = parseWatchEventsRoute(pathname);
      if (eventRoute) {
        if (!this.provisioner.getWorkspace(eventRoute.workspaceKey)) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("not found");
          return;
        }
        this.handleEventStream(eventRoute.workspaceKey, req, res);
        return;
      }

      const pageRoute = parseWatchPageRoute(pathname);
      if (!pageRoute) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      if (!this.provisioner.getWorkspace(pageRoute.workspaceKey)) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(renderWatchPage(pageRoute.workspaceKey));
    } catch (err) {
      console.error("[session-watch] Request handling failed:", err);
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("internal server error");
    }
  }

  private handleEventStream(
    workspaceKey: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");

    const unsubscribe = this.subscribe(workspaceKey, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(": keepalive\n\n");
    }, HEARTBEAT_MS);

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      this.streamClosers.delete(cleanup);
      res.end();
    };

    this.streamClosers.add(cleanup);
    req.on("close", cleanup);
    req.on("error", cleanup);
  }

  private subscribe(workspaceKey: string, listener: (event: SessionWatchEvent) => void): () => void {
    const set = this.listeners.get(workspaceKey) ?? new Set<(event: SessionWatchEvent) => void>();
    set.add(listener);
    this.listeners.set(workspaceKey, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(workspaceKey);
      }
    };
  }
}

function parseWatchPageRoute(pathname: string): { workspaceKey: string } | undefined {
  const prefix = `${WATCH_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const trimmed = pathname.slice(prefix.length);
  if (!trimmed || trimmed.includes("/")) return undefined;
  try {
    const workspaceKey = decodeURIComponent(trimmed);
    return workspaceKey ? { workspaceKey } : undefined;
  } catch {
    return undefined;
  }
}

function parseWatchEventsRoute(pathname: string): { workspaceKey: string } | undefined {
  const suffix = "/events";
  const prefix = `${WATCH_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return undefined;
  const trimmed = pathname.slice(prefix.length, -suffix.length);
  if (!trimmed || trimmed.includes("/")) return undefined;
  try {
    const workspaceKey = decodeURIComponent(trimmed);
    return workspaceKey ? { workspaceKey } : undefined;
  } catch {
    return undefined;
  }
}

function renderWatchPage(workspaceKey: string): string {
  const safeWorkspaceKey = escapeHtml(workspaceKey);
  const encodedWorkspaceKey = JSON.stringify(workspaceKey);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Live Session Watch — ${safeWorkspaceKey}</title>
  <style>
    :root {
      --accent: #8abeb7;
      --border: #5f87ff;
      --borderAccent: #00d7ff;
      --success: #b5bd68;
      --error: #cc6666;
      --warning: #ffff00;
      --muted: #808080;
      --dim: #666666;
      --text: #e5e5e7;
      --selectedBg: #3a3a4a;
      --userMessageBg: #343541;
      --userMessageText: #e5e5e7;
      --toolPendingBg: #282832;
      --toolSuccessBg: #283228;
      --toolErrorBg: #3c2828;
      --toolOutput: #808080;
      --body-bg: #18181e;
      --container-bg: #1e1e24;
      --info-bg: #3c3728;
      --line-height: 18px;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
      font-size: 12px;
      line-height: var(--line-height);
      color: var(--text);
      background: var(--body-bg);
    }

    #content {
      width: 100%;
      max-width: 860px;
      margin: 0 auto;
      padding: var(--line-height) calc(var(--line-height) * 2);
    }

    .header {
      background: var(--container-bg);
      border-radius: 4px;
      padding: var(--line-height);
      margin-bottom: var(--line-height);
    }

    .header h1 {
      margin: 0 0 var(--line-height) 0;
      font-size: 12px;
      color: var(--borderAccent);
    }

    .help-bar {
      font-size: 11px;
      color: var(--warning);
      margin-bottom: var(--line-height);
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 12px;
    }

    .help-hint {
      flex: 1 1 260px;
    }

    .connection-pill {
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--dim);
      color: var(--muted);
      background: transparent;
    }

    .connection-pill.connected {
      color: var(--success);
      border-color: var(--success);
    }

    .info-item {
      color: var(--dim);
      display: flex;
      align-items: baseline;
    }

    .info-label {
      font-weight: 600;
      margin-right: 8px;
      min-width: 100px;
    }

    .info-value {
      color: var(--text);
      flex: 1;
    }

    #stream {
      display: flex;
      flex-direction: column;
      gap: var(--line-height);
    }

    .run-block {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .run-label {
      color: var(--muted);
      font-size: 11px;
      padding-left: 4px;
    }

    .assistant-message {
      position: relative;
      padding: var(--line-height);
      border-radius: 4px;
      background: transparent;
    }

    .assistant-text {
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tool-execution {
      padding: var(--line-height);
      border-radius: 4px;
    }

    .tool-execution.pending { background: var(--toolPendingBg); }
    .tool-execution.success { background: var(--toolSuccessBg); }
    .tool-execution.error { background: var(--toolErrorBg); }

    .tool-header {
      font-weight: bold;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .tool-output {
      margin-top: var(--line-height);
      color: var(--toolOutput);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .status-line {
      color: var(--muted);
      padding: 0 4px;
    }

    .status-line.warn {
      color: var(--warning);
    }

    .status-line.error {
      color: var(--error);
    }

    .empty-state {
      background: var(--container-bg);
      border-radius: 4px;
      padding: var(--line-height);
      color: var(--muted);
    }
  </style>
</head>
<body>
  <main id="content">
    <div class="header">
      <h1>Live Session Watch: ${safeWorkspaceKey}</h1>
      <div class="help-bar">
        <span class="help-hint">Localhost-only MVP. Live events only — refresh clears the page and there is no history backfill.</span>
        <span id="connection-pill" class="connection-pill">connecting</span>
      </div>
      <div class="info-item"><span class="info-label">Workspace:</span><span class="info-value">${safeWorkspaceKey}</span></div>
      <div class="info-item"><span class="info-label">Mode:</span><span class="info-value">Live stream from session.subscribe()</span></div>
    </div>
    <div id="stream">
      <div id="empty-state" class="empty-state">Waiting for the next live run…</div>
    </div>
  </main>

  <script>
    (() => {
      const workspaceKey = ${encodedWorkspaceKey};
      const streamEl = document.getElementById("stream");
      const emptyStateEl = document.getElementById("empty-state");
      const connectionPillEl = document.getElementById("connection-pill");
      const toolEls = new Map();
      const runEls = new Map();
      let currentAssistantEl = null;
      let autoScroll = true;

      function setConnectionState(state) {
        connectionPillEl.textContent = state;
        connectionPillEl.classList.toggle("connected", state === "connected");
      }

      function hideEmptyState() {
        if (emptyStateEl) emptyStateEl.style.display = "none";
      }

      function isNearBottom() {
        return window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      }

      function maybeScroll() {
        if (autoScroll) {
          window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        }
      }

      window.addEventListener("scroll", () => {
        autoScroll = isNearBottom();
      }, { passive: true });

      function ensureRun(runId) {
        let runEl = runEls.get(runId);
        if (runEl) return runEl;

        hideEmptyState();
        runEl = document.createElement("section");
        runEl.className = "run-block";
        runEl.dataset.runId = runId;

        const labelEl = document.createElement("div");
        labelEl.className = "run-label";
        labelEl.textContent = "Live run";
        runEl.appendChild(labelEl);

        streamEl.appendChild(runEl);
        runEls.set(runId, runEl);
        return runEl;
      }

      function closeAssistant() {
        currentAssistantEl = null;
      }

      function ensureAssistant(runId) {
        const runEl = ensureRun(runId);
        if (currentAssistantEl && currentAssistantEl.dataset.runId === runId) {
          return currentAssistantEl;
        }

        currentAssistantEl = document.createElement("article");
        currentAssistantEl.className = "assistant-message";
        currentAssistantEl.dataset.runId = runId;

        const textEl = document.createElement("div");
        textEl.className = "assistant-text";
        currentAssistantEl.appendChild(textEl);

        runEl.appendChild(currentAssistantEl);
        return currentAssistantEl;
      }

      function appendStatus(runId, text, level = "info") {
        closeAssistant();
        const runEl = ensureRun(runId);
        const line = document.createElement("div");
        line.className = ("status-line " + level).trim();
        line.textContent = text;
        runEl.appendChild(line);
        maybeScroll();
      }

      function appendTextDelta(runId, delta) {
        const assistantEl = ensureAssistant(runId);
        const textEl = assistantEl.querySelector(".assistant-text");
        textEl.textContent += delta;
        maybeScroll();
      }

      function appendToolStart(runId, event) {
        closeAssistant();
        const runEl = ensureRun(runId);
        const toolEl = document.createElement("article");
        toolEl.className = "tool-execution pending";
        toolEl.dataset.toolCallId = event.toolCallId;
        toolEl.dataset.runId = runId;

        const headerEl = document.createElement("div");
        headerEl.className = "tool-header";
        headerEl.textContent = event.summary;
        toolEl.appendChild(headerEl);

        runEl.appendChild(toolEl);
        toolEls.set(event.toolCallId, toolEl);
        maybeScroll();
      }

      function appendToolEnd(runId, event) {
        closeAssistant();
        const toolEl = toolEls.get(event.toolCallId);
        const target = toolEl ?? (() => {
          appendToolStart(runId, {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            summary: event.toolName,
          });
          return toolEls.get(event.toolCallId);
        })();
        if (!target) return;

        target.classList.remove("pending", "success", "error");
        target.classList.add(event.isError ? "error" : "success");

        let outputEl = target.querySelector(".tool-output");
        if (!outputEl && event.preview) {
          outputEl = document.createElement("div");
          outputEl.className = "tool-output";
          target.appendChild(outputEl);
        }
        if (outputEl) {
          outputEl.textContent = event.preview || (event.isError ? "Tool failed." : "Done.");
        }
        maybeScroll();
      }

      function formatTime(iso) {
        try {
          return new Date(iso).toLocaleTimeString();
        } catch {
          return iso;
        }
      }

      function handleEvent(event) {
        hideEmptyState();
        switch (event.type) {
          case "run_start":
            ensureRun(event.runId).querySelector(".run-label").textContent = "Run started " + formatTime(event.at);
            closeAssistant();
            break;
          case "text_delta":
            appendTextDelta(event.runId, event.delta);
            break;
          case "tool_start":
            appendToolStart(event.runId, event);
            break;
          case "tool_end":
            appendToolEnd(event.runId, event);
            break;
          case "status":
            appendStatus(event.runId, event.label, event.level);
            break;
          case "run_end": {
            const suffix = event.error
              ? "Error: " + event.error
              : event.stopReason
                ? "Run ended (" + event.stopReason + ")"
                : "Run ended";
            appendStatus(event.runId, formatTime(event.at) + " — " + suffix, event.error ? "error" : "info");
            break;
          }
        }
      }

      const source = new EventSource("/watch/" + encodeURIComponent(workspaceKey) + "/events");
      source.onopen = () => setConnectionState("connected");
      source.onerror = () => setConnectionState("reconnecting");
      source.onmessage = (messageEvent) => {
        try {
          handleEvent(JSON.parse(messageEvent.data));
        } catch (err) {
          console.error("live watch parse error", err);
        }
      };
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
