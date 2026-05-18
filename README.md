# pi-bridge

Message the bridge on Signal or Nextcloud Talk → a [pi coding agent](https://github.com/badlogic/pi-mono) replies with full tool access (bash, read, edit, write). Each workspace is persistent, gets its own session history and sandbox companion, may opt into a code-server companion, and can continue improving itself through workspace-owned scheduled events.

The bridge can now run **Signal and Nextcloud simultaneously in one process**. Global bridge state lives under `BRIDGE_DATA_DIR` inside the container (default host path `bridge-data/`), while workspaces live under `PROJECTS_DIR` / `PROJECTS_HOST_DIR` and are still identified internally by opaque keys like `ws_a7b3c9`.

---

## Repository Layout

```text
README.md                   ← setup guide and operator docs
AGENTS.md                   ← source-facing context file for coding agents
package.json                ← npm package metadata and scripts
docker-compose.yml          ← single compose stack
.env.example                ← operator-facing environment example

src/                        ← TypeScript source
system/                     ← constitution and interface protocol layers
__blueprint__/              ← per-workspace template
code-server/                ← code-server bootstrap assets

test/                       ← vitest tests
```

---

## Prerequisites

- Docker and Docker Compose
- A running `signal-cli` HTTP daemon if you want Signal enabled
- Nextcloud Talk bot credentials if you want Nextcloud enabled
- Provider credentials for your selected pi provider — API key or supported pi OAuth login (for example GitHub Copilot)

---

## Setup

### 1. Create `.env`

```bash
cp .env.example .env
```

### 2. Configure transports and paths

If both Signal and Nextcloud are configured, both start.

#### Transport, model, and access variables

| Variable | Required | Purpose |
|---|---|---|
| `SIGNAL_PHONE_NUMBER` | for Signal | Enables Signal transport |
| `SIGNAL_CLI_URL` | optional | signal-cli JSON-RPC base URL |
| `NEXTCLOUD_BASE_URL` | for Nextcloud | Enables Nextcloud transport |
| `NEXTCLOUD_BOT_SECRET` | for Nextcloud | Talk bot webhook secret |
| `NEXTCLOUD_WEBHOOK_HOST` / `NEXTCLOUD_WEBHOOK_PORT` / `NEXTCLOUD_WEBHOOK_PATH` | optional | Local webhook listener settings |
| `PI_CODING_AGENT_DIR` | optional | Overrides pi's config dir; use `/bridge-data/pi-agent` to persist OAuth auth in bridge-owned storage |
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING_LEVEL` | optional | Default provider/model/thinking selection when a workspace has no override |
| `DEFAULT_NEW_WORKSPACE_BOOT_ENABLED` | optional | First-provisioning default for the per-workspace `boot.enabled` flag written into `workspace.json` |
| provider credentials | required for selected provider | Authentication via API key env vars or pi OAuth state in `PI_CODING_AGENT_DIR` |
| `BRIDGE_ACCESS_MODE=open|closed|pending` | optional | Unknown transport bindings auto-provision (`open`), are rejected (`closed`), or create a pending approval request in `workspace.json` (`pending`) |

#### Path model

There are two path layers:

| Layer | Variables | Meaning |
|---|---|---|
| host paths | `BRIDGE_DATA_HOST_DIR`, `PROJECTS_HOST_DIR` | the real directories on your machine |
| in-container paths | `BRIDGE_DATA_DIR`, `PROJECTS_DIR` | what the bridge calls those directories inside the container |

Use the **host-path variables** when you want to choose where files live on your machine. Use the **in-container variables** only when you need a non-default mount layout inside the bridge container.

For the common single-root setup:

```env
BRIDGE_DATA_HOST_DIR=/absolute/path/to/bridge-data
# PROJECTS_HOST_DIR defaults to ${BRIDGE_DATA_HOST_DIR}/projects when unset
BRIDGE_DATA_DIR=/bridge-data
PROJECTS_DIR=/bridge-data/projects
```

You may still set `PROJECTS_HOST_DIR` explicitly to the same path if you want to be fully explicit:

```env
BRIDGE_DATA_HOST_DIR=/absolute/path/to/bridge-data
PROJECTS_HOST_DIR=/absolute/path/to/bridge-data/projects
BRIDGE_DATA_DIR=/bridge-data
PROJECTS_DIR=/bridge-data/projects
```

That gives you this host layout:

```text
bridge-data/
  admin/
  pi-agent/
  projects/
```

For a split setup with workspaces on a separate disk/share:

```env
BRIDGE_DATA_HOST_DIR=/absolute/path/to/bridge-data
PROJECTS_HOST_DIR=/absolute/path/to/projects
BRIDGE_DATA_DIR=/bridge-data
PROJECTS_DIR=/projects
```

Notes:

- if the host-path variables are unset, this repo's Compose defaults to `./bridge-data` and `./bridge-data/projects`
- if `BRIDGE_DATA_HOST_DIR` is set and `PROJECTS_HOST_DIR` is unset, this repo's Compose derives `PROJECTS_HOST_DIR` as `${BRIDGE_DATA_HOST_DIR}/projects`
- in the fully default setup, the bridge auto-detects the real absolute host paths from Docker
- if you set `BRIDGE_DATA_HOST_DIR` or `PROJECTS_HOST_DIR` explicitly, prefer absolute host paths
- the defaults `BRIDGE_DATA_DIR=/bridge-data` and `PROJECTS_DIR=/bridge-data/projects` are usually the right choice
- removed legacy env names are no longer accepted; the bridge now fails fast with exact replacement guidance if it sees them

### 3. Build and start

```bash
docker compose up --build -d
```

### 4. What `docker compose up -d --build` rebuilds

This command rebuilds the **Compose-managed images and containers** in this repo, especially the bridge image and the helper images used for future sibling-container creates.

It does **not** automatically rebuild or recreate existing per-workspace sibling containers such as:
- sandbox containers like `pi-sandbox-...`
- code-server containers like `code-server-...`

Those workspace containers are created by the bridge itself via Docker CLI, not by Compose. So bridge code updates take effect on the next `docker compose up -d --build`, while changes to `Dockerfile.sandbox` or `Dockerfile.code-server` only reach an existing workspace container when that specific sibling container is later recreated.

### 5. View logs

Live tail:

```bash
docker compose logs -f bridge
```

Persistent bridge-owned logs on the host (default repo path shown; replace with `BRIDGE_DATA_HOST_DIR` if customized):

```bash
ls bridge-data/admin/logs/
tail -f bridge-data/admin/logs/bridge-$(date +%F).jsonl
```

The bridge now also keeps durable inbox/outbox state under
`BRIDGE_DATA_HOST_DIR/admin/inbox/` and `BRIDGE_DATA_HOST_DIR/admin/outbox/`
(default repo paths: `bridge-data/admin/inbox/` and `bridge-data/admin/outbox/`)
so accepted inbound work and pending replies survive bridge restarts.

### 6. Stop

```bash
docker compose down
```

---

## Access Model

`BRIDGE_ACCESS_MODE` controls first contact:

- **open** (default): unknown transport bindings auto-provision a fresh workspace immediately
- **closed**: only bindings already present in `BRIDGE_DATA_HOST_DIR/admin/workspace.json` (default `bridge-data/admin/workspace.json`) may connect
- **pending**: unknown transport bindings create a pending request in `workspace.json`, reply with a pending message, and wait for admin approval before provisioning

The allowlist is now the workspace registry itself.

---

## Workspace Registry

The bridge-owned registry lives on the host at `BRIDGE_DATA_HOST_DIR/admin/workspace.json` (default `bridge-data/admin/workspace.json`).

Each record now combines identity, desired state, and allocation metadata. In addition to transport bindings and optional provider/model overrides, the registry can carry:

- `status: "active" | "pending"`
- `workspacePath` — the relative path under `PROJECTS_DIR` where the workspace lives
- `provisionedAt` — the timestamp when the workspace directory was first provisioned

Notes:

- Workspace keys remain opaque `ws_` ids; they are bridge identity, not the human-facing path.
- Inbound routing still uses an in-memory reverse index built from `transports`.
- `primaryTransport` is used for event-triggered outbound messages with no inbound origin.
- Signal bindings may be either `{ "sender": "+1555..." }` for DMs or `{ "groupId": "...", "userWhitelist": [] }` for shared group workspaces.
- Nextcloud bindings route by room token, and the bridge may auto-suggest a human-readable `workspacePath` from the room name when provisioning in `open` mode.
- Pending workspaces stay in the registry and reverse index, but do not provision files or create runners until they are approved and reconciled.

---

## Code-server

Code-server desired state lives in `workspace.json`:

```json
"codeServer": {
  "enabled": false,
  "password": "...",
  "port": 18440
}
```

Behavior:

- `codeServer.enabled` is explicit per workspace; generated fields stay bridge-owned
- new workspaces use `.env` provisioning defaults (`DEFAULT_NEW_WORKSPACE_CODE_SERVER_ENABLED`) only on first contact
- startup + explicit reconcile ensure the running code-server containers match `workspace.json`
- bridge shutdown stops running code-server sibling containers, but does not delete them
- normal inbound messages do **not** auto-spawn code-server

After editing `workspace.json`, apply desired state with:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile
```

Dry-run summary:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile --check
```

Access details are shown in the bridge-owned `!status` dashboard.

---

## Boot preload defaults

New sessions may optionally preload the output of a workspace-owned orientation
script into the prompt. The bridge stores that choice explicitly in each
workspace's `workspace.json` record.

Global bridge config lives in `.env`:

```bash
DEFAULT_NEW_WORKSPACE_BOOT_ENABLED=true
```

Per-workspace metadata lives in `workspace.json`:

```json
"boot": {
  "enabled": true
}
```

Behavior:

- `boot.enabled` is explicit per workspace once provisioned
- new workspaces use the `.env` boot default only on first contact
- changing `.env` later does **not** rewrite existing workspace boot settings
- when enabled, the runner preloads the fixed workspace-owned orientation script at `/workspace/.agent/orient.py` and falls back narrowly to legacy boot script paths for older workspaces

---

## Calendar subscription feeds

The bridge can optionally publish each workspace's supported scheduled events as
an iCalendar subscription feed. This is intentionally **read-only** and is not a
CalDAV account.

Global bridge config lives in `.env`:

```bash
DEFAULT_NEW_WORKSPACE_CALENDAR_ENABLED=false
CALENDAR_ENABLED=true
CALENDAR_HTTP_HOST=0.0.0.0
CALENDAR_HTTP_PORT=8789
CALENDAR_PUBLIC_BASE_URL=https://calendar.example.com
CALENDAR_REFRESH_INTERVAL=PT15M
```

Per-workspace metadata lives in `workspace.json`:

```json
"calendar": {
  "enabled": true,
  "token": "random-base64url",
  "name": "Workspace Events (ws_a7b3c9)"
}
```

Behavior:

- `calendar.enabled` is explicit per workspace; generated fields stay bridge-owned
- new workspaces use `.env` provisioning defaults (`DEFAULT_NEW_WORKSPACE_CALENDAR_ENABLED`) only on first contact
- `CALENDAR_ENABLED` controls the global HTTP publisher only; it does not override per-workspace desired state
- the bridge serves `GET /calendar/:workspaceKey/:token.ics`
- feeds are generated on request from the workspace's `.events/` directory
- supported mapping is intentionally narrow:
  - future `one-shot` events
  - `periodic` events only when the cron maps cleanly to simple daily / weekly / monthly recurrence
  - `immediate` events are omitted
- the event text sent to the agent is included in the calendar entry `DESCRIPTION`
- refresh hints (`REFRESH-INTERVAL`, `X-PUBLISHED-TTL`) are emitted, but client polling cadence still depends on the calendar app

After editing `workspace.json`, apply desired state with:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile
```

Access details are shown in the bridge-owned `!status` dashboard.

For external devices, publish the stable `CALENDAR_HTTP_PORT` through your
existing Cloudflare tunnel or another HTTPS reverse proxy, then subscribe to
the resulting URL as an **internet calendar** / **subscription calendar**.
Do not import it as a local copy.

---

## Localhost live session watch (MVP)

The bridge can optionally expose a tiny web page that shows live
`session.subscribe()` events for a workspace: assistant text deltas, tool
starts/ends, and a few run-status messages such as compaction or retry.

This is intentionally narrow:

- disabled by default
- in direct bridge runs, `SESSION_WATCH_HOST` defaults to `127.0.0.1`
- in this repo's `docker-compose.yml`, `SESSION_WATCH_HOST` defaults to `0.0.0.0`
  so the published host port can reach the server
- **live only** — no session-history backfill on page load
- no `workspace.json` metadata
- no public URL / reverse proxy model
- repo-owned copied/adapted styling inspired by pi's HTML export, with **no
  runtime dependency** on pi internal `export-html` files

Optional `.env` settings for the Compose deployment in this repo:

```bash
SESSION_WATCH_ENABLED=true
SESSION_WATCH_HOST=0.0.0.0
SESSION_WATCH_PORT=8791
```

Then open from the same machine:

```text
http://127.0.0.1:8791/watch/WORKSPACE_KEY
```

Because the page may expose sensitive tool arguments/results and work in
progress, keep the published host port local or otherwise restrict access. If
you want strict localhost-only exposure in Docker, publish the port on
`127.0.0.1` (for example via the Compose port mapping) rather than binding the
service to `127.0.0.1` inside the container. If this surface is no longer
needed, it should be easy to remove entirely.

---

## How It Works

### Message flow

```text
Signal / Nextcloud message
  → transport adapter
  → reverse index lookup (transport binding → workspace key)
  → SessionRouter.dispatch(workspaceKey)
  → AgentRunner.run()
  → outbound transport chosen from inbound transport or workspace primaryTransport

Signal specifics:
- Signal DMs route by sender identity.
- Signal groups route by `groupId`, so replies go back to the group instead of the sender DM.
- Signal group participants may share one workspace while remaining participant-neutral in agent-visible text for now.
```

### Provisioning

On first contact in `open` mode, the bridge:

1. generates a workspace key like `ws_a7b3c9`
2. derives or allocates a relative `workspacePath` under `PROJECTS_DIR`
3. copies `__blueprint__/` into `PROJECTS_DIR/workspacePath`
4. provisions the fixed zone layout:
   - `upload/`
   - `cowork/`
   - `.agent/`
   - `.events/`
   - `.bridge/`
   - a root `.git` pointer file whose real git dir lives at `.bridge/git/`
5. writes the transport binding plus allocation metadata into `workspace.json`
6. writes explicit per-workspace desired-state blocks for boot, code-server, and calendar defaults
7. if the new-workspace defaults request it, allocates bridge-owned lazy fields (code-server credentials/port or calendar token/name) and applies the desired state

The current blueprint is deliberately lean: agent-owned notes live under `.agent/`, the shared writable surface is `cowork/`, inbound source material lands in read-only `upload/`, and scheduled event files live in `.events/`. New sessions may preload `.agent/orient.py` output through the per-workspace `boot.enabled` flag in `workspace.json`; new workspace records seed that flag from the `.env` default on first provisioning only. Scheduled workspace events resume the agent through synthetic `read(".events/<file>.json")` tool activity once the workspace already has a session file. Event files are discovered through a reconcile loop over `.events/`, not by trusting a single filesystem edge notification. Before first user activity, immediate and one-shot events are dropped when they fire; periodic files stay on disk and their scheduled occurrences are suppressed until session history exists. `wait()` is now the silent-turn tool. Richer pause semantics and compaction / session renewal remain separate follow-up work.

### Bridge-owned workspace git history

Each provisioned workspace is now a normal host-side git repo for SSH maintenance, but the real git directory lives under `.bridge/git/` and the workspace root only carries the standard `.git` pointer file. The bridge container owns git writes and keeps its operational exclude rules in `.bridge/git/info/exclude`; the sandbox image still does **not** ship git.

The bridge creates an initial snapshot when a workspace is provisioned or first healed on startup, then commits one new snapshot after every completed inbound or scheduled workspace run. Session JSONL files under `.bridge/sessions/` are included in that history, so a purely conversational turn still produces a commit when the session log changes.

Remote maintenance can use normal SSH git workflows against the workspace root; the live repo is configured with `receive.denyCurrentBranch=updateInstead` plus a bridge-seeded `push-to-checkout` hook that updates the separate-git-dir worktree/index without moving the branch ref itself. The current `!reset-workspace` command remains intentionally destructive and recreates fresh git history instead of preserving the old history.

### Sandboxing

Tool calls run inside a per-workspace Docker sibling container. Each workspace gets its own sandbox container keyed by the opaque workspace id. The sandbox workspace root is fixed at `/workspace`; `SANDBOX_CWD` is configured relative to that root, so `.` means `/workspace` and `./cowork` would mean `/workspace/cowork`.

### Prompt architecture

The system prompt still uses three layers:

1. Constitution
2. Interface protocol(s)
3. workspace `AGENTS.md`

With multi-transport startup, the runner loads the bridge-global protocol plus the addendum for the workspace's primary transport.

---

## Special Commands

| Command | Effect |
|---|---|
| `!help` | show built-in command help |
| `!status` | show the workspace dashboard (session/model plus infrastructure access details when available) |
| `!reset` | start a fresh session |
| `!reset-workspace` | wipe workspace and re-provision from blueprint (currently destroys prior workspace git history too) |
| `!context` | dump the full LLM context to a temporary file and attach it where the active transport supports outbound attachments |

`!reset-silent` remains available for bridge-owned scheduled maintenance, but is intentionally omitted from the normal help text.

---

## Providers

The bridge uses the pi SDK. Set `PI_PROVIDER`, `PI_MODEL`, `PI_THINKING_LEVEL`, and the matching API key.

Examples:

```bash
PI_PROVIDER=anthropic
PI_MODEL=claude-sonnet-4-5
PI_THINKING_LEVEL=off
ANTHROPIC_API_KEY=sk-ant-...
```

```bash
PI_PROVIDER=openai
PI_MODEL=gpt-4o
PI_THINKING_LEVEL=medium
OPENAI_API_KEY=sk-...
```

Per-workspace overrides live in `workspace.json` and take effect on the next fresh runner. After editing provider/model/thinking settings, apply the control-plane update with:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile --reset-runners
```

Only inactive workspaces with provider/model/thinking drift are reset; active completions are left alone.

### GitHub Copilot auth inside the bridge container

For the minimal persistent setup, point pi at bridge-owned persistent storage:

```bash
PI_CODING_AGENT_DIR=/bridge-data/pi-agent
```

Then start the bridge, open a shell in the container, and run pi's login flow there:

```bash
docker compose up --build -d
docker compose exec bridge sh
pi
# then inside pi: /login
```

Choose **GitHub Copilot** in the login menu. Because the bridge-data mount is persisted by the Compose setup, pi writes its auth under the host-side bridge data directory (default `bridge-data/pi-agent/auth.json`), so the login survives bridge rebuilds.

You do **not** need `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING_LEVEL` just to authenticate. Keep using per-workspace overrides, or set those env vars only if you want GitHub Copilot to become the default fallback selection for workspaces without overrides.

---

## Deploying Updates

```bash
git pull
docker compose up --build -d
```

Bridge data under `BRIDGE_DATA_HOST_DIR` (default `bridge-data/`) and workspaces under `PROJECTS_HOST_DIR` (default `bridge-data/projects/`, or `${BRIDGE_DATA_HOST_DIR}/projects` when only `BRIDGE_DATA_HOST_DIR` is set) persist across bridge rebuilds.

---

## Troubleshooting

**Bridge startup / transport errors**
```bash
docker compose logs -f bridge
# or inspect the persistent JSONL files (default repo path shown):
tail -f bridge-data/admin/logs/bridge-$(date +%F).jsonl
```

**Unknown transport binding is ignored**
- check `BRIDGE_ACCESS_MODE`
- if mode is `closed`, add the transport binding to `BRIDGE_DATA_HOST_DIR/admin/workspace.json` (default `bridge-data/admin/workspace.json`)

**Need to inspect a workspace session**
```bash
cat /absolute/path/to/projects/WORKSPACE_PATH/.bridge/sessions/*.jsonl | jq .
# default repo path: cat bridge-data/projects/WORKSPACE_PATH/.bridge/sessions/*.jsonl | jq .
```

**Need to inspect or clone bridge-owned workspace git history**
```bash
git -C /absolute/path/to/projects/WORKSPACE_PATH log --oneline --decorate --graph -5
# or clone from another machine over SSH:
git clone user@host:/absolute/path/to/projects/WORKSPACE_PATH
```

**Need to inspect pending bridge-owned receipt / delivery state**
```bash
# default repo paths shown; replace bridge-data with BRIDGE_DATA_HOST_DIR if customized
find bridge-data/admin/inbox -maxdepth 2 -name '*.json' -print
find bridge-data/admin/outbox -maxdepth 2 -name '*.json' -print
```

**Need to apply edited workspace control-plane state**
```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile
```
