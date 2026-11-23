"""The project chat: one timeline over per-profile sessions (2026-11-22 plan, stage 2).

Each profile that talks in a project keeps **its own** conversation in its own
``state.db`` (profiles are separate ``HERMES_HOME``s, so memory and prompt
caching stay per profile). A conversation joins the project chat through a
``project_links`` row of kind ``conversation`` carrying its profile.

* ``GET /{slug}/chat/timeline`` — the caller's linked conversations merged
  into one time-ordered list, each turn labelled with its profile, plus the
  playbook revisions proposed while the chat ran.
* ``POST /{slug}/chat/prepare`` — called by agent-home right before a turn is
  streamed: links a new conversation and returns the text to send. The
  project context (first turn only) and a catch-up digest of what this
  profile missed go **at the top of that same user turn**, never the system
  prompt and never as an extra message, so the cached prefix and strict
  user/assistant alternation are untouched (AGENTS.md).

A project chat is private to the person who has it, like every chat: only
conversations the caller owns are read or linked.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import projects_db
from hermes_cli.projects_api import _require_read, _require_write

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

LINK_KIND = "conversation"
BLOCK_OPEN = "[project chat:"
BLOCK_CLOSE = "[/project chat]"
CATCH_UP_HEADER = "Catch-up:"
CONTEXT_HEADER = "Project context:"

TIMELINE_MAX_MESSAGES = 300
CATCH_UP_MAX_TURNS = 8
CATCH_UP_TURN_CHARS = 280
CONTEXT_FIELD_CHARS = 600
CONTEXT_MAX_STEPS = 20
MESSAGE_MAX_CHARS = 20_000

_BLOCK_RE = re.compile(
    r"^(?P<lead>(?:\[app context:[^\n]*\][ \t]*\r?\n)?)"
    + re.escape(BLOCK_OPEN)
    + r"[^\n]*\n(?P<body>.*?)\n"
    + re.escape(BLOCK_CLOSE)
    + r"[ \t]*(?:\r?\n){0,2}",
    re.DOTALL,
)
_CATCH_UP_COUNT_RE = re.compile(r"^" + re.escape(CATCH_UP_HEADER) + r" (\d+) ", re.MULTILINE)


def _short(text: Any, limit: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def split_block(content: str) -> tuple[str, dict]:
    """``(what the person typed, {seeded, catch_up})`` for a stored user turn."""
    m = _BLOCK_RE.match(content or "")
    if not m:
        return content, {"seeded": False, "catch_up": 0}
    body = m.group("body")
    count = _CATCH_UP_COUNT_RE.search(body)
    meta = {
        "seeded": CONTEXT_HEADER in body,
        "catch_up": int(count.group(1)) if count else 0,
    }
    return m.group("lead") + content[m.end():], meta


def _session_db(profile: str):
    from hermes_cli.web_server import _open_session_db_for_profile

    return _open_session_db_for_profile(profile)


def _text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n\n".join(
            str(b.get("text") or "")
            for b in content
            if isinstance(b, dict) and b.get("type") == "text"
        )
    return ""


def _linked_conversations(project_id: str) -> list[dict]:
    with projects_db.connect_closing() as conn:
        return projects_db.get_project_links(conn, project_id, kind=LINK_KIND)


def _owned_sessions(links: list[dict], user_id: str) -> list[dict]:
    """The linked conversations *user_id* owns, oldest link first, with
    their visible turns (``role`` user/assistant, non-empty)."""
    out: list[dict] = []
    for link in sorted(links, key=lambda r: r.get("added_at") or 0):
        profile = link.get("profile") or "default"
        try:
            db = _session_db(profile)
        except HTTPException:
            continue
        try:
            sid = db.resolve_session_id(link["ref"])
            if not sid or db.session_owner_user_id(sid) != user_id:
                continue
            chain = [sid]
            tail = db.resolve_resume_session_id(sid)
            if tail and tail != sid:
                chain.append(tail)
            rows: list[dict] = []
            for part in chain:
                for m in db.get_messages(part):
                    if m.get("role") not in ("user", "assistant"):
                        continue
                    text = _text(m.get("content"))
                    if not text.strip():
                        continue
                    rows.append(
                        {
                            "id": m.get("id"),
                            "role": m["role"],
                            "content": text,
                            "timestamp": float(m.get("timestamp") or 0),
                        }
                    )
            out.append(
                {"profile": profile, "session_id": sid, "linked_at": link.get("added_at"), "messages": rows}
            )
        except Exception:  # noqa: BLE001 - one unreadable profile never blanks the chat
            logger.warning("project chat: reading %s/%s failed", profile, link.get("ref"), exc_info=True)
        finally:
            db.close()
    return out


def merge_timeline(sessions: list[dict]) -> list[dict]:
    """Every session's turns in time order, each labelled with its profile."""
    merged: list[dict] = []
    for s in sessions:
        for m in s["messages"]:
            row = {**m, "profile": s["profile"], "session_id": s["session_id"]}
            if m["role"] == "user":
                shown, meta = split_block(m["content"])
                row["content"] = shown
                row.update(meta)
            merged.append(row)
    merged.sort(key=lambda r: (r["timestamp"], r["session_id"], r.get("id") or 0))
    return merged


def missed_turns(timeline: list[dict], profile: str) -> list[dict]:
    """Turns of the other profiles after *profile*'s own last turn."""
    last = max(
        (r["timestamp"] for r in timeline if r["profile"] == profile), default=None
    )
    return [
        r
        for r in timeline
        if r["profile"] != profile and (last is None or r["timestamp"] > last)
    ]


def catch_up_digest(missed: list[dict], profile: str, person: str = "the user") -> str:
    """A short, deterministic digest of *missed* (newest turns kept)."""
    if not missed:
        return ""
    shown = missed[-CATCH_UP_MAX_TURNS:]
    lines = [
        f"{CATCH_UP_HEADER} {len(missed)} messages in this project chat went to "
        f"other profiles since your last turn"
        + (f" (the last {len(shown)} below)" if len(shown) < len(missed) else "")
        + ":"
    ]
    for r in shown:
        who = f"{person} → {r['profile']}" if r["role"] == "user" else r["profile"]
        lines.append(f"- {who}: {_short(r['content'], CATCH_UP_TURN_CHARS)}")
    return "\n".join(lines)


def project_context(conn, project) -> str:
    """The brief, the active playbook and the last run's retro, bounded."""
    lines = [CONTEXT_HEADER]
    if project.goal:
        lines.append(f"Goal: {_short(project.goal, CONTEXT_FIELD_CHARS)}")
    if project.description:
        lines.append(f"Brief: {_short(project.description, CONTEXT_FIELD_CHARS)}")
    if project.definition_of_done:
        lines.append(f"Done when: {_short(project.definition_of_done, CONTEXT_FIELD_CHARS)}")
    pb = projects_db.get_playbook(conn, project.id)
    if pb:
        lines.append(f"Active playbook v{pb['rev']}:")
        if pb.get("body"):
            lines.append(f"  {_short(pb['body'], CONTEXT_FIELD_CHARS)}")
        steps = pb.get("steps") or []
        for i, step in enumerate(steps[:CONTEXT_MAX_STEPS], 1):
            mark = " (checkpoint)" if step.get("checkpoint") else ""
            lines.append(f"  {i}. {_short(step.get('title'), 120)}{mark}")
        if len(steps) > CONTEXT_MAX_STEPS:
            lines.append(f"  … {len(steps) - CONTEXT_MAX_STEPS} more steps")
    else:
        lines.append("No active playbook yet.")
    runs = projects_db.list_project_runs(conn, project.id, limit=1)
    if runs:
        run = runs[0]
        score = run.get("score_user") or run.get("score_self")
        head = f"Last run: run {run['run_no']}, {run['status']}"
        if score:
            head += f", scored {score}/5"
        lines.append(head)
        if run.get("retro"):
            lines.append(f"  Retro: {_short(run['retro'], CONTEXT_FIELD_CHARS)}")
    lines.append(
        f"Use `hermes projects … {project.slug}` to read or change this project; "
        "a playbook you save is a proposal until a person makes it active."
    )
    return "\n".join(lines)


def compose_turn(project, ref: Optional[str], message: str, *, context: str, digest: str) -> str:
    """The user turn to send: an optional block, then the typed text."""
    parts = [p for p in (context, digest) if p]
    if not parts:
        return message
    title = f"{ref} · {project.name}" if ref else project.name
    block = f"{BLOCK_OPEN} {_short(title, 120)}]\n" + "\n\n".join(parts) + f"\n{BLOCK_CLOSE}"
    m = re.match(r"^\[app context:[^\n]*\][ \t]*\r?\n", message)
    lead = m.group(0) if m else ""
    return f"{lead}{block}\n\n{message[len(lead):]}"


def _step_key(step: dict, index: int) -> str:
    return str(step.get("key") or step.get("title") or index)


def step_changes(before: list[dict], after: list[dict]) -> dict:
    """Added / removed / changed step counts between two revisions."""
    old = {_step_key(s, i): s for i, s in enumerate(before)}
    new = {_step_key(s, i): s for i, s in enumerate(after)}

    def same(a: dict, b: dict) -> bool:
        fields = ("title", "body", "checkpoint", "mode", "depends_on", "assignee")
        return all((a.get(f) or None) == (b.get(f) or None) for f in fields)

    added = [new[k] for k in new if k not in old]
    return {
        "added": len(added),
        "removed": sum(1 for k in old if k not in new),
        "changed": sum(1 for k in new if k in old and not same(old[k], new[k])),
        "added_titles": [_short(s.get("title"), 80) for s in added[:3]],
    }


def proposals_since(conn, project_id: str, since: Optional[float]) -> list[dict]:
    """Playbook revisions saved while the project chat ran."""
    if since is None:
        return []
    revs = projects_db.list_playbook_revs(conn, project_id)
    by_rev = {r["rev"]: r for r in revs}
    out = []
    for r in sorted(revs, key=lambda x: x["rev"]):
        # created_at is whole seconds; message stamps are fractional.
        if (r.get("created_at") or 0) < int(since):
            continue
        base = by_rev.get(r["rev"] - 1)
        out.append(
            {
                "rev": r["rev"],
                "base_rev": base["rev"] if base else None,
                "active": bool(r.get("active")),
                "created_at": r.get("created_at"),
                "created_by": r.get("created_by"),
                "note": r.get("note"),
                **step_changes(base["steps"] if base else [], r.get("steps") or []),
            }
        )
    return out


def _timeline_sync(project, user_id: str) -> dict:
    sessions = _owned_sessions(_linked_conversations(project.id), user_id)
    timeline = merge_timeline(sessions)
    since = timeline[0]["timestamp"] if timeline else None
    with projects_db.connect_closing() as conn:
        proposals = proposals_since(conn, project.id, since)
    latest: dict[str, str] = {}
    for s in sessions:
        latest[s["profile"]] = s["session_id"]
    last_profile = next(
        (r["profile"] for r in reversed(timeline)), None
    )
    return {
        "sessions": [{"profile": p, "session_id": sid} for p, sid in latest.items()],
        "messages": timeline[-TIMELINE_MAX_MESSAGES:],
        "truncated": len(timeline) > TIMELINE_MAX_MESSAGES,
        "proposals": proposals,
        "last_profile": last_profile,
    }


@router.get("/{slug}/chat/timeline")
async def chat_timeline(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_read(request)
    return await asyncio.to_thread(_timeline_sync, project, principal.user_id)


def _project_ref(project) -> Optional[str]:
    try:
        from hermes_cli.projects_api import _project_refs

        return _project_refs([project]).get(project.id)
    except Exception:  # noqa: BLE001 - the ref is a nicety in the header
        return None


def _prepare_sync(project, user_id: str, profile: str, session_id: str, message: str, person: str) -> dict:
    db = _session_db(profile)
    try:
        sid = db.resolve_session_id(session_id)
        if not sid or db.session_owner_user_id(sid) != user_id:
            raise HTTPException(status_code=404, detail="Session not found")
        empty = not any(
            m.get("role") in ("user", "assistant")
            for m in db.get_messages(db.resolve_resume_session_id(sid) or sid)
        )
    finally:
        db.close()
    links = _linked_conversations(project.id)
    if not any(l["profile"] == profile and l["ref"] == sid for l in links):
        with projects_db.connect_closing() as conn:
            projects_db.add_project_link(
                conn,
                project_id=project.id,
                kind=LINK_KIND,
                profile=profile,
                ref=sid,
                label="project chat",
                added_by=user_id,
            )
        links = _linked_conversations(project.id)
    timeline = merge_timeline(_owned_sessions(links, user_id))
    missed = missed_turns(timeline, profile)
    digest = catch_up_digest(missed, profile, person)
    context = ""
    if empty:
        with projects_db.connect_closing() as conn:
            context = project_context(conn, project)
    return {
        "session_id": sid,
        "message": compose_turn(project, _project_ref(project), message, context=context, digest=digest),
        "seeded": bool(context),
        "catch_up": len(missed),
    }


@router.post("/{slug}/chat/prepare")
async def chat_prepare(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_write(request, judgement=True)
    projects_api_refuse_archived(project)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    if not isinstance(body, dict):
        body = {}
    profile = str(body.get("profile") or "default").strip() or "default"
    session_id = str(body.get("session_id") or "").strip()
    message = str(body.get("message") or "")
    if not session_id or not message.strip():
        raise HTTPException(status_code=422, detail="session_id and message are required")
    if len(message) > MESSAGE_MAX_CHARS * 5:
        raise HTTPException(status_code=413, detail="message is too long")
    person = _short(getattr(principal, "display", None) or "the user", 60)
    return await asyncio.to_thread(
        _prepare_sync, project, principal.user_id, profile, session_id, message, person
    )


def projects_api_refuse_archived(project) -> None:
    from hermes_cli.projects_api import _refuse_if_archived

    _refuse_if_archived(project, "chatting in it")
