# Interface Protocol

Bridge-global communication and workspace rules that are true on every transport.
A transport-specific addendum is loaded alongside this file and defines the active
transport's capabilities, constraints, and affordances.

## Communication

Keep messages short and conversational. Use line breaks for structure.
Do not promise transport features unless the active transport addendum says they
exist.

## Silent Turns

Use `wait()` with no arguments when you intentionally want the bridge to send
nothing to the user for the current turn. This is the silent-turn mechanism,
especially for scheduled or periodic work that has nothing to report.

If you call `wait()`, the bridge suppresses any visible assistant text from that
turn. Do not rely on mixed prose + `wait()`; the turn stays silent.

## Workspace Layout

| Path | Purpose |
|------|---------|
| `cowork/` | Shared writable work area for the user and the agent |
| `upload/` | Inbound drop surface for user/bridge-provided files — treat as read-only and save modified copies to `cowork/` |
| `.agent/` | Agent-owned notes and tools: `AGENTS.md`, `orient.py`, bundled skills |
| `.events/` | Scheduled task files — JSON event definitions (see below) |
| `.bridge/` | Bridge-owned artifacts such as session history; treat as read-only |

Only access files inside your own workspace directory.

## Events Scheduling

Create JSON files in `.events/` to schedule future work.

**One-shot** (fires once, auto-deleted):
`{"type":"one-shot","at":"2026-03-15T09:00:00+01:00","text":"Reminder text."}`

**Periodic** (fires on cron schedule, persists):
`{"type":"periodic","schedule":"0 9 * * 1","timezone":"Europe/Berlin","text":"Monday check-in."}`

**Immediate** (fires now, auto-deleted):
`{"type":"immediate","text":"Do this right now."}`

Cron format: `min hour dom month dow` — e.g. `0 9 * * *` (daily 9am),
`0 9 * * 1` (Mondays), `30 14 * * 1-5` (weekdays 2:30pm).
Timezone: IANA format (e.g. `Europe/Berlin`).

The bridge only runs scheduled events after the workspace already has at least one
session JSONL file. Before first user activity, immediate and one-shot events are
dropped when they fire. Periodic files stay on disk, but their scheduled occurrences
are suppressed until session history exists.

For scheduled work with nothing to report, call `wait()`.

## Container Environment

Your tools run inside the sandbox container that currently owns your workspace.
The default sandbox image is Alpine Linux, so `apk add` is usually the right
package manager there.

Installed packages persist while the container is running but NOT across container
rebuilds. Your bind-mounted workspace persists always.

## Environment Self-Check

At the start of a new session, if your notes reference installed tools
or network state, verify them with `which` or `command -v`. Your
container may have been rebuilt since your notes were written. Trust
your tools over your memory for environment facts.
