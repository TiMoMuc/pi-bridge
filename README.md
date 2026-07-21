# pi-bridge

Message the bridge on Signal or Nextcloud Talk → a [pi coding agent](https://github.com/badlogic/pi-mono) replies with full tool access (bash, read, edit, write). Each workspace is persistent, gets its own session history and sandbox companion, may opt into a code-server companion, and can continue improving itself through workspace-owned scheduled events.

The bridge can now run **Signal and Nextcloud simultaneously in one process**. Global bridge state lives under `BRIDGE_DATA_DIR` inside the container (default host path `bridge-data/`), while workspaces live under `PROJECTS_DIR` / `PROJECTS_HOST_DIR` and are still identified internally by opaque keys like `ws_a7b3c9`.

---

## Repository Layout

```text
README.md                   ← setup guide and operator docs
AGENTS.md                   ← source-facing context file for coding agents
package.json                ← npm package metadata and scripts
docker-compose.yml          ← base compose stack
docker-compose.signal.yml   ← optional coupled `signal-cli` companion overlay
docker-compose.capabilities.yml ← optional capability containers (for example `pdf-api`)
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
- For Signal: either an external `signal-cli` HTTP daemon, or this repo's optional `docker-compose.signal.yml` companion overlay
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
| `SIGNAL_CLI_IMAGE` | optional, coupled Signal mode | published companion image used by `docker-compose.signal.yml` |
| `NEXTCLOUD_BASE_URL` | for Nextcloud | Enables Nextcloud transport |
| `NEXTCLOUD_BOT_SECRET` | for Nextcloud | Talk bot webhook secret |
| `NEXTCLOUD_WEBHOOK_HOST` / `NEXTCLOUD_WEBHOOK_PORT` / `NEXTCLOUD_WEBHOOK_PATH` | optional | Local webhook listener settings |
| `PI_CODING_AGENT_DIR` | optional | Overrides pi's config dir; use `/bridge-data/pi-agent` to persist OAuth auth in bridge-owned storage |
| `PI_PROVIDER` / `PI_MODEL` / `PI_THINKING_LEVEL` | optional | Default provider/model/thinking selection when a workspace has no override |
| `DEFAULT_NEW_WORKSPACE_BOOT_ENABLED` | optional | First-provisioning default for the per-workspace `boot.enabled` flag written into `workspace.json` |
| `ADMIN_UI_PORT` / `ADMIN_UI_USER` / `ADMIN_UI_PASSWORD` | optional | Enables the built-in operator UI when both credentials are set; `ADMIN_UI_PORT` chooses the published local port |
| `ADMIN_UI_PUBLISH_HOST` | optional | Host-side Docker publish address for the admin UI port; keep `127.0.0.1` for localhost-only access or use `0.0.0.0` / a specific LAN IP for other machines |
| provider credentials | required for selected provider | Authentication via API key env vars or pi OAuth state in `PI_CODING_AGENT_DIR` |
| `BRIDGE_ACCESS_MODE=open|closed|pending` | optional | Unknown transport bindings auto-provision (`open`), are rejected (`closed`), or create a pending approval request in `workspace.json` (`pending`) |

#### Signal deployment modes

Signal has two supported deployment shapes:

1. **External `signal-cli` daemon**
   - run `signal-cli` separately (for example via the standalone [`signal-container`](https://github.com/TiMoMuc/signal-container) repo)
   - the standard standalone container publishes `8088` on the host, so from the bridge container the default external URL is `http://host.docker.internal:8088`
   - inbound Signal attachments still work through `getAttachment`
   - outbound Signal attachments only work when the external service can read the same absolute workspace paths the bridge sends

2. **Coupled Signal companion**
   - start the optional `docker-compose.signal.yml` overlay from this repo
   - the bridge then uses `http://signal-cli:8080` on the internal Compose network; no host port is published by default
   - the companion mounts `${PROJECTS_HOST_DIR}` at `${PROJECTS_DIR}` so outbound Signal attachments work without extra path translation
   - `SIGNAL_CLI_IMAGE` lets operators pin or override the published companion image tag

First-time Signal registration is still an operator setup step in both modes. The bridge waits for a ready daemon; it does not provision the Signal account for you. For the coupled companion, a typical first link command is:

```bash
docker compose -f docker-compose.yml -f docker-compose.signal.yml run --rm signal-cli link --name "pi-bridge"
```

For a dedicated bot number, use the same `run --rm signal-cli ...` shape with `register`, optional `register --voice`, and `verify`; see the published `signal-container` docs for the full verification flow.

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

#### Advanced / dev: run the bridge and siblings as a specific host UID:GID

By default, the Compose setup in this repo keeps the current root/root runtime shape.
Leave the advanced runtime-identity env vars unset unless you explicitly want the
bridge, sandbox, and code-server to write bind-mounted host files as a specific host
user.

Optional advanced/dev `.env` settings:

```env
BRIDGE_RUNTIME_UID=1001
BRIDGE_RUNTIME_GID=1001
BRIDGE_DOCKER_SOCKET_GID=989
```

Typical host checks before filling those values in:

```bash
id -u
id -g
stat -c 'path=%n owner_uid=%u owner_gid=%g mode=%a' /var/run/docker.sock
```

Use this only when all of the following are true:

- you want host-visible workspace and bridge-data files to be owned by a real maintenance user
- you have already stopped the bridge and manually re-owned the managed trees under `BRIDGE_DATA_HOST_DIR` and `PROJECTS_HOST_DIR`
- you know the numeric group that owns `/var/run/docker.sock` on the host and set `BRIDGE_DOCKER_SOCKET_GID` to that value

Important truths:

- this is an **advanced/dev override**, not the default operator path
- the bridge remains a **high-trust control-plane service** even in non-root mode, because Docker socket access still grants broad control over sibling containers
- if these values are wrong, sandbox/code-server lifecycle operations will fail
- non-root sandbox mode aligns host file ownership, but root-only package-manager commands inside the sandbox may stop working; leave the override unset if you want the existing root/root behavior

One-time host migration before enabling the override:

```bash
cd /path/to/pi-bridge
docker compose down
sudo chown -R <user>:<group> /absolute/path/to/bridge-data
# and /absolute/path/to/projects too when it is a separate tree
```

### 3. Build and start

Short helper from the repo root:

```bash
./bridge           # base stack → docker compose up -d --build
./bridge sig       # bridge + coupled Signal companion
./bridge cap       # bridge + optional capability containers
./bridge all       # bridge + Signal + capabilities
```

The helper also passes through arbitrary `docker compose` arguments against the selected stack, for example:

```bash
./bridge all logs -f bridge
./bridge sig run --rm signal-cli link --name "pi-bridge"
```

Base bridge only (Nextcloud-only deployments, or Signal pointed at an external daemon):

```bash
docker compose up --build -d
```

Bridge plus the coupled Signal companion:

```bash
docker compose -f docker-compose.yml -f docker-compose.signal.yml up -d
```

Bridge plus optional capability containers such as `pdf-api`:

```bash
docker compose -f docker-compose.yml -f docker-compose.capabilities.yml up -d
```

Bridge plus the coupled Signal companion and optional capabilities:

```bash
docker compose -f docker-compose.yml -f docker-compose.signal.yml -f docker-compose.capabilities.yml up -d
```

Note: some optional capability services in `docker-compose.capabilities.yml` may be commented out by default and must be explicitly uncommented before they are started.

### 4. What `docker compose up -d --build` rebuilds

This command rebuilds the **Compose-managed images and containers** in this repo, especially the bridge image and the helper images used for future sibling-container creates. If you also use `docker-compose.capabilities.yml`, the same rule applies to those capability containers: Compose owns their lifecycle, while the bridge later attaches them to workspace-specific internal networks as needed.

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
./bridge down
./bridge sig down
./bridge cap down
./bridge all down

# or use docker compose directly:
docker compose down
docker compose -f docker-compose.yml -f docker-compose.signal.yml down
docker compose -f docker-compose.yml -f docker-compose.capabilities.yml down
docker compose -f docker-compose.yml -f docker-compose.signal.yml -f docker-compose.capabilities.yml down
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

### Destructive admin workspace delete

For a fully destructive operator-only delete, run:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js delete <workspaceKey> --confirm <workspaceKey>
```

The `--confirm` value must exactly match the workspace key or the command refuses to run.
Unknown workspace keys fail clearly.

Successful delete means the bridge:

- removes the workspace record from `workspace.json` through the provisioner-owned registry path
- removes the durable inbox and outbox entries for that workspace
- tears down sibling runtime state it owns for that workspace, including sandbox / code-server cleanup and workspace capability network detachment
- removes bridge-owned code-server state for that workspace
- removes the workspace root under `PROJECTS_DIR/<workspacePath>`
- sends `SIGHUP` so the running bridge reloads control-plane state

This command is intentionally narrow:

- it is **not** a user-facing chat command
- it is **not** a soft remove, archive, or tombstone
- it does **not** ban a sender / group / room binding
- a future inbound from the same binding may provision a fresh workspace again according to the normal `BRIDGE_ACCESS_MODE` policy, with a new workspace key

### Temporary sandbox admin command

For one-off high-trust sandbox administration on a provisioned workspace, run:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js sandbox <workspaceKey> --cmd 'apt-get update && apt-get install -y poppler-utils'
```

Optional advanced flags stay on this CLI path only:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js sandbox <workspaceKey> \
  --cmd 'uv add pdfplumber' \
  --user 0 \
  --cwd /workspace \
  --network <docker-network-name> \
  --log /bridge-data/admin/sandbox-admin-history.jsonl \
  --bridge-container <bridge-container>
```

Behavior:

- validates that the workspace exists and has been provisioned
- temporarily attaches a usable Docker network when the sandbox does not already have it
- runs one `sh -lc` command inside the selected sandbox
- disconnects that temporary network attachment again when this run added it
- appends a replayable structured history entry to `BRIDGE_DATA_DIR/admin/sandbox-admin-history.jsonl`
- migrates legacy `sandbox-admin-history.shlog` entries into the new JSONL file once, then removes the old file

This command is intentionally high-trust and operator-only:

- it is **not** a user chat command
- it is **not** durable desired state
- package installs or other mutations done this way may disappear when the sandbox is later recreated

### Optional workspace capabilities

Capability reachability is also controlled through `workspace.json`.

Current capability keys:

```json
"capabilities": {
  "pdfApi": {
    "enabled": true
  },
  "spreadsheetRecalc": {
    "enabled": false
  },
  "geminiSearch": {
    "enabled": false
  }
}
```

Behavior:

- `capabilities.pdfApi.enabled`, `capabilities.spreadsheetRecalc.enabled`, and `capabilities.geminiSearch.enabled` are explicit per workspace
- `geminiSearch` reuses `GEMINI_API_KEY` or `GOOGLE_API_KEY` from the bridge deployment when that capability container is enabled
- the capability containers themselves are optional infrastructure started through `docker-compose.capabilities.yml`
- the bridge does **not** proxy capability requests; the sandbox calls the enabled service directly over an internal Docker network
- enabling a capability may require a fresh runner / sandbox to pick up the new network attachment (`!reset` for that workspace or `admin-workspace.js reconcile --reset-runners` for inactive workspaces)
- when a capability is exposed successfully, the bridge materializes its bundled `/capability/` directory into the workspace under `.bridge/capabilities/<capability>/`; `orient.py` can then discover the copied `SKILL.md` through normal scanning
- disabling a capability removes that bridge-managed workspace bundle

### Capability container contract (v0)

Each optional capability container is expected to be an explicitly pinned image and to
bundle one static directory at:

```text
/capability/
```

Required entrypoint inside that directory:

```text
/capability/SKILL.md
```

Optional siblings may include helper scripts, reference docs, and bundled assets.
For v0 there is **no separate manifest**. The bridge validates the bundled `SKILL.md`
at exposure time and refuses exposure for that capability if the entrypoint is missing
or invalid.

Required `SKILL.md` frontmatter keys:

```yaml
---
name: pdf-api
description: Short task-oriented description.
version: 0.1.0
---
```

Contract notes:

- only `name`, `description`, and `version` are required in v0
- the bridge does **not** auto-load the skill into prompt context through the SDK
- the workspace sees only the bridge-managed bundle under `.bridge/`; the running capability service remains separate
- the live API port is for the capability runtime, not for serving the skill file

Current capabilities:

- `pdfApi` → `http://pdf-api:8000`
- `spreadsheetRecalc` → `http://spreadsheet-recalc:2004/request`
- `geminiSearch` → `http://gemini-search:8000` via the bundled helper under `.bridge/capabilities/geminiSearch/gemini.py`

Important honesty note for `spreadsheetRecalc`:

- the operator-facing capability name is intentionally narrow because the current use case is workbook recalculation after write-back
- the underlying `unoserver-rest-api` backend is broader than recalculation alone
- in the current trusted-user posture, that restriction is therefore **soft**, not hard
- the `spreadsheet-recalc` service block is commented out by default in `docker-compose.capabilities.yml` and must be explicitly uncommented before use
- `geminiSearch` expects the optional capability image `ghcr.io/timomuc/gemini-sidecar:main`; once exposed, its `SKILL.md` currently identifies itself as `access-gemini`

Start the optional capability container stack with:

```bash
docker compose -f docker-compose.yml -f docker-compose.capabilities.yml up -d
```

Then apply edited workspace control-plane state with:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile --reset-runners
```

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

Optional deployment-level public URL override in `.env`:

```bash
CODE_SERVER_PUBLIC_URL_TEMPLATE=https://code-{workspaceKey}.example.com/
# or: https://dev.example.com:{port}/
```

Behavior:

- `codeServer.enabled` is explicit per workspace; generated fields stay bridge-owned
- new workspaces use `.env` provisioning defaults (`DEFAULT_NEW_WORKSPACE_CODE_SERVER_ENABLED`) only on first contact
- startup + explicit reconcile ensure the running code-server containers match `workspace.json`
- bridge shutdown stops running code-server sibling containers, but does not delete them
- normal inbound messages do **not** auto-spawn code-server
- `CODE_SERVER_PUBLIC_URL_TEMPLATE` affects `!status` only; it does not change container/network behavior

After editing `workspace.json`, apply desired state with:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile
```

Dry-run summary:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile --check
```

Access details are shown in the workspace-facing `!status` dashboard.

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

Access details are shown in the workspace-facing `!status` dashboard.

For external devices, publish the stable `CALENDAR_HTTP_PORT` through your
existing Cloudflare tunnel or another HTTPS reverse proxy, then subscribe to
the resulting URL as an **internet calendar** / **subscription calendar**.
Do not import it as a local copy.

---

## Session watch

The bridge can optionally expose a tiny web page that shows live
`session.subscribe()` events for a workspace: assistant text deltas, tool
starts/ends, and a few run-status messages such as compaction or retry.

Global bridge config lives in `.env`:

```bash
SESSION_WATCH_ENABLED=true
SESSION_WATCH_HOST=0.0.0.0
SESSION_WATCH_PORT=8791
SESSION_WATCH_PUBLIC_BASE_URL=https://watch.example.com
```

Per-workspace metadata lives in `workspace.json`:

```json
"sessionWatch": {
  "enabled": true,
  "token": "random-base64url"
}
```

Behavior:

- `sessionWatch.enabled` is explicit per workspace; the opaque `token` stays bridge-owned
- `SESSION_WATCH_ENABLED` controls the global HTTP publisher only; it does not override per-workspace desired state
- the bridge serves `GET /watch/:workspaceKey/:token` and `GET /watch/:workspaceKey/:token/events`
- `SESSION_WATCH_PUBLIC_BASE_URL` affects `!status` link rendering only; it does not change the listener bind/publish behavior
- **live only** — no session-history backfill on page load
- repo-owned copied/adapted styling inspired by pi's HTML export, with **no runtime dependency** on pi internal `export-html` files

After editing `workspace.json`, apply desired state with:

```bash
docker exec <bridge-container> node /app/dist/admin-workspace.js reconcile
```

Access details are shown in the workspace-facing `!status` dashboard.

Because the page may expose sensitive tool arguments/results and work in
progress, keep the published host port local or otherwise restrict access with
your reverse proxy / tunnel. If you want strict localhost-only exposure in
Docker, publish the port on `127.0.0.1` (for example via the Compose port
mapping) rather than binding the service to `127.0.0.1` inside the container.
If this surface is no longer needed, it should be easy to remove entirely.

---

## Operator admin UI

The bridge can optionally expose one small built-in operator UI for the
workspace control plane.

Global bridge config lives in `.env`:

```bash
ADMIN_UI_PUBLISH_HOST=127.0.0.1
ADMIN_UI_PORT=8792
ADMIN_UI_USER=operator
ADMIN_UI_PASSWORD=replace-with-a-long-random-password
```

Behavior:

- the UI starts only when both `ADMIN_UI_USER` and `ADMIN_UI_PASSWORD` are set
- HTTP Basic Auth is the only auth model in v1
- `workspace.json` remains canonical; the UI is an editor over the existing control plane, not a second source of truth
- the UI stays workspace-first: searchable workspace list on the left, one selected workspace on the right
- current operator actions are exposed in-browser: check, reconcile, reconcile + reset inactive runners, one narrow temporary sandbox admin action, and destructive delete
- in this repo's Docker Compose file, `ADMIN_UI_PUBLISH_HOST` controls the host-side publish address
- `ADMIN_UI_PUBLISH_HOST=127.0.0.1` keeps the UI localhost-only on the bridge host
- set `ADMIN_UI_PUBLISH_HOST=0.0.0.0` (or a specific LAN IP) when other machines on your network should reach the UI directly
- the in-container listener still binds normally for Docker reachability; changing the host-side publish address is the operator-facing access control knob
- the current v1 surface keeps `workspacePath` and `status` read-only after a workspace has already been provisioned, because the bridge does not currently implement workspace moves or active→pending lifecycle rewrites through the UI
- the temporary sandbox admin panel is explicitly imperative and separate from `workspace.json`; the page only keeps the last command output ephemerally in-browser while the bridge appends durable replayable history server-side

The UI is intentionally narrow and removable:
- one built-in HTTP server
- self-contained HTML/CSS/JS
- no database
- no cookies/session store
- no role model
- no public API promise beyond the built-in page itself

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

The current blueprint is deliberately lean: agent-owned notes live under `.agent/`, the shared writable surface is `cowork/`, inbound source material lands in read-only `upload/`, and scheduled event files live in `.events/`. Bridge-managed runtime artifacts live under `.bridge/`, including session history and any capability-bundled guidance materialized for that workspace under `.bridge/capabilities/`. New sessions may preload `.agent/orient.py` output through the per-workspace `boot.enabled` flag in `workspace.json`; new workspace records seed that flag from the `.env` default on first provisioning only. Scheduled workspace events resume the agent through synthetic `read(".events/<file>.json")` tool activity once the workspace already has a session file. Event files are discovered through a reconcile loop over `.events/`, not by trusting a single filesystem edge notification. Before first user activity, immediate and one-shot events are dropped when they fire; periodic files stay on disk and their scheduled occurrences are suppressed until session history exists. `wait()` is now the silent-turn tool. Richer pause semantics and compaction / session renewal remain separate follow-up work.

### Bridge-owned workspace git history

Each provisioned workspace is now a normal host-side git repo for SSH maintenance, but the real git directory lives under `.bridge/git/` and the workspace root only carries the standard `.git` pointer file. The bridge container owns git writes and keeps its operational exclude rules in `.bridge/git/info/exclude`; the sandbox image still does **not** ship git.

The bridge creates an initial snapshot when a workspace is provisioned or first healed on startup, then commits one new snapshot after every completed inbound or scheduled workspace run. Session JSONL files under `.bridge/sessions/` are included in that history, so a purely conversational turn still produces a commit when the session log changes.

Remote maintenance can use normal SSH git workflows against the workspace root; the live repo is configured with `receive.denyCurrentBranch=updateInstead` plus a bridge-seeded `push-to-checkout` hook that updates the separate-git-dir worktree/index without moving the branch ref itself. The current `!reset-workspace` command remains intentionally destructive and recreates fresh git history instead of preserving the old history.

### Sandboxing

Tool calls run inside a per-workspace Docker sibling container. Each workspace gets its own sandbox container keyed by the opaque workspace id. The sandbox workspace root is fixed at `/workspace`; `SANDBOX_CWD` is configured relative to that root, so `.` means `/workspace` and `./cowork` would mean `/workspace/cowork`. On the first sandbox-backed session creation after bridge startup, the bridge runs a tiny self-check (`pwd` under the configured sandbox cwd) and fails loudly if execution does not resolve inside the sandbox as expected.

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
./bridge
# or pick the stack you deployed with, for example:
./bridge sig
./bridge cap
./bridge all

# direct docker compose equivalents:
docker compose up --build -d
docker compose -f docker-compose.yml -f docker-compose.signal.yml up -d
docker compose -f docker-compose.yml -f docker-compose.capabilities.yml up -d
docker compose -f docker-compose.yml -f docker-compose.signal.yml -f docker-compose.capabilities.yml up -d
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
