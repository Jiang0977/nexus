#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

FALLBACK_EXIT_CODE = 2
CANCEL_EXIT_CODE = 130
MAX_RESULTS = 25


@dataclass
class ResumeRow:
    thread_id: str
    title: str
    cwd: str
    model_provider: str
    source: str
    updated_at_ms: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--include-non-interactive", action="store_true")
    return parser.parse_args()


def stderr(message: str = "") -> None:
    sys.stderr.write(f"{message}\n")


def normalize_path(value: str) -> str:
    if not value:
        return ""
    return os.path.normcase(os.path.realpath(os.path.normpath(value)))


def resolve_source_codex_home(runtime_home: Path) -> Path | None:
    explicit = os.environ.get("NEXUS_CODEX_SOURCE_HOME", "").strip()
    if explicit:
        candidate = Path(explicit)
        if candidate.exists():
            return candidate

    runtime_codex = runtime_home / ".codex"
    for name in ("session_index.jsonl", "sessions"):
        candidate = runtime_codex / name
        if candidate.exists():
            resolved = candidate.resolve()
            if name == "sessions":
                return resolved.parent
            return resolved.parent

    if runtime_codex.exists():
        return runtime_codex
    return None


def extract_toml_string(text: str, key: str) -> str:
    prefix = f"{key} ="
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line.startswith(prefix):
            continue
        _, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'").strip()
        if value:
            return value
    return ""


def detect_current_provider(runtime_home: Path) -> str:
    config_path = runtime_home / ".codex" / "config.toml"
    if not config_path.exists():
        return "openai"

    try:
        config_text = config_path.read_text(encoding="utf-8")
    except OSError:
        return "openai"

    provider = extract_toml_string(config_text, "model_provider")
    if provider:
        return provider
    if extract_toml_string(config_text, "base_url"):
        return "custom"
    return "openai"


def latest_state_db(codex_home: Path) -> Path | None:
    latest_path: Path | None = None
    latest_version = -1

    for candidate in codex_home.glob("state_*.sqlite"):
        stem = candidate.stem
        if not stem.startswith("state_"):
            continue
        try:
            version = int(stem.split("_", 1)[1])
        except ValueError:
            continue
        if version > latest_version:
            latest_version = version
            latest_path = candidate

    return latest_path


def load_state_resume_rows(
    state_db_path: Path,
    current_cwd: str,
    show_all: bool,
    include_non_interactive: bool,
) -> list[ResumeRow]:
    connection = sqlite3.connect(f"file:{state_db_path}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row

    try:
        columns = {
            str(row["name"])
            for row in connection.execute("PRAGMA table_info(threads)")
        }
        required = {"id", "title", "cwd", "source", "model_provider", "archived", "updated_at"}
        if not required.issubset(columns):
            return []

        updated_sort = "COALESCE(updated_at_ms, updated_at * 1000)" if "updated_at_ms" in columns else "updated_at * 1000"
        title_expr = "COALESCE(NULLIF(title, ''), id)"
        if "first_user_message" in columns:
            title_expr = "COALESCE(NULLIF(title, ''), NULLIF(first_user_message, ''), id)"

        query = [
            "SELECT id,",
            f"       {title_expr} AS title,",
            "       cwd,",
            "       model_provider,",
            f"       {updated_sort} AS updated_sort,",
            "       source",
            "  FROM threads",
            " WHERE archived = 0",
        ]
        if not include_non_interactive:
            query.append("   AND source IN ('cli', 'vscode')")
        query.append(" ORDER BY updated_sort DESC, id DESC")
        query.append(" LIMIT 200")

        rows: list[ResumeRow] = []
        for row in connection.execute("\n".join(query)):
            cwd = str(row["cwd"] or "").strip()
            if not show_all and normalize_path(cwd) != current_cwd:
                continue

            title = str(row["title"] or "").strip() or str(row["id"])
            rows.append(
                ResumeRow(
                    thread_id=str(row["id"]),
                    title=title,
                    cwd=cwd,
                    model_provider=str(row["model_provider"] or "").strip() or "unknown",
                    source=str(row["source"] or "").strip() or "unknown",
                    updated_at_ms=int(row["updated_sort"] or 0),
                )
            )
            if len(rows) >= MAX_RESULTS:
                break

        return rows
    finally:
        connection.close()


def parse_timestamp_ms(value: object) -> int:
    if value is None:
        return 0
    text = str(value).strip()
    if not text:
        return 0
    normalized = text
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except ValueError:
        return 0


def load_session_index_titles(session_index_path: Path) -> dict[str, tuple[str, int]]:
    if not session_index_path.exists():
        return {}

    entries: dict[str, tuple[str, int]] = {}
    try:
        with session_index_path.open("r", encoding="utf-8", errors="replace") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue
                thread_id = str(payload.get("id") or "").strip()
                if not thread_id:
                    continue
                title = str(payload.get("thread_name") or "").strip() or thread_id
                updated_at_ms = parse_timestamp_ms(payload.get("updated_at"))
                entries[thread_id] = (title, updated_at_ms)
    except OSError:
        return {}

    return entries


def load_rollout_resume_rows(
    codex_home: Path,
    current_cwd: str,
    show_all: bool,
    include_non_interactive: bool,
    known_thread_ids: set[str],
) -> list[ResumeRow]:
    sessions_dir = codex_home / "sessions"
    if not sessions_dir.exists():
        return []

    session_index_titles = load_session_index_titles(codex_home / "session_index.jsonl")
    rows: list[ResumeRow] = []
    interactive_sources = {"cli", "vscode"}

    for candidate in sessions_dir.rglob("*.jsonl"):
        try:
            with candidate.open("r", encoding="utf-8", errors="replace") as handle:
                first_line = handle.readline().strip()
        except OSError:
            continue
        if not first_line:
            continue
        try:
            envelope = json.loads(first_line)
        except json.JSONDecodeError:
            continue
        if envelope.get("type") != "session_meta":
            continue

        payload = envelope.get("payload")
        if not isinstance(payload, dict):
            continue

        thread_id = str(payload.get("id") or "").strip()
        if not thread_id or thread_id in known_thread_ids:
            continue

        cwd = str(payload.get("cwd") or "").strip()
        if not show_all and normalize_path(cwd) != current_cwd:
            continue

        source = str(payload.get("source") or "").strip() or "unknown"
        if not include_non_interactive and source not in interactive_sources:
            continue

        fallback_title = str(payload.get("title") or "").strip() or thread_id
        indexed_title, indexed_updated_at_ms = session_index_titles.get(thread_id, ("", 0))
        updated_at_ms = indexed_updated_at_ms or parse_timestamp_ms(payload.get("timestamp"))
        rows.append(
            ResumeRow(
                thread_id=thread_id,
                title=indexed_title or fallback_title,
                cwd=cwd,
                model_provider=str(payload.get("model_provider") or "").strip() or "unknown",
                source=source,
                updated_at_ms=updated_at_ms,
            )
        )

    return rows


def finalize_rows(rows: list[ResumeRow]) -> list[ResumeRow]:
    deduped: dict[str, ResumeRow] = {}
    for row in rows:
        existing = deduped.get(row.thread_id)
        if existing is None or row.updated_at_ms >= existing.updated_at_ms:
            deduped[row.thread_id] = row

    ordered = sorted(
        deduped.values(),
        key=lambda row: (row.updated_at_ms, row.thread_id),
        reverse=True,
    )
    return ordered[:MAX_RESULTS]


def render_timestamp(timestamp_ms: int) -> str:
    if timestamp_ms <= 0:
        return "unknown time"
    dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc)
    return dt.astimezone().strftime("%Y-%m-%d %H:%M")


def prompt_for_selection(rows: list[ResumeRow], current_provider: str, show_all: bool) -> str | None:
    stderr("")
    stderr("Nexus Synced Codex Sessions")
    stderr(f"Current provider: {current_provider}")
    stderr("Provider scope  : all synced providers")
    stderr(f"Scope           : {'all working directories' if show_all else os.getcwd()}")
    stderr("")

    for index, row in enumerate(rows, start=1):
        title = row.title.replace("\n", " ").strip()
        if len(title) > 72:
            title = f"{title[:69]}..."
        provider_label = row.model_provider
        if row.model_provider == current_provider:
            provider_label = f"{provider_label} (current)"
        stderr(f"{index:>2}) {title}")
        stderr(f"    {row.cwd or 'unknown cwd'}")
        stderr(f"    provider {provider_label} · updated {render_timestamp(row.updated_at_ms)}")

    stderr("")
    stderr("Select a session number. Press Enter or q to cancel.")

    while True:
        try:
            sys.stderr.write("> ")
            sys.stderr.flush()
            response = sys.stdin.readline()
        except EOFError:
            return None
        if response == "":
            return None
        response = response.strip()
        if response == "" or response.lower() == "q":
            return None
        if response.isdigit():
            selection = int(response)
            if 1 <= selection <= len(rows):
                return rows[selection - 1].thread_id
        stderr(f"Invalid selection: {response}")


def main() -> int:
    args = parse_args()
    runtime_home = Path(os.environ.get("HOME", "")).expanduser()
    if not runtime_home:
        return FALLBACK_EXIT_CODE

    source_codex_home = resolve_source_codex_home(runtime_home)
    if source_codex_home is None:
        return FALLBACK_EXIT_CODE

    provider = detect_current_provider(runtime_home)
    current_cwd = normalize_path(os.getcwd())
    rows: list[ResumeRow] = []

    state_db_path = latest_state_db(source_codex_home)
    if state_db_path is not None and state_db_path.exists():
        rows.extend(
            load_state_resume_rows(
                state_db_path,
                current_cwd,
                args.all,
                args.include_non_interactive,
            )
        )

    rows.extend(
        load_rollout_resume_rows(
            source_codex_home,
            current_cwd,
            args.all,
            args.include_non_interactive,
            {row.thread_id for row in rows},
        )
    )
    rows = finalize_rows(rows)
    if not rows:
        return FALLBACK_EXIT_CODE

    selected = prompt_for_selection(rows, provider, args.all)
    if not selected:
        return CANCEL_EXIT_CODE

    sys.stdout.write(f"{selected}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
