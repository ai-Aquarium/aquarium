"""Per-profile activity stats for agent-home's Agent Profiles page.

Everything is read-only and tolerant: a store that is missing, locked or
from an older schema contributes nothing instead of failing the request, so
a fresh profile reads as "never used". No filesystem paths leave this module.

Sources:

* ``<profile home>/state.db`` ``sessions`` — tokens, cost, chats, channels used,
  last active.
* ``skill_ledger.db`` ``skill_events`` (one per home, ``profile`` column) —
  distinct skills used and the most used ones.
* ``projects.db`` ``project_runs`` (``profile`` column) — projects done/running.
* kanban ``tasks`` on every live board (``assignee`` = profile) — the task it
  is working on now, blocked tasks and pending approvals (needs you).
* ``<profile home>/gateway_state.json`` — connected messaging platforms.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from typing import Any, Iterable, Optional

logger = logging.getLogger(__name__)

DAY = 86400
SPARK_DAYS = 7
TOP_SKILLS = 3
_ACTIVE_RUN = ("running", "waiting")
_CONNECTED = ("connected", "running", "ok")


def _ro(db_path: Path) -> Optional[sqlite3.Connection]:
    if not db_path.is_file():
        return None
    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}


def empty_stats() -> dict:
    return {
        "tokens": 0,
        "cost_usd": 0.0,
        "tokens_by_day": [0] * SPARK_DAYS,
        "chats": 0,
        "messages": 0,
        "chat_sources": [],
        "last_active_at": None,
        "skills_used": 0,
        "top_skills": [],
        "projects_done": 0,
        "projects_running": 0,
        "tasks_running": 0,
        "current_task": None,
        "needs_you": 0,
        "channels": [],
    }


def _session_stats(home: Path, since: float, now: float, out: dict) -> None:
    conn = _ro(home / "state.db")
    if conn is None:
        return
    with closing(conn):
        cols = _columns(conn, "sessions")
        if not cols:
            return
        num = lambda c: f"COALESCE({c}, 0)" if c in cols else "0"  # noqa: E731
        tokens = " + ".join(
            num(c) for c in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")
        )
        cost = "COALESCE(actual_cost_usd, estimated_cost_usd, 0)" if {
            "actual_cost_usd", "estimated_cost_usd"
        } <= cols else "0"
        top_level = " AND parent_session_id IS NULL" if "parent_session_id" in cols else ""
        row = conn.execute(
            f"SELECT COALESCE(SUM({tokens}), 0) AS tokens, COALESCE(SUM({cost}), 0) AS cost, "
            f"COALESCE(SUM({num('message_count')}), 0) AS messages FROM sessions WHERE started_at >= ?",
            (since,),
        ).fetchone()
        out["tokens"] = int(row["tokens"])
        out["cost_usd"] = round(float(row["cost"]), 4)
        out["messages"] = int(row["messages"])
        out["chats"] = int(conn.execute(
            f"SELECT COUNT(*) FROM sessions WHERE started_at >= ?{top_level}", (since,)
        ).fetchone()[0])
        if "source" in cols:
            out["chat_sources"] = sorted(
                str(r[0]) for r in conn.execute(
                    "SELECT DISTINCT source FROM sessions WHERE started_at >= ? AND source IS NOT NULL",
                    (since,),
                )
            )
        spark_start = now - SPARK_DAYS * DAY
        # Oldest day first; the last bucket is the 24 h up to ``now``.
        for r in conn.execute(
            f"SELECT CAST((? - started_at) / {DAY} AS INTEGER) AS ago, SUM({tokens}) AS t "
            "FROM sessions WHERE started_at > ? GROUP BY ago",
            (now, spark_start),
        ):
            day = SPARK_DAYS - 1 - int(r["ago"])
            if 0 <= day < SPARK_DAYS:
                out["tokens_by_day"][day] = int(r["t"] or 0)
        last = "MAX(COALESCE(ended_at, started_at))" if "ended_at" in cols else "MAX(started_at)"
        out["last_active_at"] = conn.execute(f"SELECT {last} FROM sessions").fetchone()[0]


def _skill_usage(ledgers: Iterable[tuple[Path, str]], since: float) -> dict[str, dict[str, int]]:
    """``{profile: {skill: uses}}`` across ledgers; a row without a profile
    belongs to the home whose ledger holds it."""
    usage: dict[str, dict[str, int]] = {}
    for path, home_profile in ledgers:
        conn = _ro(path)
        if conn is None:
            continue
        try:
            with closing(conn):
                if "profile" not in _columns(conn, "skill_events"):
                    continue
                for r in conn.execute(
                    "SELECT COALESCE(NULLIF(profile, ''), ?) AS p, skill_name, COUNT(*) AS n "
                    "FROM skill_events WHERE ts >= ? GROUP BY p, skill_name",
                    (home_profile, since),
                ):
                    per = usage.setdefault(str(r["p"]), {})
                    per[r["skill_name"]] = per.get(r["skill_name"], 0) + int(r["n"])
        except sqlite3.Error:
            logger.debug("profile stats: skill ledger unreadable", exc_info=True)
    return usage


def _project_runs(since: float) -> dict[str, dict[str, set]]:
    from hermes_cli import projects_db

    out: dict[str, dict[str, set]] = {}
    try:
        conn = _ro(projects_db.projects_db_path())
    except Exception:
        conn = None
    if conn is None:
        return out
    try:
        with closing(conn):
            for r in conn.execute(
                "SELECT profile, project_id, status FROM project_runs "
                "WHERE status IN ('running', 'waiting') OR (status = 'done' AND COALESCE(ended_at, started_at) >= ?)",
                (int(since),),
            ):
                per = out.setdefault(str(r["profile"]), {"done": set(), "running": set(), "waiting": set()})
                key = "done" if r["status"] == "done" else r["status"]
                per[key].add(r["project_id"])
    except sqlite3.Error:
        logger.debug("profile stats: projects db unreadable", exc_info=True)
    return out


def _kanban(names: set[str]) -> dict[str, dict]:
    from hermes_cli import kanban_db

    out: dict[str, dict] = {}
    try:
        boards = [b.get("slug") or kanban_db.DEFAULT_BOARD for b in kanban_db.list_boards(include_archived=False)]
    except Exception:
        boards = [kanban_db.DEFAULT_BOARD]
    for board in boards:
        try:
            conn = _ro(kanban_db.kanban_db_path(board=board))
        except Exception:
            conn = None
        if conn is None:
            continue
        try:
            with closing(conn):
                for r in conn.execute(
                    "SELECT assignee, title, visibility, started_at FROM tasks "
                    "WHERE status = 'running' AND assignee IS NOT NULL ORDER BY started_at DESC"
                ):
                    if r["assignee"] not in names:
                        continue
                    per = out.setdefault(r["assignee"], {"running": [], "blocked": 0, "approvals": 0})
                    shared = (r["visibility"] or "shared") == "shared"
                    per["running"].append({
                        "kind": "task",
                        "title": r["title"] if shared else None,
                        "started_at": r["started_at"],
                    })
                for r in conn.execute(
                    "SELECT assignee, COUNT(*) AS n FROM tasks WHERE status = 'blocked' GROUP BY assignee"
                ):
                    if r["assignee"] in names:
                        out.setdefault(r["assignee"], {"running": [], "blocked": 0, "approvals": 0})["blocked"] += int(r["n"])
                tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if "task_approvals" in tables:
                    for r in conn.execute(
                        "SELECT t.assignee AS assignee, COUNT(*) AS n FROM task_approvals a "
                        "JOIN tasks t ON t.id = a.task_id WHERE a.status = 'pending' GROUP BY t.assignee"
                    ):
                        if r["assignee"] in names:
                            out.setdefault(r["assignee"], {"running": [], "blocked": 0, "approvals": 0})["approvals"] += int(r["n"])
        except sqlite3.Error:
            logger.debug("profile stats: board %s unreadable", board, exc_info=True)
    return out


def _channels(home: Path) -> list[str]:
    path = home / "gateway_state.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    platforms = data.get("platforms") if isinstance(data, dict) else None
    if not isinstance(platforms, dict):
        return []
    out = []
    for name, info in platforms.items():
        state = info.get("state") if isinstance(info, dict) else info
        if isinstance(state, str) and state.lower() in _CONNECTED:
            out.append(str(name))
    return sorted(out)


def collect(
    profiles: list[tuple[str, Path]],
    *,
    days: int = 30,
    live_chats: Iterable[dict] = (),
    now: Optional[float] = None,
) -> dict:
    """Stats for ``profiles`` (``(name, home)`` pairs) over the last ``days``.

    ``live_chats`` are in-flight agent-home turns (``profile`` + ``started_at``).
    """
    now = time.time() if now is None else now
    since = now - days * DAY
    names = {name for name, _ in profiles}
    stats: dict[str, dict] = {}
    for name, home in profiles:
        s = empty_stats()
        try:
            _session_stats(Path(home), since, now, s)
        except sqlite3.Error:
            logger.debug("profile stats: state.db for %s unreadable", name, exc_info=True)
        s["channels"] = _channels(Path(home))
        stats[name] = s

    ledgers = [(Path(home) / "skill_ledger.db", name) for name, home in profiles]
    for name, used in _skill_usage(ledgers, since).items():
        if name in stats:
            ranked = sorted(used.items(), key=lambda kv: (-kv[1], kv[0]))
            stats[name]["skills_used"] = len(ranked)
            stats[name]["top_skills"] = [{"name": k, "uses": v} for k, v in ranked[:TOP_SKILLS]]

    runs = _project_runs(since)
    kanban = _kanban(names)
    chats_now: dict[str, float] = {}
    for run in live_chats:
        prof = run.get("profile") or "default"
        chats_now[prof] = max(chats_now.get(prof, 0.0), float(run.get("started_at") or 0))

    for name, s in stats.items():
        pr = runs.get(name, {})
        s["projects_done"] = len(pr.get("done", ()))
        s["projects_running"] = len(pr.get("running", set()) | pr.get("waiting", set()))
        kb = kanban.get(name, {})
        s["tasks_running"] = len(kb.get("running", ()))
        s["needs_you"] = kb.get("blocked", 0) + kb.get("approvals", 0) + len(pr.get("waiting", ()))
        if kb.get("running"):
            task = kb["running"][0]
            s["current_task"] = {"kind": "task", "title": task["title"], "started_at": task["started_at"]}
        elif pr.get("running"):
            s["current_task"] = {"kind": "project", "title": None, "started_at": None}
        elif name in chats_now:
            s["current_task"] = {"kind": "chat", "title": None, "started_at": chats_now[name]}
        if s["current_task"] is not None:
            s["last_active_at"] = now

    totals = {
        "tokens": sum(s["tokens"] for s in stats.values()),
        "cost_usd": round(sum(s["cost_usd"] for s in stats.values()), 4),
        "projects_done": len(set().union(*(runs.get(n, {}).get("done", set()) for n in stats))) if stats else 0,
        "working": sum(1 for s in stats.values() if s["current_task"] is not None),
        "needs_you": sum(s["needs_you"] for s in stats.values()),
    }
    return {"days": days, "generated_at": now, "profiles": stats, "totals": totals}
