#!/usr/bin/env python3
"""parse-session.py — read pi session JSONL logs as a causal, binary-safe focus view.

Usage:
  python parse-session.py <path>
  python parse-session.py <path> --info
  python parse-session.py <path> --around 194 --window 2
  python parse-session.py <path> --from 180 --to 198
  python parse-session.py <path> --grep lacksystem --after 2
  python parse-session.py <path> --role assistant
  python parse-session.py <path> --full
  python parse-session.py <path> --raw
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

FLAGS_WITH_VALUES = {"--from", "--to", "--around", "--window", "--grep", "--role", "--after"}
DEFAULT_WINDOW = 2
DEFAULT_TEXT_LIMIT = 2000
DEFAULT_JSON_LIMIT = 400


class ParserOptions:
    def __init__(self, argv: list[str]) -> None:
        self.info = has_flag(argv, "--info")
        self.full = has_flag(argv, "--full")
        self.raw = has_flag(argv, "--raw")
        self.from_n = parse_int_option(argv, "--from")
        self.to_n = parse_int_option(argv, "--to")
        self.around = parse_int_option(argv, "--around")
        self.window = parse_int_option(argv, "--window", DEFAULT_WINDOW)
        self.grep = get_option(argv, "--grep")
        self.after = parse_int_option(argv, "--after", 0)
        self.role = get_option(argv, "--role")


opt: ParserOptions


def has_flag(argv: list[str], name: str) -> bool:
    return name in argv



def get_option(argv: list[str], name: str) -> str | None:
    try:
        index = argv.index(name)
    except ValueError:
        return None
    return argv[index + 1] if index + 1 < len(argv) else None



def parse_int_option(argv: list[str], name: str, default: int | None = None) -> int | None:
    value = get_option(argv, name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return float("nan")  # type: ignore[return-value]



def find_file_path(argv: list[str]) -> str | None:
    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("--"):
            if token in FLAGS_WITH_VALUES:
                i += 2
                continue
            i += 1
            continue
        return token
    return None



def usage() -> None:
    print("Usage: python parse-session.py <path.jsonl> [options]", file=sys.stderr)
    print("", file=sys.stderr)
    print("Options:", file=sys.stderr)
    print("  --info             Show session metadata only", file=sys.stderr)
    print("  --from <n>         Start at message entry number n (1-based)", file=sys.stderr)
    print("  --to <n>           End at message entry number n (inclusive)", file=sys.stderr)
    print("  --around <n>       Focus on entry n with a surrounding window", file=sys.stderr)
    print(f"  --window <n>       Context window for --around (default: {DEFAULT_WINDOW})", file=sys.stderr)
    print("  --grep <pattern>   Show only entries matching pattern (case-insensitive)", file=sys.stderr)
    print("  --after <n>        Show n additional matching entries after each grep hit", file=sys.stderr)
    print("  --role <role>      Filter by role: user | assistant | toolResult", file=sys.stderr)
    print("  --full             Disable text truncation", file=sys.stderr)
    print("  --raw              Disable payload folding / binary omission markers", file=sys.stderr)



def normalize_whitespace(text: Any) -> str:
    return str(text if text is not None else "").replace("\r\n", "\n").replace("\r", "\n")



def looks_like_data_uri(text: str) -> bool:
    return re.match(r"^data:[^;]+;base64,", text.strip(), re.IGNORECASE) is not None



def looks_like_base64_payload(text: str) -> bool:
    compact = re.sub(r"\s+", "", text)
    return len(compact) >= 256 and re.fullmatch(r"[A-Za-z0-9+/=]+", compact) is not None



def looks_binary_like(text: str) -> bool:
    if len(text) < 48:
        return False
    suspicious = 0
    sample = text[:2000]
    for ch in sample:
        code = ord(ch)
        if ch == "�" or code == 0 or (code < 32 and ch not in "\n\r\t"):
            suspicious += 1
    return suspicious / max(len(sample), 1) > 0.08



def describe_omission(kind: str, size: int, detail: str | None = None) -> str:
    suffix = f" | {detail}" if detail else ""
    return f"[... OMITTED: {kind} | {size} chars{suffix} ...]"



def fold_string(value: Any, *, limit: int = DEFAULT_TEXT_LIMIT) -> str:
    text = normalize_whitespace(value)

    if not opt.raw:
        if looks_like_data_uri(text):
            return describe_omission("data-uri payload", len(text))
        if looks_like_base64_payload(text):
            return describe_omission("base64-like payload", len(text))
        if looks_binary_like(text):
            return describe_omission("binary-like payload", len(text))

    if not opt.full and len(text) > limit:
        omitted = len(text) - limit
        return f"{text[:limit]}\n… [truncated {omitted} chars — use --full to see all]"

    return text



def sanitize_value(value: Any, depth: int = 0) -> Any:
    if depth > 4:
        return "[max-depth]"
    if isinstance(value, str):
        return fold_string(value, limit=DEFAULT_JSON_LIMIT)
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    if isinstance(value, list):
        return [sanitize_value(item, depth + 1) for item in value]
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, inner in value.items():
            if key in {"thinkingSignature", "textSignature"}:
                continue
            out[key] = sanitize_value(inner, depth + 1)
        return out
    return str(value)



def format_json(value: Any) -> str:
    return fold_string(json.dumps(sanitize_value(value), ensure_ascii=False, separators=(",", ":")), limit=DEFAULT_JSON_LIMIT)



def parse_thinking_summary(signature: Any) -> list[str]:
    if not isinstance(signature, str) or not signature.strip().startswith("{"):
        return []
    try:
        parsed = json.loads(signature)
    except json.JSONDecodeError:
        return []

    summary = parsed.get("summary")
    if not isinstance(summary, list):
        return []

    items: list[str] = []
    for item in summary:
        if isinstance(item, dict):
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                items.append(text.strip())
    return items



def collect_text_parts(content: Any) -> list[str]:
    if not isinstance(content, list):
        return [fold_string(content)]

    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            parts.append(fold_string(item.get("text", "")))
            continue
        parts.append(fold_string(json.dumps(sanitize_value(item), ensure_ascii=False, separators=(",", ":"))))
    return [part for part in parts if part]



def role_label(role: Any) -> str:
    labels = {"user": "USER", "assistant": "ASSIST", "toolResult": "TOOL"}
    if role in labels:
        return labels[role]
    return str(role if role is not None else "?").upper()



def prefixed_lines(n: int, role: Any, timestamp: Any, text: Any) -> list[str]:
    prefix = f"[{n}] {role_label(role).ljust(6)} @ {timestamp or '?'} "
    return [f"{prefix}{line}" for line in normalize_whitespace(text).split("\n") if line]



def render_assistant(entry_number: int, entry: dict[str, Any]) -> list[str]:
    timestamp = entry.get("timestamp") or (entry.get("message") or {}).get("timestamp") or "?"
    content = (entry.get("message") or {}).get("content")
    if not isinstance(content, list):
        content = []

    lines: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue

        part_type = part.get("type")
        if part_type == "thinking":
            thinking = fold_string(part.get("thinking", ""))
            summaries = parse_thinking_summary(part.get("thinkingSignature"))
            if thinking.strip():
                lines.extend(prefixed_lines(entry_number, "assistant", timestamp, f"(Thinking) {thinking}"))
            elif summaries:
                summary_text = "\n\n".join(summaries)
                lines.extend(prefixed_lines(entry_number, "assistant", timestamp, f"(ThinkingSummary) {summary_text}"))
            continue

        if part_type == "toolCall":
            lines.extend(prefixed_lines(entry_number, "assistant", timestamp, f"(ToolCall: {part.get('name') or '?'}) args: {format_json(part.get('arguments') or {})}"))
            continue

        if part_type == "text":
            lines.extend(prefixed_lines(entry_number, "assistant", timestamp, f"(Answer) {fold_string(part.get('text', ''))}"))
            continue

        if part_type == "toolResult":
            text = "\n\n".join(collect_text_parts(part.get("content")))
            status = " ERROR" if part.get("isError") else ""
            lines.extend(prefixed_lines(entry_number, "assistant", timestamp, f"(InlineToolResult: {part.get('toolName') or '?'}{status}) {text}"))
            continue

        lines.extend(prefixed_lines(entry_number, "assistant", timestamp, f"(Part:{part_type or 'unknown'}) {fold_string(json.dumps(sanitize_value(part), ensure_ascii=False, separators=(',', ':')))}"))

    return lines



def render_user(entry_number: int, entry: dict[str, Any]) -> list[str]:
    timestamp = entry.get("timestamp") or (entry.get("message") or {}).get("timestamp") or "?"
    content = (entry.get("message") or {}).get("content")
    if not isinstance(content, list):
        content = []

    lines: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "text":
            lines.extend(prefixed_lines(entry_number, "user", timestamp, fold_string(part.get("text", ""))))
            continue
        lines.extend(prefixed_lines(entry_number, "user", timestamp, f"(Part:{part_type or 'unknown'}) {fold_string(json.dumps(sanitize_value(part), ensure_ascii=False, separators=(',', ':')))}"))
    return lines



def render_tool_result(entry_number: int, entry: dict[str, Any]) -> list[str]:
    timestamp = entry.get("timestamp") or (entry.get("message") or {}).get("timestamp") or "?"
    message = entry.get("message") or {}
    tool_name = message.get("toolName") or "?"
    content = collect_text_parts(message.get("content"))
    status = " ERROR" if message.get("isError") else ""
    content_text = "\n\n".join(content)
    return prefixed_lines(entry_number, "toolResult", timestamp, f"(ToolResult: {tool_name}{status}) {content_text}")



def render_entry(item: dict[str, Any]) -> list[str]:
    n = item.get("n")
    entry = item.get("entry") or {}
    if entry.get("type") != "message" or n is None:
        return []

    role = ((entry.get("message") or {}).get("role"))
    if role == "assistant":
        return render_assistant(n, entry)
    if role == "user":
        return render_user(n, entry)
    if role == "toolResult":
        return render_tool_result(n, entry)

    message = entry.get("message") or {}
    rendered = fold_string(json.dumps(sanitize_value(message.get("content", "")), ensure_ascii=False, separators=(",", ":")))
    return prefixed_lines(n, role or "?", entry.get("timestamp") or message.get("timestamp") or "?", rendered)



def matches_entry(item: dict[str, Any], pattern: re.Pattern[str]) -> bool:
    rendered = "\n".join(render_entry(item))
    raw = item.get("raw") or ""
    return bool(pattern.search(raw) or pattern.search(rendered))



def load_entries(file_path: Path) -> list[dict[str, Any]]:
    parsed_lines: list[dict[str, Any]] = []
    with file_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            raw = line.rstrip("\n")
            if not raw.strip():
                continue
            try:
                parsed_lines.append({"entry": json.loads(raw), "raw": raw})
            except json.JSONDecodeError:
                continue
    return parsed_lines



def main() -> int:
    global opt

    argv = sys.argv[1:]
    file_path = find_file_path(argv)
    if not file_path:
        usage()
        return 1

    opt = ParserOptions(argv)
    invalid_numbers = [opt.from_n, opt.to_n, opt.around, opt.window, opt.after]
    if any(isinstance(value, float) and value != value for value in invalid_numbers):
        usage()
        return 1

    if opt.around is not None and opt.from_n is None and opt.to_n is None:
        opt.from_n = max(1, opt.around - opt.window)
        opt.to_n = opt.around + opt.window

    try:
        parsed_lines = load_entries(Path(file_path))
    except OSError as error:
        print(f"Cannot read file: {error}", file=sys.stderr)
        return 1

    entries = [item["entry"] for item in parsed_lines]

    if opt.info:
        session = next((entry for entry in entries if entry.get("type") == "session"), None)
        model = next((entry for entry in reversed(entries) if entry.get("type") == "model_change"), None)
        messages = [entry for entry in entries if entry.get("type") == "message"]
        users = [entry for entry in messages if (entry.get("message") or {}).get("role") == "user"]
        assistants = [entry for entry in messages if (entry.get("message") or {}).get("role") == "assistant"]
        tool_results = [entry for entry in messages if (entry.get("message") or {}).get("role") == "toolResult"]

        print("Session:", (session or {}).get("id") or "?")
        print("Date:   ", (session or {}).get("timestamp") or "?")
        print("CWD:    ", (session or {}).get("cwd") or "?")
        print("Model:  ", (model or {}).get("modelId") or "?", f"({(model or {}).get('provider') or '?'})")
        print("")
        print(f"Entries: {len(entries)} total")
        print(f"Messages: {len(messages)} (user={len(users)}, assistant={len(assistants)}, toolResult={len(tool_results)})")
        return 0

    indexed: list[dict[str, Any]] = []
    message_index = 0
    for item in parsed_lines:
        entry = item["entry"]
        if entry.get("type") == "message":
            message_index += 1
            indexed.append({"n": message_index, "entry": entry, "raw": item["raw"]})
        else:
            indexed.append({"n": None, "entry": entry, "raw": item["raw"]})

    visible = [item for item in indexed if item.get("n") is not None]

    if opt.from_n is not None:
        visible = [item for item in visible if item["n"] >= opt.from_n]
    if opt.to_n is not None:
        visible = [item for item in visible if item["n"] <= opt.to_n]
    if opt.role:
        visible = [item for item in visible if ((item.get("entry") or {}).get("message") or {}).get("role") == opt.role]

    if opt.grep:
        pattern = re.compile(opt.grep, re.IGNORECASE)
        match_ns = {item["n"] for item in visible if matches_entry(item, pattern)}

        if opt.after > 0:
            ordered_ns = [item["n"] for item in visible]
            for matched in list(match_ns):
                pos = ordered_ns.index(matched)
                for offset in range(1, opt.after + 1):
                    if pos + offset < len(ordered_ns):
                        match_ns.add(ordered_ns[pos + offset])

        visible = [item for item in visible if item["n"] in match_ns]

    if not visible:
        print("(no matching entries)")
        return 0

    for item in visible:
        lines = render_entry(item)
        if not lines:
            continue
        print("\n".join(lines))
        print("")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
