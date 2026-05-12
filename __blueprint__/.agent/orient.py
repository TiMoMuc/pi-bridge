#!/usr/bin/env python3
"""Render a concise workspace orientation block.

Default usage is prompt-safe and concise:

  python /workspace/.agent/orient.py

Explicit runtime sections:

  python /workspace/.agent/orient.py --repo-tree
  python /workspace/.agent/orient.py --repo-tree 3 --skills
  python /workspace/.agent/orient.py --events
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

DEFAULT_REPO_TREE_DEPTH = 2
MAX_SECTION_LINES = 160
IGNORED_NAMES = {
    ".git",
    "node_modules",
    ".venv",
    "dist",
    "build",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
}


@dataclass
class SkillSummary:
    name: str
    description: str
    location: str


@dataclass
class EventSummary:
    name: str
    summary: str
    schedule: str | None = None
    timezone: str | None = None


@dataclass
class OrientationContext:
    repo_tree: str | None
    skills: list[SkillSummary]
    events: list[EventSummary]
    warnings: list[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render a concise workspace orientation block")
    parser.add_argument(
        "--repo-tree",
        nargs="?",
        const=DEFAULT_REPO_TREE_DEPTH,
        type=int,
        metavar="DEPTH",
        help="include a repo tree at optional depth (default: 2)",
    )
    parser.add_argument("--skills", action="store_true", help="include discovered skill summaries")
    parser.add_argument("--events", action="store_true", help="include scheduled event summaries")
    return parser.parse_args()


def workspace_root() -> Path:
    return Path(__file__).resolve().parent.parent


def clamp_section(text: str, max_lines: int = MAX_SECTION_LINES) -> str:
    lines = text.rstrip().splitlines()
    if len(lines) <= max_lines:
        return "\n".join(lines)
    omitted = len(lines) - max_lines
    return "\n".join(lines[:max_lines] + [f"... [{omitted} more line(s) omitted]"])


def render_repo_tree(root: Path, depth: int) -> tuple[str, list[str]]:
    warnings: list[str] = []
    if depth < 1:
        return "(repo tree depth must be >= 1)", warnings

    tree_bin = shutil.which("tree")
    if tree_bin:
        ignore_pattern = "|".join(sorted(IGNORED_NAMES))
        command = [
            tree_bin,
            "-a",
            "--noreport",
            "--charset=utf-8",
            "-I",
            ignore_pattern,
            "-L",
            str(depth),
            str(root),
        ]
        try:
            result = subprocess.run(command, capture_output=True, text=True, check=False)
            if result.returncode == 0 and result.stdout.strip():
                return clamp_section(result.stdout), warnings
            warnings.append("repo tree fell back to Python rendering because `tree` returned no usable output")
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            warnings.append(f"repo tree fell back to Python rendering because `tree` failed: {exc}")
    else:
        warnings.append("repo tree used Python fallback because `tree` is not installed")

    return render_repo_tree_fallback(root, depth), warnings


def render_repo_tree_fallback(root: Path, depth: int) -> str:
    lines: list[str] = [root.name or str(root)]

    def walk(node: Path, prefix: str, remaining_depth: int) -> None:
        if remaining_depth <= 0:
            return
        children = [
            child for child in sorted(node.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
            if child.name not in IGNORED_NAMES
        ]
        for index, child in enumerate(children):
            branch = "└── " if index == len(children) - 1 else "├── "
            lines.append(f"{prefix}{branch}{child.name}")
            if child.is_dir():
                extension = "    " if index == len(children) - 1 else "│   "
                walk(child, prefix + extension, remaining_depth - 1)

    walk(root, "", depth)
    return clamp_section("\n".join(lines))


def iter_skill_files(root: Path):
    for current_root, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted([name for name in dirnames if name not in IGNORED_NAMES])
        if "SKILL.md" in filenames:
            yield Path(current_root) / "SKILL.md"


def parse_skill(skill_file: Path) -> tuple[SkillSummary, str | None]:
    text = skill_file.read_text(encoding="utf-8")
    frontmatter: dict[str, Any] = {}
    body = text
    warning: str | None = None

    if text.startswith("---\n"):
        parts = text.split("\n---\n", 1)
        if len(parts) == 2:
            fm = parts[0][4:]
            body = parts[1]
            try:
                frontmatter = yaml.safe_load(fm) or {}
                if not isinstance(frontmatter, dict):
                    warning = f"{skill_file.relative_to(workspace_root())}: frontmatter is not a mapping"
                    frontmatter = {}
            except Exception as exc:  # pragma: no cover - defensive runtime fallback
                warning = f"{skill_file.relative_to(workspace_root())}: unreadable frontmatter ({exc})"
                frontmatter = {}
                body = text
        else:
            warning = f"{skill_file.relative_to(workspace_root())}: frontmatter is not properly closed"

    description = str(frontmatter.get("description") or "").strip()
    if not description:
        paragraphs = [line.strip() for line in body.splitlines() if line.strip()]
        description = paragraphs[0] if paragraphs else "No description provided."

    summary = SkillSummary(
        name=str(frontmatter.get("name") or skill_file.parent.name),
        description=description,
        location=str(skill_file.relative_to(workspace_root())),
    )
    return summary, warning


def load_skills(root: Path) -> tuple[list[SkillSummary], list[str]]:
    summaries: list[SkillSummary] = []
    warnings: list[str] = []
    for skill_file in sorted(iter_skill_files(root)):
        try:
            summary, warning = parse_skill(skill_file)
            summaries.append(summary)
            if warning:
                warnings.append(warning)
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            warnings.append(f"{skill_file.relative_to(root)}: unreadable skill file ({exc})")
    return summaries, warnings


def summarize_event(event_file: Path) -> EventSummary:
    payload = json.loads(event_file.read_text(encoding="utf-8"))
    text = str(payload.get("text") or "").strip().replace("\n", " ")
    summary = text[:140] + ("…" if len(text) > 140 else "") if text else "No text"
    return EventSummary(
        name=event_file.name,
        summary=summary,
        schedule=payload.get("schedule") or payload.get("at"),
        timezone=payload.get("timezone"),
    )


def load_events(root: Path) -> tuple[list[EventSummary], list[str]]:
    events_dir = root / ".events"
    if not events_dir.exists():
        return [], []

    events: list[EventSummary] = []
    warnings: list[str] = []
    for event_file in sorted(events_dir.glob("*.json")):
        try:
            events.append(summarize_event(event_file))
        except Exception as exc:  # pragma: no cover - defensive runtime fallback
            warnings.append(f".events/{event_file.name}: unreadable event file ({exc})")
    return events, warnings


def build_context(args: argparse.Namespace) -> OrientationContext:
    root = workspace_root()
    explicit = args.repo_tree is not None or args.skills or args.events
    include_repo_tree = args.repo_tree is not None or not explicit
    include_skills = args.skills or not explicit
    include_events = args.events

    warnings: list[str] = []

    repo_tree = None
    if include_repo_tree:
        depth = args.repo_tree if args.repo_tree is not None else DEFAULT_REPO_TREE_DEPTH
        repo_tree, repo_warnings = render_repo_tree(root, depth)
        warnings.extend(repo_warnings)

    skills: list[SkillSummary] = []
    if include_skills:
        skills, skill_warnings = load_skills(root)
        warnings.extend(skill_warnings)

    events: list[EventSummary] = []
    if include_events:
        events, event_warnings = load_events(root)
        warnings.extend(event_warnings)

    return OrientationContext(repo_tree=repo_tree, skills=skills, events=events, warnings=warnings)


def render(context: OrientationContext) -> str:
    parts = [
        "# Workspace Orientation",
        "",
        "_Generated by `/workspace/.agent/orient.py`._",
        "_Informational workspace context only. Constitution, interface protocol, and durable workspace notes take precedence._",
    ]

    if context.repo_tree:
        parts.extend([
            "",
            "## Repo Surface",
            "```text",
            context.repo_tree,
            "```",
        ])

    if context.skills:
        parts.extend(["", "## Available Skills"])
        for skill in context.skills:
            parts.extend([
                f"- **{skill.name}** — {skill.description}",
                f"  - Location: `{skill.location}`",
            ])
    elif context.repo_tree is not None:
        parts.extend(["", "## Available Skills", "(none found)"])

    if context.events:
        parts.extend(["", "## Scheduled Events"])
        for event in context.events:
            parts.append(f"- `{event.name}` — {event.summary}")
            if event.schedule:
                schedule = f"  - Schedule: `{event.schedule}`"
                if event.timezone:
                    schedule += f" ({event.timezone})"
                parts.append(schedule)

    if context.warnings:
        parts.extend(["", "## Orientation Warnings"])
        for warning in context.warnings:
            parts.append(f"- {warning}")

    parts.extend(["", "_End workspace orientation._"])
    return "\n".join(parts).strip() + "\n"


def main() -> int:
    args = parse_args()
    context = build_context(args)
    print(render(context), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
