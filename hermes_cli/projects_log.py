"""The project Log (Stage 6): who did what on a project, people and agents.

Derived at read time from the records the project already keeps — runs,
playbook revisions, outputs, directives, links, members, profiles, card
approvals and re-plan events, and the tool calls each run's sessions made
— plus ``project_activity`` for the edits nothing else records (brief,
tools, settings, removals, and the human judgements whose actor would
otherwise be lost).

Each row is ``{id, actor: person|agent, who, kind, action, detail, at,
link}``; the client renders ``action`` + ``detail`` in the reader's
language. Rows come newest first, ``(at, id)`` descending, paged by an
opaque ``"<at>:<id>"`` cursor.

Tool calls are read lazily: only the runs whose time span overlaps the
page being returned open their profiles' ``state.db``, and only tool
*names* leave it — never arguments or results (they can carry file
contents and credentials), the same rule as the live run activity feed.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from hermes_cli import kanban_db, projects_db
from hermes_cli.profiles import normalize_profile_name, resolve_profile_env

logger = logging.getLogger(__name__)

ACTOR_FILTERS = ("all", "people", "agents")
KINDS = ("playbook", "runs", "tools", "outputs", "inputs", "settings")
DEFAULT_LIMIT = 50
MAX_LIMIT = 200

_KANBAN_ACTIONS = {
    "approval_approved": ("runs", "person"),
    "approval_denied": ("runs", "person"),
    "approval_reopened": ("runs", "person"),
    "replan_requested": ("playbook", "agent"),
    "replan_proposed": ("playbook", "agent"),
    "replan_activated": ("playbook", "agent"),
    "replan_held": ("playbook", "agent"),
    "replan_failed": ("playbook", "agent"),
}

_ACTIVITY_KINDS = {
    "brief_edited": "inputs",
    "link_removed": "inputs",
    "tools_edited": "tools",
    "playbook_activated": "playbook",
    "playbook_discarded": "playbook",
    "run_continued": "runs",
    "run_stopped": "runs",
    "run_cancelled": "runs",
    "run_retro": "runs",
    "output_delivered": "outputs",
}

_TEXT_CAP = 160


def parse_cursor(raw: Optional[str]) -> Optional[tuple[int, str]]:
    """``"<at>:<id>"`` → ``(at, id)``; ``ValueError`` when malformed."""
    if raw is None or raw == "":
        return None
    at, sep, rid = str(raw).partition(":")
    if not sep or not rid or not at.isdigit():
        raise ValueError("cursor must look like '<at>:<id>'")
    return int(at), rid


def _cap(text: Any) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= _TEXT_CAP else s[: _TEXT_CAP - 1] + "…"


def _row(rid, actor, who, kind, action, at, detail=None, link=None) -> dict:
    return {
        "id": rid, "actor": actor, "who": who, "kind": kind,
        "action": action, "detail": detail or {}, "at": int(at or 0),
        "link": link,
    }


def _run_link(run_no) -> Optional[dict]:
    return {"type": "run", "run_no": int(run_no)} if run_no else None


def _card_link(task_id) -> Optional[dict]:
    return {"type": "card", "id": str(task_id)} if task_id else None


# ---------------------------------------------------------------------------
# Derived rows
# ---------------------------------------------------------------------------


def _project_rows(conn: sqlite3.Connection, project) -> list[dict]:
    pid = project.id
    rows: list[dict] = []
    created = conn.execute(
        "SELECT created_at FROM projects WHERE id = ?", (pid,)
    ).fetchone()
    if created is not None:
        rows.append(_row(
            "project", "person", project.owner_user_id, "settings",
            "project_created", created["created_at"],
        ))

    activity = projects_db.list_project_activity(conn, pid)

    def logged(action: str, key: str) -> set:
        return {a["detail"].get(key) for a in activity if a["action"] == action}

    # A derived row the person's own activity row already covers is skipped,
    # so the Log credits who did it rather than where the work lives.
    activated_logged = logged("playbook_activated", "rev")
    retro_logged = logged("run_retro", "run_no")
    delivery_logged = logged("output_delivered", "delivery_id")
    deliveries = {
        d["id"]: d for d in conn.execute(
            "SELECT d.id, d.run_id, d.task_id, d.label, d.profile, "
            "d.delivered_at, o.title FROM project_output_deliveries d "
            "JOIN project_outputs o ON o.id = d.output_id "
            "WHERE o.project_id = ?", (pid,),
        ).fetchall()
    }
    run_nos = {
        row["id"]: row["run_no"] for row in conn.execute(
            "SELECT id, run_no FROM project_runs WHERE project_id = ?", (pid,)
        ).fetchall()
    }
    for a in activity:
        d = a["detail"]
        link = _run_link(d.get("run_no"))
        if a["action"] == "output_delivered":
            dlv = deliveries.get(d.get("delivery_id"))
            if dlv is not None:
                run_no = run_nos.get(dlv["run_id"])
                d = {**d, "title": _cap(dlv["title"]), "run_no": run_no}
                link = _run_link(run_no) or _card_link(dlv["task_id"])
        rows.append(_row(
            f"act:{a['id']}", "person" if a["actor"] else "agent", a["actor"],
            _ACTIVITY_KINDS.get(a["action"], "settings"), a["action"],
            a["created_at"], d, link,
        ))

    for p in conn.execute(
        "SELECT rev, created_by, created_at, activated_at, note "
        "FROM project_playbook WHERE project_id = ?", (pid,)
    ).fetchall():
        rows.append(_row(
            f"pb:{p['rev']}", "person" if p["created_by"] else "agent",
            p["created_by"], "playbook", "playbook_saved", p["created_at"],
            {"rev": p["rev"], "note": _cap(p["note"])},
        ))
        if p["activated_at"] and p["rev"] not in activated_logged:
            # Activations before project_activity existed, and automatic
            # re-plan activations (which carry their own note), have no
            # recorded human actor.
            auto = str(p["note"] or "").startswith("activated automatically")
            rows.append(_row(
                f"pba:{p['rev']}", "agent" if auto else "person", None,
                "playbook", "playbook_activated", p["activated_at"],
                {"rev": p["rev"]},
            ))

    for r in conn.execute(
        "SELECT run_no, trigger, triggered_by, profile, status, started_at, "
        "ended_at, retro_at, score_self, score_user, scored_by, scored_at "
        "FROM project_runs WHERE project_id = ?", (pid,)
    ).fetchall():
        n = r["run_no"]
        scheduled = r["trigger"] == "schedule" or not r["triggered_by"]
        rows.append(_row(
            f"run:{n}:start", "agent" if scheduled else "person",
            None if scheduled else r["triggered_by"], "runs", "run_started",
            r["started_at"], {"run_no": n, "trigger": r["trigger"]},
            _run_link(n),
        ))
        if r["ended_at"]:
            rows.append(_row(
                f"run:{n}:end", "agent", r["profile"], "runs", "run_finished",
                r["ended_at"], {"run_no": n, "status": r["status"]},
                _run_link(n),
            ))
        if r["retro_at"] and n not in retro_logged:
            rows.append(_row(
                f"run:{n}:retro", "agent", r["profile"], "runs", "run_retro",
                r["retro_at"], {"run_no": n, "score": r["score_self"]},
                _run_link(n),
            ))
        if r["scored_at"] and r["score_user"] is not None:
            rows.append(_row(
                f"run:{n}:score", "person", r["scored_by"], "runs",
                "run_scored", r["scored_at"],
                {"run_no": n, "score": r["score_user"]}, _run_link(n),
            ))

    for o in conn.execute(
        "SELECT id, title, accepted_at, accepted_by FROM project_outputs "
        "WHERE project_id = ?", (pid,)
    ).fetchall():
        if o["accepted_at"]:
            rows.append(_row(
                f"out:{o['id']}:accept", "person", o["accepted_by"],
                "outputs", "output_accepted", o["accepted_at"],
                {"title": _cap(o["title"])},
            ))
    for d in deliveries.values():
        if d["id"] in delivery_logged:
            continue
        run_no = run_nos.get(d["run_id"])
        rows.append(_row(
            f"dlv:{d['id']}", "agent", d["profile"], "outputs",
            "output_delivered", d["delivered_at"],
            {"title": _cap(d["title"]), "label": _cap(d["label"]),
             "run_no": run_no},
            _run_link(run_no) or _card_link(d["task_id"]),
        ))

    for d in conn.execute(
        "SELECT id, kind, body, author_user_id, created_at FROM "
        "project_directives WHERE project_id = ?", (pid,)
    ).fetchall():
        rows.append(_row(
            f"dir:{d['id']}", "person", d["author_user_id"], "inputs",
            "directive_added", d["created_at"],
            {"kind": d["kind"], "body": _cap(d["body"])},
        ))
    for i, ln in enumerate(conn.execute(
        "SELECT kind, label, ref, added_by, added_at FROM project_links "
        "WHERE project_id = ? ORDER BY added_at, rowid", (pid,)
    ).fetchall()):
        rows.append(_row(
            f"lnk:{ln['added_at']}:{i}", "person" if ln["added_by"] else "agent",
            ln["added_by"], "inputs", "link_added", ln["added_at"],
            {"kind": ln["kind"], "label": _cap(ln["label"] or ln["ref"])},
        ))
    for c in conn.execute(
        "SELECT round_no, confirmed_by, confirmed_at FROM "
        "project_clarify_rounds WHERE project_id = ? AND confirmed_at "
        "IS NOT NULL", (pid,)
    ).fetchall():
        rows.append(_row(
            f"clr:{c['round_no']}", "person", c["confirmed_by"], "inputs",
            "brief_confirmed", c["confirmed_at"], {"round": c["round_no"]},
        ))
    for m in conn.execute(
        "SELECT user_id, role, added_by, added_at FROM project_members "
        "WHERE project_id = ?", (pid,)
    ).fetchall():
        rows.append(_row(
            f"mem:{m['user_id']}:{m['added_at']}", "person", m["added_by"],
            "settings", "member_added", m["added_at"],
            {"user_id": m["user_id"], "role": m["role"]},
        ))
    for p in conn.execute(
        "SELECT profile, added_by, added_at FROM project_profiles "
        "WHERE project_id = ?", (pid,)
    ).fetchall():
        rows.append(_row(
            f"prf:{p['profile']}:{p['added_at']}",
            "person" if p["added_by"] else "agent", p["added_by"],
            "settings", "profile_added", p["added_at"],
            {"profile": p["profile"]},
        ))
    for c in conn.execute(
        "SELECT id, name, created_by, created_at FROM project_contacts "
        "WHERE project_id = ?", (pid,)
    ).fetchall():
        rows.append(_row(
            f"con:{c['id']}", "person" if c["created_by"] else "agent",
            c["created_by"], "settings", "contact_added", c["created_at"],
            {"name": _cap(c["name"])},
        ))
    return rows


def _visibility(principal) -> tuple[str, list]:
    clause = "t.project_id = ? AND t.status != 'archived'"
    if principal is not None and not principal.is_owner:
        return (
            clause + " AND (t.visibility = 'shared' OR t.visibility = ?)",
            [principal.private_visibility],
        )
    return clause, []


def _card_rows(bconn: sqlite3.Connection, project, principal) -> list[dict]:
    clause, extra = _visibility(principal)
    kinds = list(_KANBAN_ACTIONS)
    marks = ",".join("?" for _ in kinds)
    rows = []
    for e in bconn.execute(
        "SELECT e.id, e.task_id, e.kind, e.payload, e.created_at, t.title "
        "FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE "
        + clause + f" AND e.kind IN ({marks})",
        [project.id, *extra, *kinds],
    ).fetchall():
        try:
            payload = json.loads(e["payload"] or "{}")
        except ValueError:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        kind, actor = _KANBAN_ACTIONS[e["kind"]]
        detail = {"card": _cap(e["title"])}
        for k in ("rev", "run_no", "key"):
            if payload.get(k) is not None:
                detail[k] = payload[k]
        rows.append(_row(
            f"ev:{e['id']}", actor,
            payload.get("by") if actor == "person" else None,
            kind, e["kind"], e["created_at"], detail, _card_link(e["task_id"]),
        ))
    return rows


# ---------------------------------------------------------------------------
# Tool calls (lazy, per run)
# ---------------------------------------------------------------------------


def _state_db(profile: str) -> Optional[Path]:
    try:
        home = resolve_profile_env(normalize_profile_name(profile or "default"))
    except Exception:  # noqa: BLE001 — a profile removed since the run
        return None
    path = Path(home) / "state.db"
    return path if path.exists() else None


def _open_ro(path: Path) -> Optional[sqlite3.Connection]:
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
    except sqlite3.Error:
        return None
    conn.row_factory = sqlite3.Row
    return conn


def _tool_names(raw: Any) -> list[str]:
    try:
        calls = json.loads(raw) if isinstance(raw, str) else raw
    except ValueError:
        return []
    names = []
    for c in calls or []:
        if not isinstance(c, dict):
            continue
        fn = c.get("function") if isinstance(c.get("function"), dict) else {}
        name = fn.get("name") or c.get("name")
        if name:
            names.append(str(name))
    return names


def _session_tool_rows(
    db: Path,
    profile: str,
    sessions: Iterable[str],
    *,
    lo: float,
    hi: float,
    run_no: int,
    card: Optional[tuple[str, str]],
    limit: int,
    before: Callable[[dict], bool],
) -> list[dict]:
    """Tool rows from ``sessions`` in ``[lo, hi)`` that pass ``before``.

    Messages are read newest first in batches until ``limit`` rows pass the
    cursor *and* the scan has left the second the last of them falls in, so
    rows already shown in the boundary second never use up the lookahead."""
    sessions = [s for s in sessions if s]
    if not sessions:
        return []
    conn = _open_ro(db)
    if conn is None:
        return []
    marks = ",".join("?" for _ in sessions)
    sql = (
        "SELECT id, tool_calls, timestamp FROM messages WHERE session_id "
        f"IN ({marks}) AND role = 'assistant' AND tool_calls IS NOT NULL "
        "AND timestamp >= ? AND (timestamp < ? OR (timestamp = ? AND id < ?)) "
        "ORDER BY timestamp DESC, id DESC LIMIT ?"
    )
    batch = max(int(limit), 50)
    rows: list[dict] = []
    top, top_id = hi, None
    try:
        while True:
            msgs = conn.execute(
                sql, [*sessions, lo, top, top, top_id or 0, batch],
            ).fetchall()
            for m in msgs:
                for i, name in enumerate(_tool_names(m["tool_calls"])):
                    detail = {"tool": name, "run_no": run_no}
                    if card:
                        detail["card"] = _cap(card[1])
                    row = _row(
                        f"tool:{profile}:{m['id']}:{i}", "agent", profile,
                        "tools", "tool_called", int(m["timestamp"]), detail,
                        _card_link(card[0]) if card else _run_link(run_no),
                    )
                    if before(row):
                        rows.append(row)
            if len(msgs) < batch:
                break
            top, top_id = msgs[-1]["timestamp"], msgs[-1]["id"]
            if len(rows) >= limit:
                floor = sorted(rows, key=_key, reverse=True)[limit - 1]["at"]
                if int(top) < floor:
                    break
    except sqlite3.Error:
        return rows
    finally:
        conn.close()
    return rows


def _worker_sessions(db: Path, task_id: str) -> list[str]:
    conn = _open_ro(db)
    if conn is None:
        return []
    try:
        return [
            r["session_id"] for r in conn.execute(
                "SELECT DISTINCT session_id FROM api_call_log "
                "WHERE kanban_task_id = ? AND session_id IS NOT NULL",
                (task_id,),
            ).fetchall()
        ]
    except sqlite3.Error:
        return []
    finally:
        conn.close()


def _run_tool_rows(
    pconn, bconn, project, principal, run: dict, allowed: set[str],
    *, lo: float, hi: float, limit: int, before: Callable[[dict], bool],
) -> list[dict]:
    """One run's tool calls in ``[lo, hi)``: the run's own session (host
    profile) plus every visible card's worker sessions (assignee profile).
    Only profiles attached to the project are opened."""
    run_no = int(run["run_no"])
    rows: list[dict] = []
    host = run.get("profile") or ""
    if run.get("session_id") and host in allowed:
        db = _state_db(host)
        if db is not None:
            rows += _session_tool_rows(
                db, host, [run["session_id"]], lo=lo, hi=hi, run_no=run_no,
                card=None, limit=limit, before=before,
            )
    task_ids = [
        r["task_id"] for r in pconn.execute(
            "SELECT task_id FROM project_run_cards WHERE run_id = ?",
            (run["id"],),
        ).fetchall()
    ]
    if not task_ids or bconn is None:
        return rows
    clause, extra = _visibility(principal)
    marks = ",".join("?" for _ in task_ids)
    try:
        cards = bconn.execute(
            "SELECT t.id, t.title, t.assignee FROM tasks t WHERE "
            + clause + f" AND t.id IN ({marks})",
            [project.id, *extra, *task_ids],
        ).fetchall()
    except sqlite3.Error:
        return rows
    # A card's worker sessions live in whichever profile ran each attempt,
    # which a reassignment does not move: look in every project profile.
    stores = [(p, _state_db(p)) for p in sorted(allowed)]
    for c in cards:
        for profile, db in stores:
            if db is None:
                continue
            rows += _session_tool_rows(
                db, profile, _worker_sessions(db, c["id"]), lo=lo, hi=hi,
                run_no=run_no, card=(c["id"], c["title"] or c["id"]),
                limit=limit, before=before,
            )
    return rows


# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------


def _key(row: dict) -> tuple[int, str]:
    return (row["at"], row["id"])


def _keep(row: dict, actor: str, kind: Optional[str]) -> bool:
    if actor == "people" and row["actor"] != "person":
        return False
    if actor == "agents" and row["actor"] != "agent":
        return False
    return kind is None or row["kind"] == kind


def build_log(
    project,
    principal,
    *,
    actor: str = "all",
    kind: Optional[str] = None,
    cursor: Optional[tuple[int, str]] = None,
    limit: int = DEFAULT_LIMIT,
) -> dict:
    if actor not in ACTOR_FILTERS:
        raise ValueError(f"actor must be one of {list(ACTOR_FILTERS)}")
    if kind is not None and kind not in KINDS:
        raise ValueError(f"kind must be one of {list(KINDS)}")
    limit = max(1, min(int(limit), MAX_LIMIT))

    def before(row: dict) -> bool:
        return cursor is None or _key(row) < cursor

    with projects_db.connect_closing() as pconn, kanban_db.connect_closing(
        board=project.board_slug or None
    ) as bconn:
        rows = _project_rows(pconn, project)
        try:
            rows += _card_rows(bconn, project, principal)
        except sqlite3.Error:
            logger.warning("project log: card events unreadable", exc_info=True)
        page = sorted(
            (r for r in rows if _keep(r, actor, kind) and before(r)),
            key=_key, reverse=True,
        )
        # One row past the page tells us whether there is a next page.
        page = page[: limit + 1]

        if actor != "people" and kind in (None, "tools"):
            allowed = {
                p["profile"] for p in projects_db.get_project_profiles(
                    pconn, project.id
                )
            }
            if project.host_profile:
                allowed.add(project.host_profile)
            now = int(time.time())
            hi = (cursor[0] + 1) if cursor else now + 1
            runs = sorted(
                (
                    dict(r) for r in pconn.execute(
                        "SELECT id, run_no, profile, session_id, started_at, "
                        "ended_at FROM project_runs WHERE project_id = ? "
                        "AND started_at < ?", (project.id, hi),
                    ).fetchall()
                ),
                key=lambda r: r["ended_at"] or now, reverse=True,
            )
            for run in runs:
                lo = page[-1]["at"] if len(page) > limit else 0
                if (run["ended_at"] or now) < lo:
                    break
                found = _run_tool_rows(
                    pconn, bconn, project, principal, run, allowed,
                    lo=max(lo, run["started_at"]), hi=hi, limit=limit + 1,
                    before=before,
                )
                if found:
                    page = sorted(
                        page + found,
                        key=_key, reverse=True,
                    )[: limit + 1]

    more = len(page) > limit
    page = page[:limit]
    next_cursor = f"{page[-1]['at']}:{page[-1]['id']}" if more and page else None
    return {"entries": page, "next_cursor": next_cursor}
