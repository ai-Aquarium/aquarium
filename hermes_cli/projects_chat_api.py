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
conversations the caller owns, in profiles they are actively enrolled in, are
read or linked. Each person has one canonical conversation per profile (the
oldest ``project chat`` link they made); a conversation attached to the
project as a reference never becomes where the chat's turns go.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request

from agent.prompt_builder import STEER_MARKER_CLOSE, STEER_MARKER_OPEN
from hermes_cli import projects_api, projects_db
from hermes_cli.projects_api import _require_read, _require_write

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

LINK_KIND = "conversation"
CHAT_LABEL = "project chat"
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

# At the top of the turn, or right after the attachment notes the web server
# prepends (each note ends in a blank line).
_BLOCK_RE = re.compile(
    r"(?:\A|(?<=\n\n))(?P<lead>(?:\[app context:[^\n]*\][ \t]*\r?\n)?)"
    + re.escape(BLOCK_OPEN)
    + r"[^\n]*\n(?P<body>.*?)\n"
    + re.escape(BLOCK_CLOSE)
    + r"[ \t]*(?:\r?\n){0,2}",
    re.DOTALL,
)
_APP_CONTEXT_RE = re.compile(r"^\[app context:[^\n]*\][ \t]*\r?\n?")
_ATTACHMENT_NOTE_RE = re.compile(
    r"^\[The user (?:sent (?:a text document|a document|an image): '|attached ')"
)
_CATCH_UP_COUNT_RE = re.compile(r"^" + re.escape(CATCH_UP_HEADER) + r" (\d+) ", re.MULTILINE)


def _short(text: Any, limit: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[: limit - 1].rstrip() + "…"


def split_block(content: str) -> tuple[str, dict]:
    """``(what the person typed, {seeded, catch_up})`` for a stored user turn."""
    m = _BLOCK_RE.search(content or "")
    if not m:
        return content, {"seeded": False, "catch_up": 0}
    body = m.group("body")
    count = _CATCH_UP_COUNT_RE.search(body)
    meta = {
        "seeded": CONTEXT_HEADER in body,
        "catch_up": int(count.group(1)) if count else 0,
    }
    return content[: m.start()] + m.group("lead") + content[m.end():], meta


def typed_text(content: str) -> str:
    """Only what the person typed: no attachment notes (or inlined file
    text), app-context line or project block. Feeds the catch-up digest."""
    content = content or ""
    m = _BLOCK_RE.search(content)
    if m:
        return content[m.end():]
    if _ATTACHMENT_NOTE_RE.match(content):
        ctx = content.find("\n\n[app context:")
        if ctx < 0:
            # Nothing marks where inlined file text ends: say nothing rather
            # than quote the file.
            return ""
        content = content[ctx + 2 :]
    return _APP_CONTEXT_RE.sub("", content, count=1)


def split_steers(content: str) -> list[str]:
    """Steers delivered mid-turn, appended to a tool result (oldest first)."""
    steers: list[str] = []
    rest = (content or "").rstrip()
    while rest.endswith(STEER_MARKER_CLOSE):
        body = rest[: -len(STEER_MARKER_CLOSE)].rstrip()
        at = body.rfind(STEER_MARKER_OPEN)
        if at < 0 or (at > 0 and body[at - 1] != "\n"):
            break
        text = body[at + len(STEER_MARKER_OPEN):].strip()
        if text:
            steers.insert(0, text)
        rest = body[:at].rstrip()
    return steers


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


async def _chat_profiles(user_id: str) -> set[str]:
    """Profiles the caller is actively enrolled in (suspended ones excluded)."""
    return set(await projects_api._enrolled_profiles(user_id))


def _chat_links(project_id: str, user_id: str) -> list[dict]:
    """*user_id*'s project-chat links, oldest first (the canonical one leads)."""
    with projects_db.connect_closing() as conn:
        rows = projects_db.get_project_links(conn, project_id, kind=LINK_KIND)
    mine = [r for r in rows if r.get("label") == CHAT_LABEL and r.get("added_by") == user_id]
    return sorted(mine, key=lambda r: (r.get("added_at") or 0, r.get("ref") or ""))


def _owned_sessions(links: list[dict], user_id: str, enrolled: set[str]) -> list[dict]:
    """The linked conversations *user_id* owns in a profile they are enrolled
    in, oldest link first, with their visible turns: user/assistant rows and
    each steer delivered inside a tool result, as the user's own row."""
    out: list[dict] = []
    for link in links:
        profile = link.get("profile") or "default"
        if profile not in enrolled:
            continue
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
                    if m.get("role") == "tool":
                        steers = split_steers(_text(m.get("content")))
                        if steers:
                            rows.append(
                                {
                                    "id": m.get("id"),
                                    "role": "user",
                                    "content": "\n\n".join(steers),
                                    "timestamp": float(m.get("timestamp") or 0),
                                    "sent_while_working": True,
                                }
                            )
                        continue
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
                row["typed"] = m["content"] if m.get("sent_while_working") else typed_text(m["content"])
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
        said = r.get("typed", r["content"]) if r["role"] == "user" else r["content"]
        lines.append(f"- {who}: {_short(said, CATCH_UP_TURN_CHARS) or '(attachments)'}")
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
        # The revision it was written from; base 0 = written from nothing,
        # NULL (older rows) = assume the one saved just before.
        base_rev = r.get("base_rev")
        base = by_rev.get(r["rev"] - 1 if base_rev is None else base_rev)
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


def _timeline_sync(project, user_id: str, enrolled: set[str]) -> dict:
    sessions = _owned_sessions(_chat_links(project.id, user_id), user_id, enrolled)
    timeline = merge_timeline(sessions)
    since = timeline[0]["timestamp"] if timeline else None
    with projects_db.connect_closing() as conn:
        proposals = proposals_since(conn, project.id, since)
    latest: dict[str, str] = {}
    for s in sessions:
        latest.setdefault(s["profile"], s["session_id"])
    last_profile = next(
        (r["profile"] for r in reversed(timeline)), None
    )
    return {
        "sessions": [{"profile": p, "session_id": sid} for p, sid in latest.items()],
        "messages": [
            {k: v for k, v in r.items() if k != "typed"}
            for r in timeline[-TIMELINE_MAX_MESSAGES:]
        ],
        "truncated": len(timeline) > TIMELINE_MAX_MESSAGES,
        "proposals": proposals,
        "last_profile": last_profile,
    }


@router.get("/{slug}/chat/timeline")
async def chat_timeline(request: Request) -> dict[str, Any]:
    project, _role, _profiles, principal = await _require_read(request)
    enrolled = await _chat_profiles(principal.user_id)
    return await asyncio.to_thread(_timeline_sync, project, principal.user_id, enrolled)


def _project_ref(project) -> Optional[str]:
    try:
        from hermes_cli.projects_api import _project_refs

        return _project_refs([project]).get(project.id)
    except Exception:  # noqa: BLE001 - the ref is a nicety in the header
        return None


def _owned_sid(db, ref: str, user_id: str) -> Optional[str]:
    sid = db.resolve_session_id(ref)
    return sid if sid and db.session_owner_user_id(sid) == user_id else None


def _canonical_sid(db, links: list[dict], profile: str, user_id: str) -> Optional[str]:
    for link in links:
        if link["profile"] == profile:
            sid = _owned_sid(db, link["ref"], user_id)
            if sid:
                return sid
    return None


def _prepare_sync(
    project, user_id: str, enrolled: set[str], profile: str, session_id: str, message: str, person: str
) -> dict:
    if profile not in enrolled:
        raise HTTPException(status_code=403, detail="Not enrolled in that profile")
    db = _session_db(profile)
    try:
        if not _owned_sid(db, session_id, user_id):
            raise HTTPException(status_code=404, detail="Session not found")
        # One conversation per person and profile: a turn sent from a second
        # page (or with a fresh session) still lands in the canonical one.
        links = _chat_links(project.id, user_id)
        sid = _canonical_sid(db, links, profile, user_id)
        if sid is None:
            with projects_db.connect_closing() as conn:
                projects_db.add_project_link(
                    conn,
                    project_id=project.id,
                    kind=LINK_KIND,
                    profile=profile,
                    ref=db.resolve_session_id(session_id),
                    label=CHAT_LABEL,
                    added_by=user_id,
                )
            links = _chat_links(project.id, user_id)
            # Two pages racing both link; the oldest link wins for both.
            sid = _canonical_sid(db, links, profile, user_id)
        empty = not any(
            m.get("role") in ("user", "assistant")
            for m in db.get_messages(db.resolve_resume_session_id(sid) or sid)
        )
    finally:
        db.close()
    timeline = merge_timeline(_owned_sessions(links, user_id, enrolled))
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
    enrolled = await _chat_profiles(principal.user_id)
    return await asyncio.to_thread(
        _prepare_sync, project, principal.user_id, enrolled, profile, session_id, message, person
    )


def projects_api_refuse_archived(project) -> None:
    from hermes_cli.projects_api import _refuse_if_archived

    _refuse_if_archived(project, "chatting in it")
