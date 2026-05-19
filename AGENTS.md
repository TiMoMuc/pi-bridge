# pi-bridge — Agent Context

> Read this file completely before touching code. It is the primary agent entry
> point for source-tree conventions. The code is authoritative for behavior.

## What This Is

Transport bridge for the pi coding agent. Signal users text a phone number; Nextcloud
Talk users message a bot room. The agent replies with full tool access (bash, read,
edit, write). Multi-user (~5 trusted users), persistent sessions, per-workspace Docker
sandboxes, and workspace-owned scheduled events.

## Code style

Prefer simple, aesthetic code that tells a good story. Code should flow naturally for
both humans and agents reading it. Flat is better than nested; fewer files is better
than many small ones until complexity forces a split.

Inline documentation should be at a level where one can follow the comments and
understand the code — humans and agents alike. The code is authoritative for how
things work.

## Runtime env boundary

`docker-compose.yml` intentionally uses an explicit `bridge.environment` whitelist instead
of bulk-importing `.env` into the container. When adding or changing a bridge runtime env
var in `src/config.ts`, update all four surfaces together:

- `src/config.ts` — parsing / validation
- `docker-compose.yml` — bridge container passthrough
- `.env.example` — operator-facing example
- `README.md` — operator-facing docs when relevant

If one of these is missed, the bridge may document a setting that never reaches the
running container. Keep the boundary explicit and reviewable.

## Stack

- Node.js 22, TypeScript ESM (`"type": "module"`)
- pi SDK: `@earendil-works/pi-coding-agent` — `createAgentSession`, `SessionManager`, tools
- signal-cli: HTTP JSON-RPC in a separate Docker container, SSE for incoming events
- Testing: vitest — run `npm test` or `npm run check` before every commit
- Dev: `tsx` watch (no build step), Prod: `tsc → dist/`

## Key Patterns (MUST follow)

### 1. runState
Subscriber registered **once** per session. Mutable `runState` object reset before each
`session.prompt()`. Without this, events from previous runs leak into new replies.

### 2. Queue chain
All outgoing transport API calls serialized through a promise chain per run.
Without this, concurrent tool events produce out-of-order messages.

### 3. Silent-turn contract
If the agent calls `wait()`, send **nothing** to the active transport.

### 4. Per-workspace isolation
Each workspace gets an isolated Docker container with a bind-mounted workspace.
Provisioning happens lazily on first contact — see `src/provisioner.ts` and
`src/sandbox.ts`.
Bridge-side workspace layout:
```
workspaceRoot = PROJECTS_DIR/WORKSPACE_PATH/
cwd           = PROJECTS_DIR/WORKSPACE_PATH/cowork/
sessionDir    = PROJECTS_DIR/WORKSPACE_PATH/.bridge/sessions/
gitDir        = PROJECTS_DIR/WORKSPACE_PATH/.bridge/git/
AGENTS.md     = PROJECTS_DIR/WORKSPACE_PATH/.agent/AGENTS.md
```
The host-visible workspace root now also carries a standard `.git` pointer file
that resolves to `.bridge/git`; the bridge owns git writes and the sandbox does
not ship git. `AGENTS.md` content is appended to the prompt without exposing that real file
path. Workspace keys are opaque ids like `ws_a7b3c9`, while `workspacePath` is
the relative path under `PROJECTS_DIR`. Transport bindings live in
`admin/workspace.json` under `transports.signal.sender` or
`transports.signal.groupId`, and `transports.nextcloud.roomToken`;
`primaryTransport` is used for restart-safe scheduled outbound delivery. Bridge-owned
persistent runtime artifacts now live under `BRIDGE_DATA_DIR/admin/`, including
`logs/` for structured bridge JSONL, `inbox/` for accepted inbound work waiting
or replaying, and `outbox/` for pending outbound delivery. Optional workspace
capabilities now hang off `workspace.json.capabilities`; the bridge manages
reachability via per-workspace internal Docker networks while the sandbox still
calls enabled services directly. Capability names should stay honest and narrow
(for example `pdfApi`, `spreadsheetRecalc`) even when the backing container is
broader. The agent's in-container cwd defaults to the workspace root
(`SANDBOX_CWD=.` → `/workspace`) and can be overridden via relative
`SANDBOX_CWD` values such as `./cowork`.

### 5. Dispatch serialization
One pending `handleMessage` promise per workspace at a time.
Incoming messages queue behind the running one. See `SessionRouter.dispatch()`.

## Commands

```bash
npm run dev          # tsx watch src/bridge.ts
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run test:watch   # vitest interactive
npm run build        # tsc → dist/
npm run lint         # eslint src test
npm run check        # typecheck + lint + test — run before every commit

docker compose up --build                           # bridge (runs all configured transports; Signal still uses external signal-cli)
docker compose -f docker-compose.yml -f docker-compose.capabilities.yml up -d   # bridge + optional capability containers such as pdf-api (some capability services may stay commented out by default)
```

## File Map

```
system/
  CONSTITUTION.md              immutable agent constitution — identity, values, principles
  interface-protocol.md        bridge-global protocol — wait(), workspace layout, events, environment rules
  interface-protocol-signal.md Signal addendum — formatting, reactions, `[ATTACH:]`, `[REACT:...]`
  interface-protocol-nextcloud.md Nextcloud addendum — room-bot model, text-only limits

src/
  admin-workspace.ts    operator CLI — `reconcile [--check] [--reset-runners]` for workspace control-plane apply
  attachments.ts         inbound save/vision prep + outbound attachment validation + sandbox path translation
  bridge.ts              main() — startup orchestration, reverse-index inbound routing, special commands, outbound send path
  bridge-runtime.ts      transport-aware auth/recipient/target helpers + inbound binding-id resolution
  calendar-ics.ts        workspace events → iCalendar rendering with recurrence narrowing + warnings
  calendar-publisher.ts  lightweight HTTP server for per-workspace `.ics` subscription feeds
  calendar.ts            calendar route/access-doc helpers + local/public subscription URLs
  code-server.ts         per-workspace code-server container lifecycle, mounts, and stable local URLs
  config.ts              env parsing → Config + transport/sandbox/code-server/calendar + default thinking settings
  workspace-capabilities.ts bridge-owned capability control plane: workspace.json capability toggles, workspace networks, and shared capability container attachments
  events-manager.ts      per-workspace EventsWatcher registry + sender injection from workspace context
  events.ts              EventsWatcher — immediate/one-shot/periodic JSON event files
  format.ts              markdown → Signal body-range text styles
  inbox-queue.ts         durable accepted-inbound queue under `admin/inbox/` with startup replay
  logger.ts              thin bridge logger — stdout mirror + persistent JSONL under `admin/logs/`
  outbound-control.ts    shared parser for wait(), `[REACT:...]`, `[ATTACH:...]` + visible-text extraction
  outbound-delivery.ts   prepareOutboundChunks() + empty-send suppression after token stripping
  outbox-queue.ts        durable outbound send queue under `admin/outbox/` with chunk-progress recovery
  provisioner.ts         blueprint copy, opaque workspace ids, reverse index, workspace.json registry + code-server/calendar/model metadata
  runner.ts              AgentRunner + session creation + wait() custom tool registration + sandbox tool overrides + raw assistant response capture
  sandbox.ts             Docker sandbox lifecycle, executors, host-mount detection
  session-router.ts      per-workspace runner cache + dispatch serialization + workspace PI selection resolution + sandbox lookup
  session-watch.ts       optional live watch page + SSE stream for `session.subscribe()` run/tool/text events
  sibling-containers.ts  shared sibling-container naming, labels, discovery, and workspace-key sanitizing
  split.ts               splitMessage() + splitForSignal() + splitWithStyles()
  transport.ts           transport boundary + inbound metadata + send options/reply targeting
  workspace-control.ts   workspace desired-state summary + reconcile execution for code-server/calendar/provider-model-thinking drift
  workspace-git.ts       bridge-owned workspace git repo init/healing + post-run snapshot commits
  workspace-paths.ts     shared workspace/bridge path constants + normalization helpers
  transports/
    index.ts             transport factory — createTransports(config)
    nextcloud.ts         NextcloudTransport — Talk webhook server, HMAC verify, room-token inbound metadata, room-targeted text send
    signal.ts            SignalTransport — SSE adapter, reconnect, dedup, reactions, message refs
    signal-client.ts     low-level signal-cli JSON-RPC + readiness probe
    signal-message-refs.ts  JSONL Signal↔session message reference store + preview helper
    signal-reaction-tags.ts compatibility wrappers around outbound reaction-tag parsing

test/
  admin-workspace.test.ts
  attachments.test.ts
  bridge-runtime.test.ts
  bridge.test.ts
  calendar-ics.test.ts
  calendar-publisher.test.ts
  calendar.test.ts
  code-server.test.ts
  compose-env-parity.test.ts
  config.test.ts
  workspace-capabilities.test.ts
  events-manager.test.ts
  events.test.ts
  format.test.ts
  message-refs.test.ts
  nextcloud-transport.test.ts
  orient-script.test.ts
  outbound-control.test.ts
  outbound-delivery.test.ts
  provisioner.test.ts
  session-log-parser-skill.test.ts
  runner.test.ts
  sandbox.test.ts
  session-router.test.ts
  session-watch.test.ts
  signal-client.test.ts
  signal-reaction-tags.test.ts
  signal-transport.test.ts
  split.test.ts
  transport-factory.test.ts
  workspace-control.test.ts
  workspace-git.test.ts
  inbox-queue.test.ts
  logger.test.ts
  outbox-queue.test.ts
  integration/
    sdk-smoke.test.ts

__blueprint__/           per-workspace template (baked into Docker image)
  .agent/
    AGENTS.md            single auto-loaded workspace entry point; agent-owned notes + orientation instructions
    orient.py            optional workspace-owned orientation CLI (`python .agent/orient.py`)
    skills/
      session-log-parser bundled user skill copy in the default blueprint
  .bridge/               bridge-owned workspace state root (empty placeholder in blueprint)
  .events/               empty by default; populated later when the agent or bridge needs scheduled work
  cowork/                shared writable working surface for the agent
  upload/                inbound source material; mounted read-only in the sandbox
```

## Environment Variables

See `.env.example`. Required depends on transport/provider:
`SIGNAL_PHONE_NUMBER` for Signal, `NEXTCLOUD_BASE_URL` + `NEXTCLOUD_BOT_SECRET`
for Nextcloud, plus the API key for the selected model provider. All others have
defaults.
