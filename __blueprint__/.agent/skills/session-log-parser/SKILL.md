---
name: session-log-parser
description: "Read, search, and focus-inspect pi agent session JSONL logs. Given only a path to a .jsonl session file, retrieve readable user/assistant/tool chronology without manual JSON parsing or binary-noise cleanup."
---

Parse and inspect **pi agent session logs** (`.jsonl` files in `.bridge/sessions/`) as a
**causal focus view**: readable role labels, timestamps, assistant thinking/tool
calls/answers split apart, and noisy payloads folded away by default.

Session files live at:
```
/workspace/.bridge/sessions/<timestamp>_<uuid>.jsonl
```
Each line is a JSON event. This skill handles the format so agents never need to
manually parse or grep raw JSON or fight giant binary-like blobs in the output.

## When to use

- Reconstructing **why** the agent answered a certain way
- Inspecting a small causal neighborhood around a suspect turn (`--around`)
- Reviewing assistant thinking, tool calls, tool results, and final answer as one readable flow
- Finding where a specific topic, file path, or tool interaction appears (`--grep`)
- Pointing a human reviewer to specific entries by number

## Quick usage

Run from **this skill folder** (or provide full path to the script):

```bash
# Session overview (model, date, cwd, message counts)
python parse-session.py <path-to-session.jsonl> --info

# Focus on one turn and the surrounding neighborhood
python parse-session.py <path-to-session.jsonl> --around 194 --window 2

# Specific entry range
python parse-session.py <path-to-session.jsonl> --from 180 --to 198

# Find entries containing a word; show 2 following entries after each hit
python parse-session.py <path-to-session.jsonl> --grep Wörwag --after 2

# Only assistant turns
python parse-session.py <path-to-session.jsonl> --role assistant

# Disable text truncation
python parse-session.py <path-to-session.jsonl> --around 194 --window 1 --full

# Disable payload folding entirely (escape hatch)
python parse-session.py <path-to-session.jsonl> --around 194 --window 1 --raw
```

## All options

| Flag | Description |
|---|---|
| `--info` | Session metadata only: model, date, cwd, message counts |
| `--from <n>` | Start at message entry number `n` (1-based) |
| `--to <n>` | End at message entry number `n` (inclusive) |
| `--around <n>` | Focus on message entry `n` |
| `--window <n>` | Show `n` entries before and after `--around` (default: `2`) |
| `--grep <pattern>` | Show only entries matching pattern (case-insensitive; raw JSON + rendered output searched) |
| `--after <n>` | Show `n` additional entries after each `--grep` hit |
| `--role <role>` | Filter by role: `user` \| `assistant` \| `toolResult` |
| `--full` | Disable content truncation |
| `--raw` | Disable payload folding / omission markers |

## Output shape

Instead of dumping one opaque block per message, the parser expands a turn into
readable focus lines such as:

```text
[193] ASSIST @ 2026-05-05T07:34:52.074Z (Thinking) ...
[193] ASSIST @ 2026-05-05T07:34:52.074Z (ToolCall: read) args: {"path":".../2.png"}
[194] TOOL   @ 2026-05-05T07:34:52.300Z (ToolResult: read) [... OMITTED: data-uri payload | ...]
[195] ASSIST @ 2026-05-05T07:35:10.016Z (Answer) ...
```

This is intentionally terminal-first and grep-friendly.

## Folding behavior

By default the parser protects attention by folding away noisy payloads such as:
- `data:image/...;base64,...`
- long base64-like strings
- binary-like text with many replacement/control characters
- very long text outputs (truncated unless `--full`)

Use `--raw` only when you explicitly need the original payload text.

## Note on image inputs

**Caution:** If the parser folds a large binary payload after an image `read()`, it does **not** mean the model received unusable text. The tool passes actual typed vision objects to the API. To verify if the image was successfully passed, inspect the raw JSON (`--raw`) of the tool result to confirm a separate `type: "image"` payload is present alongside the text hint.

## File format reference

Each JSONL line is one of:

| `type` | Meaning |
|---|---|
| `session` | Session header: id, timestamp, cwd |
| `model_change` | Model/provider swap |
| `thinking_level_change` | Thinking mode change |
| `message` | Actual conversation turn — has `.message.role` and `.message.content[]` |

Common content parts inside a `message`:

| `content[].type` | Meaning |
|---|---|
| `text` | Regular user text or final assistant answer |
| `thinking` | Assistant reasoning payload (or reasoning summary if present) |
| `toolCall` | Tool invocation by assistant: `name`, `arguments` |
| `toolResult` | Inline tool response payload (rare; standalone tool results usually arrive as role `toolResult`) |

**Entry numbers** (`[N]` in output) count only `message` entries, not metadata events — so `--from`, `--to`, and `--around` refer to message sequence, matching what you see in the output.

## Tips

- Use `--around` first for causal review. It is usually better than reading the whole session.
- `--grep` is best for locating a file path, keyword, or tool name before switching to `--around`.
- If the assistant answer looks odd, inspect the nearest prior assistant turn and tool-result turn together.
- The parser is intentionally **reductive**: it extracts, folds, and reformats existing data. It does not infer causes or summarize sessions for you.
