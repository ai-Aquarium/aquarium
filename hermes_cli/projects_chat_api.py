"""The project chat: one group timeline over per-person, per-profile sessions.

Every member of a project sees one chat. Behind it, each person keeps **their
own** conversation per profile they talk to, in that profile's ``state.db``
(profiles are separate ``HERMES_HOME``s, so memory and prompt caching stay per
profile, and two members' turns run in parallel). A conversation joins the
chat through a ``project_links`` row of kind ``conversation`` labelled
``project chat``, added by its owner. A message a member sends with the agent
left out ("Ask agent" off) lives in ``project_chat_messages``.

* ``GET /{slug}/chat/timeline`` — every member's linked conversations and
  members-only messages merged into one time-ordered list, each turn
  labelled with its person and profile, plus the playbook revisions
  proposed while the chat ran.
* ``POST /{slug}/chat/prepare`` — called by agent-home right before a turn is
  streamed: links a new conversation and returns the text to send. The
  project context (first turn only) and a catch-up digest of everything the
  group said since this conversation's last turn go **at the top of that
  same user turn**, never the system prompt and never as an extra message,
  so the cached prefix and strict user/assistant alternation are untouched
  (AGENTS.md).
* ``POST /{slug}/chat/messages`` — a members-only message; no model call.

Members (viewers included), the project's creator and instance admins read
the whole group; a viewer never posts. A conversation is only ever written
by its owner, in a profile they are actively enrolled in; each person has one
canonical conversation per profile (the oldest ``project chat`` link they
made), and a conversation attached to the project as a reference never
becomes where the chat's turns go.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Iterable, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, HTTPException, Request

from agent.prompt_builder import STEER_MARKER_CLOSE, STEER_MARKER_OPEN
from hermes_cli import projects_api, projects_db, ref_mentions
from hermes_cli.projects_api import _require_read, _require_write

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/registry/projects")

LINK_KIND = "conversation"
# A person's conversation in the group chat. Links labelled CHAT_LABEL come
# from before the group chat, when only their owner could read them: they
# stay private and read-only.
GROUP_LABEL = "project group chat"
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
#: A project started from a private chat opens its group chat with a seed
#: note: the agent's summary and the creator's own request, quoted as typed.
SEED_KIND = "seed"
SEED_MAX_TURNS = 5
SEED_QUOTE_CHARS = 4000
SEED_SUMMARY_CHARS = 600
SEED_DIGEST_CHARS = 1200

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
_CATCH_UP_COUNT_RE = re.compile(r"^" + re.escape(CATCH_UP_HEADER) + r" (\d{1,6}) ", re.MULTILINE)


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
        # The last one: inlined file text comes before the typed turn, so a
        # file that holds an ``[app context:`` line cannot end the file early.
        ctx = content.rfind("\n\n[app context:")
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
    """Profiles *user_id* is actively enrolled in (suspended ones excluded)."""
    return set(await projects_api._enrolled_profiles(user_id))


async def _display_name(user_id: str) -> Optional[str]:
    try:
        from hermes_cli.source_registry import display_name_for

        return await display_name_for(user_id)
    except Exception:  # noqa: BLE001 - a missing name falls back to the id
        return None


def _member_roles(project) -> dict[str, str]:
    with projects_db.connect_closing() as conn:
        roles = {
            m["user_id"]: m.get("role") or "member"
            for m in projects_db.get_project_members(conn, project.id)
        }
    if project.owner_user_id:
        roles[project.owner_user_id] = "lead"
    return roles


def _can_post(project, role, principal) -> bool:
    """Who may add to the group chat: its leads and members (the project's
    creator included). Viewers only read; an instance admin who is not on
    the project has no turns the other members could see, so no post either."""
    return role in ("lead", "member") or project.owner_user_id == principal.user_id


Spans = dict[str, list[tuple[float, float]]]
_ALWAYS = [(float("-inf"), float("inf"))]


def _post_spans(project, roles: dict[str, str]) -> Spans:
    """When each person could post in the group chat: as a lead or member
    (the project's creator always). Someone made a viewer or taken off the
    project keeps what they posted before; nothing after it shows."""
    with projects_db.connect_closing() as conn:
        changes = projects_db.get_member_changes(conn, project.id)
    history: dict[str, list[tuple[Optional[str], float]]] = {}
    for user, role, at in changes:
        history.setdefault(user, []).append((role, at))
    spans: Spans = {}
    for user in set(roles) | set(history):
        events = history.get(user)
        if user == project.owner_user_id:
            spans[user] = _ALWAYS
            continue
        if not events:
            # On the project from before changes were recorded.
            spans[user] = _ALWAYS if roles.get(user) in ("lead", "member") else []
            continue
        out: list[tuple[float, float]] = []
        start: Optional[float] = None
        for role, at in events:
            if role in ("lead", "member"):
                if start is None:
                    start = at
            elif start is not None:
                out.append((start, at))
                start = None
        if start is not None:
            out.append((start, float("inf")))
        spans[user] = out
    return spans


def _could_post(spans: Spans, user: Optional[str], at: float) -> bool:
    return any(a <= at < b for a, b in spans.get(user or "", ()))


def _members_and_spans(project) -> tuple[dict[str, str], Spans]:
    roles = _member_roles(project)
    return roles, _post_spans(project, roles)


async def _group(project, role, principal) -> tuple[dict[str, set[str]], dict[str, str], Spans]:
    """Who the group chat spans: each person's active profiles, their names,
    and when each could post (what they sent then is shown).

    Members (any role, viewers included), the project's creator and instance
    admins see everyone's turns, former members' earlier ones included;
    anybody else who can read the project sees only their own.
    """
    caller = principal.user_id
    roles, spans = await asyncio.to_thread(_members_and_spans, project)
    ids = {caller}
    if caller in roles or projects_api._instance_admin(principal):
        ids |= set(roles) | set(spans)
    spans = {u: s for u, s in spans.items() if u in ids}
    people = sorted(ids)
    profiles, names = await asyncio.gather(
        asyncio.gather(*(_chat_profiles(u) for u in people)),
        asyncio.gather(*(_display_name(u) for u in people)),
    )
    enrolled = dict(zip(people, profiles))
    shown = {u: (n or u) for u, n in zip(people, names)}
    if getattr(principal, "display", None):
        shown[caller] = str(principal.display)
    return enrolled, {u: _short(n, 60) for u, n in shown.items()}, spans


def _chat_links(
    project_id: str, user_id: Optional[str] = None, label: str = GROUP_LABEL
) -> list[dict]:
    """Group-chat links (or *label*'s), oldest first (each person's canonical
    one leads); only *user_id*'s when given."""
    with projects_db.connect_closing() as conn:
        rows = projects_db.get_project_links(conn, project_id, kind=LINK_KIND)
    mine = [
        r
        for r in rows
        if r.get("label") == label and (user_id is None or r.get("added_by") == user_id)
    ]
    return sorted(mine, key=lambda r: (r.get("added_at") or 0, r.get("ref") or ""))


def _session_chain(db, sid: str) -> list[str]:
    """The conversation's id and, once compression forked it, its continuation."""
    chain = [sid]
    tail = db.resolve_resume_session_id(sid)
    if tail and tail != sid:
        chain.append(tail)
    return chain


def _session_rows(db, sid: str) -> list[dict]:
    """A conversation's visible turns: user/assistant rows and each steer
    delivered inside a tool result, as the person's own row."""
    rows: list[dict] = []
    for part in _session_chain(db, sid):
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
    return rows


def _group_sessions(links: list[dict], enrolled: dict[str, set[str]]) -> list[dict]:
    """Each linked conversation whose linker owns it and is still in the
    group and actively enrolled in its profile, with its visible turns."""
    out: list[dict] = []
    for link in links:
        person = link.get("added_by")
        profile = link.get("profile") or "default"
        if person not in enrolled or profile not in enrolled[person]:
            continue
        try:
            db = _session_db(profile)
        except HTTPException:
            continue
        try:
            sid = db.resolve_session_id(link["ref"])
            if not sid or db.session_owner_user_id(sid) != person:
                continue
            out.append(
                {
                    "profile": profile,
                    "person": person,
                    "session_id": sid,
                    "linked_at": link.get("added_at"),
                    "parts": _session_chain(db, sid),
                    "messages": _session_rows(db, sid),
                }
            )
        except Exception:  # noqa: BLE001 - one unreadable profile never blanks the chat
            logger.warning("project chat: reading %s/%s failed", profile, link.get("ref"), exc_info=True)
        finally:
            db.close()
    return out


def _owned_sessions(links: list[dict], user_id: str, enrolled: set[str]) -> list[dict]:
    """:func:`_group_sessions` for one person."""
    return _group_sessions(links, {user_id: enrolled})


def _private_sessions(project_id: str, user_id: str, enrolled: set[str]) -> list[dict]:
    """*user_id*'s project chats from before the group chat: shown to them
    only, read-only, never in anyone's catch-up."""
    group = {link["ref"] for link in _chat_links(project_id, user_id)}
    old = [link for link in _chat_links(project_id, user_id, CHAT_LABEL) if link["ref"] not in group]
    return [{**s, "private": True} for s in _owned_sessions(old, user_id, enrolled)]


def _seed_view(r: dict, viewer: Optional[str]) -> Optional[dict]:
    """A seed note's summary and quotes; the link back to the private chat
    it came from only for its creator (whose chat it is)."""
    if r.get("kind") != SEED_KIND:
        return None
    try:
        meta = json.loads(r.get("meta") or "{}")
    except (TypeError, ValueError):
        meta = {}
    seed = {
        "summary": str(meta.get("summary") or ""),
        "quotes": [
            {"text": str(q.get("text") or ""), "timestamp": q.get("timestamp")}
            for q in meta.get("quotes") or []
            if isinstance(q, dict)
        ],
    }
    origin = meta.get("origin") or {}
    if viewer and viewer == r["user_id"] and origin.get("session_id"):
        sid = _current_chat_id(origin.get("profile") or "", origin["session_id"])
        query = urlencode({"session": sid, "profile": origin.get("profile") or ""})
        seed["origin"] = {"ref": origin.get("ref"), "url": f"/chat?{query}"}
    return seed


def _current_chat_id(profile: str, sid: str) -> str:
    """*sid*'s conversation as the chat list shows it: once compression
    continued it, the continuation's id."""
    try:
        db = _session_db(profile)
    except Exception:  # noqa: BLE001 - the stored id still names it
        return sid
    if db is None:
        return sid
    try:
        return db.get_compression_tip(sid) or sid
    except Exception:  # noqa: BLE001
        return sid
    finally:
        db.close()


def _member_notes(project_id: str, spans: Spans, viewer: Optional[str] = None) -> list[dict]:
    """The members-only messages ("Ask agent" off) sent while their sender
    could post, and the seed note of a project started from a chat."""
    with projects_db.connect_closing() as conn:
        rows = projects_db.get_chat_messages(conn, project_id)
    out = []
    for r in rows:
        if not _could_post(spans, r["user_id"], float(r["created_at"])):
            continue
        note = {
            "id": f"m{r['id']}",
            "role": "user",
            "content": r["content"],
            "timestamp": float(r["created_at"]),
            "person": r["user_id"],
            "member_only": True,
        }
        if r.get("kind"):
            note["kind"] = r["kind"]
        if r.get("meta"):
            try:
                note["meta"] = json.loads(r["meta"])
            except (TypeError, ValueError):
                pass
        seed = _seed_view(r, viewer)
        if seed is not None:
            note["seed"] = seed
        out.append(note)
    return out


def _quote(text: str) -> str:
    """Verbatim (line breaks kept), only capped."""
    text = text.strip()
    return text if len(text) <= SEED_QUOTE_CHARS else text[: SEED_QUOTE_CHARS - 1].rstrip() + "…"


def _without_ref_block(text: str) -> str:
    """Drop the ``[Referenced items]`` block appended to a typed turn."""
    at = text.rfind("\n\n" + ref_mentions.BLOCK_HEADER + "\n")
    if at < 0:
        return text
    tail = text[at + 2 :].splitlines()[1:]
    return text[:at] if all(line.startswith("- ") for line in tail if line) else text


def _without_attachment_links(text: str) -> str:
    """Drop the trailing links agent-home appends for each uploaded file."""
    lines = text.rstrip().split("\n")
    cut = len(lines)
    while cut:
        link = _LINK_LINE_RE.match(lines[cut - 1]) or _OLD_LINK_LINE_RE.match(lines[cut - 1])
        if not link or not _MEDIA_REF_RE.fullmatch(link.group(1)):
            break
        cut -= 1
    return text if cut == len(lines) else "\n".join(lines[:cut])


def request_turns(db, sid: str, count: int) -> list[dict]:
    """The conversation owner's own last *count* messages, as typed: never
    an agent reply, an attachment's text or injected context."""
    turns = []
    for r in _session_rows(db, sid):
        if r["role"] != "user":
            continue
        text = r["content"] if r.get("sent_while_working") else typed_text(r["content"])
        text = _without_attachment_links(_without_ref_block(text)).strip()
        if text:
            turns.append({"text": _quote(text), "timestamp": r["timestamp"]})
    return turns[-count:] if count > 0 else []


def seed_text(name: str, summary: str, quotes: list[dict]) -> str:
    """The seed note as plain text: what the catch-up digest quotes."""
    lines = [f"Started from {name}'s private chat. {summary}".rstrip()]
    lines.append(f"{name}'s original request:")
    for q in quotes:
        lines.extend(f"> {line}" for line in q["text"].splitlines() or [""])
    return "\n".join(lines)


def chat_request(*, profile: str, session_id: str, user_id: str, count: int) -> dict:
    """What a project started in chat *session_id* quotes: its owner's last
    *count* messages. Refused unless *user_id* owns that chat, and for a
    chat that is already a project's chat (its turns belong to that project)."""
    if not 1 <= count <= SEED_MAX_TURNS:
        raise ValueError(f"quote 1 to {SEED_MAX_TURNS} of your messages")
    db = _session_db(profile)
    if db is None:
        raise ValueError(f"no chats on profile {profile!r}")
    try:
        if db.get_session(session_id) is None:
            raise ValueError("this chat is not stored yet")
        if db.session_owner_user_id(session_id) != user_id:
            raise PermissionError("only the chat's owner can quote it")
        with projects_db.connect_closing() as conn:
            # Every segment, back to before compression: any one may be the
            # id a project chat was published under.
            chain = {
                *db._session_lineage_root_to_tip(session_id),  # noqa: SLF001
                *_session_chain(db, session_id),
            }
            if any(projects_db.conversation_in_project_chat(conn, sid) for sid in chain):
                raise ValueError("this chat is a project chat")
        quotes = request_turns(db, session_id, count)
        ref = None
        try:
            from hermes_cli import chat_refs

            ref = chat_refs.ref_for_session(db, session_id, profile)
        except Exception:  # noqa: BLE001 - the ref is only a label
            logger.debug("project seed: no chat ref", exc_info=True)
    finally:
        db.close()
    if not quotes:
        raise ValueError("no messages of yours to quote in this chat")
    return {
        "quotes": quotes,
        "origin": {"profile": profile, "session_id": session_id, "ref": ref},
    }


def write_seed(project, *, user_id: str, name: str, summary: str, request: dict) -> dict:
    """Open *project*'s group chat with the seed note (before any proposal,
    so the v1 card lands under it)."""
    summary = _short(summary, SEED_SUMMARY_CHARS)
    with projects_db.connect_closing() as conn:
        row = projects_db.add_chat_message(
            conn,
            project_id=project.id,
            user_id=user_id,
            content=seed_text(name, summary, request["quotes"]),
            kind=SEED_KIND,
            meta={"summary": summary, **request},
        )
    return row


def merge_timeline(
    sessions: list[dict], notes: list[dict] = (), names: Optional[dict[str, str]] = None
) -> list[dict]:
    """Every session's turns and every members-only note in time order, each
    labelled with its person and (for agent turns) its profile."""
    names = names or {}
    merged: list[dict] = []
    for s in sessions:
        for m in s["messages"]:
            row = {**m, "profile": s["profile"], "session_id": s["session_id"]}
            if s.get("person"):
                row["person"] = s["person"]
            if s.get("private"):
                row["private"] = True
            if m["role"] == "user":
                shown, meta = split_block(m["content"])
                row["content"] = shown
                row["typed"] = m["content"] if m.get("sent_while_working") else typed_text(m["content"])
                row.update(meta)
            merged.append(row)
    for n in notes:
        merged.append({**n, "profile": None, "session_id": None, "typed": n["content"]})
    for row in merged:
        if row.get("person"):
            row["person_name"] = names.get(row["person"], row["person"])
    # Stable: rows of one session keep their stored order on a timestamp tie.
    merged.sort(key=lambda r: (r["timestamp"], r["session_id"] or ""))
    return merged


def missed_turns(
    timeline: list[dict], session_id: str, prepares: Iterable[tuple[float, int]] = ()
) -> list[dict]:
    """Everything in the group chat that *session_id* has not been sent yet:
    other members' messages and other conversations' replies after the
    catch-up of its last sent turn.

    *prepares* are ``(snapshot time, digest size)`` of its prepared turns. A
    sent turn's digest covers the chat up to the snapshot of the prepare just
    before it, so anything posted while that turn ran still reaches the next
    one. A prepared digest the turn does not carry (the send became a steer
    or was dropped) delivered nothing. With no prepare on record, the turn's
    own time stands in.
    """
    sent = sorted(
        (r["timestamp"], int(r.get("catch_up") or 0))
        for r in timeline
        if r["session_id"] == session_id and r["role"] == "user" and not r.get("sent_while_working")
    )
    marks = sorted(prepares)
    cutoff = None
    previous = float("-inf")
    for at, carried in sent:
        mark = next((m for m in reversed(marks) if previous < m[0] <= at), None)
        if mark is None:
            cutoff = at
        elif carried or not mark[1]:
            cutoff = mark[0]
        previous = at
    return [
        r
        for r in timeline
        if r["session_id"] != session_id
        and not r.get("private")
        and (cutoff is None or r["timestamp"] > cutoff)
    ]


def _who(r: dict) -> str:
    name = r.get("person_name") or r.get("person") or "the user"
    if r.get("member_only"):
        return f"{name} → members"
    if r["role"] == "user":
        return f"{name} → {r['profile']}"
    return f"{r['profile']} → {name}"


def catch_up_digest(missed: list[dict]) -> str:
    """A short, deterministic digest of *missed* (newest turns kept)."""
    if not missed:
        return ""
    shown = missed[-CATCH_UP_MAX_TURNS:]
    lines = [
        f"{CATCH_UP_HEADER} {len(missed)} messages in this project chat "
        f"since your last turn"
        + (f" (the last {len(shown)} below)" if len(shown) < len(missed) else "")
        + ":"
    ]
    for r in shown:
        said = r.get("typed", r["content"]) if r["role"] == "user" else r["content"]
        limit = SEED_DIGEST_CHARS if r.get("seed") else CATCH_UP_TURN_CHARS
        lines.append(f"- {_who(r)}: {_short(said, limit) or '(attachments)'}")
    return "\n".join(lines)


def project_context(conn, project, user_id: Optional[str] = None) -> str:
    """The brief, the active playbook and the last run's retro, bounded;
    with *user_id*, how to co-create the plan in that person's draft."""
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
    proposed = [
        r for r in projects_db.list_playbook_revs(conn, project.id)
        if not r.get("active") and (not pb or r["rev"] > pb["rev"])
    ]
    if proposed:
        lines.append(
            "Proposed, not active yet: "
            + ", ".join(f"v{r['rev']} ({len(r.get('steps') or [])} steps)" for r in proposed[:3])
        )
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
    if user_id:
        lines.append(
            "To shape the plan with this person, edit their working draft: "
            f"`hermes projects --actor {user_id} playbook {project.slug} draft "
            "show|set|patch-step|remove-step`; they press Save to propose it. "
            "Offer 2-3 approaches as a fenced `options` block (projects skill)."
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


def _sent_while_posting(
    rows: list[dict], spans: list[tuple[float, float]], queued: list[tuple] = ()
) -> list[dict]:
    """The turns asked while their person could post, each with its reply.

    A turn started from queued input (*queued*: ``(started, sent)``, the
    start falling between the previous turn and this one) was asked when its
    input was sent, not when it ran; merged steers, at each one's time."""
    out: list[dict] = []
    keep = False
    previous = float("-inf")
    for m in rows:
        if m["role"] == "user":
            asked = [m["timestamp"]]
            if not m.get("sent_while_working"):
                sent = [s for launched, s in queued if previous < launched <= m["timestamp"]]
                previous = m["timestamp"]
                asked = sent or asked
            keep = all(any(a <= t < b for a, b in spans) for t in asked)
        if keep:
            out.append(m)
    return out


def _group_sessions_of(project, enrolled: dict[str, set[str]], spans: Spans) -> list[dict]:
    sessions = _group_sessions(_chat_links(project.id), enrolled)
    with projects_db.connect_closing() as conn:
        queued = {
            s["session_id"]: projects_db.get_chat_inputs(conn, s.get("parts") or [s["session_id"]])
            for s in sessions
        }
    out = []
    for s in sessions:
        rows = _sent_while_posting(
            s["messages"], spans.get(s["person"], []), queued[s["session_id"]]
        )
        if rows:
            out.append({**s, "messages": rows})
    return out


def _group_timeline(
    project, enrolled: dict[str, set[str]], names: dict[str, str], spans: Spans
) -> list[dict]:
    sessions = _group_sessions_of(project, enrolled, spans)
    return merge_timeline(sessions, _member_notes(project.id, spans), names)


def _timeline_sync(
    project,
    user_id: str,
    enrolled: dict[str, set[str]],
    names: dict[str, str],
    spans: Spans,
) -> dict:
    sessions = _group_sessions_of(project, enrolled, spans)
    sessions += _private_sessions(project.id, user_id, enrolled.get(user_id, set()))
    timeline = merge_timeline(sessions, _member_notes(project.id, spans, user_id), names)
    since = timeline[0]["timestamp"] if timeline else None
    with projects_db.connect_closing() as conn:
        proposals = proposals_since(conn, project.id, since)
    latest: dict[str, str] = {}
    for s in _owned_sessions(_chat_links(project.id, user_id), user_id, enrolled.get(user_id, set())):
        latest.setdefault(s["profile"], s["session_id"])
    last_profile = next(
        (r["profile"] for r in reversed(timeline) if r.get("person") == user_id and r["profile"]),
        None,
    )
    people = sorted({r["person"] for r in timeline if r.get("person")} | {user_id})
    return {
        "me": user_id,
        "people": [{"user_id": u, "name": names.get(u, u)} for u in people],
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
    project, role, _profiles, principal = await _require_read(request)
    enrolled, names, spans = await _group(project, role, principal)
    out = await asyncio.to_thread(
        _timeline_sync, project, principal.user_id, enrolled, names, spans
    )
    out["can_post"] = _can_post(project, role, principal)
    return out


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


def _visible_turns(db, sid: str) -> bool:
    return any(
        m.get("role") in ("user", "assistant")
        for m in db.get_messages(db.resolve_resume_session_id(sid) or sid)
    )


def _prepare_sync(
    project,
    user_id: str,
    enrolled: dict[str, set[str]],
    names: dict[str, str],
    spans: Spans,
    profile: str,
    session_id: str,
    message: str,
) -> dict:
    if profile not in enrolled.get(user_id, set()):
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
            # Joining the group chat must not publish an existing transcript:
            # an earlier private project chat or any other conversation.
            ref = db.resolve_session_id(session_id)
            private = {link["ref"] for link in _chat_links(project.id, user_id, CHAT_LABEL)}
            if ref in private or _visible_turns(db, ref):
                raise HTTPException(
                    status_code=409, detail="Start a new conversation for the group chat"
                )
            with projects_db.connect_closing() as conn:
                projects_db.add_project_link(
                    conn,
                    project_id=project.id,
                    kind=LINK_KIND,
                    profile=profile,
                    ref=ref,
                    label=GROUP_LABEL,
                    added_by=user_id,
                )
            links = _chat_links(project.id, user_id)
            # Two pages racing both link; the oldest link wins for both.
            sid = _canonical_sid(db, links, profile, user_id)
        empty = not _visible_turns(db, sid)
    finally:
        db.close()
    snapshot = time.time()
    with projects_db.connect_closing() as conn:
        prepares = projects_db.get_chat_prepares(conn, project.id, sid)
    missed = missed_turns(_group_timeline(project, enrolled, names, spans), sid, prepares)
    with projects_db.connect_closing() as conn:
        projects_db.add_chat_prepare(
            conn,
            project_id=project.id,
            session_id=sid,
            snapshot_at=snapshot,
            digest_size=len(missed),
        )
    digest = catch_up_digest(missed)
    context = ""
    if empty:
        with projects_db.connect_closing() as conn:
            context = project_context(conn, project, user_id)
    return {
        "session_id": sid,
        "message": compose_turn(project, _project_ref(project), message, context=context, digest=digest),
        "seeded": bool(context),
        "catch_up": len(missed),
    }


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    return body if isinstance(body, dict) else {}


@router.post("/{slug}/chat/prepare")
async def chat_prepare(request: Request) -> dict[str, Any]:
    project, role, _profiles, principal = await _require_write(request, judgement=True)
    projects_api_refuse_archived(project)
    body = await _body(request)
    profile = str(body.get("profile") or "default").strip() or "default"
    session_id = str(body.get("session_id") or "").strip()
    message = str(body.get("message") or "")
    if not session_id or not message.strip():
        raise HTTPException(status_code=422, detail="session_id and message are required")
    if len(message) > MESSAGE_MAX_CHARS * 5:
        raise HTTPException(status_code=413, detail="message is too long")
    _refuse_unless_poster(project, role, principal)
    enrolled, names, spans = await _group(project, role, principal)
    return await asyncio.to_thread(
        _prepare_sync,
        project,
        principal.user_id,
        enrolled,
        names,
        spans,
        profile,
        session_id,
        message,
    )


def _post_note_sync(project, user_id: str, person: str, content: str) -> dict:
    with projects_db.connect_closing() as conn:
        row = projects_db.add_chat_message(
            conn, project_id=project.id, user_id=user_id, person=person, content=content
        )
    return {
        "id": f"m{row['id']}",
        "role": "user",
        "content": row["content"],
        "timestamp": float(row["created_at"]),
        "person": user_id,
        "person_name": person,
        "member_only": True,
        "profile": None,
        "session_id": None,
    }




@router.post("/{slug}/chat/progress")
async def chat_post_progress(request: Request) -> dict[str, Any]:
    """Record an agent working-progress snapshot (mockup "Working": the
    panel's live checklist). ``items`` = [{task, state: done|working|todo,
    detail?}]; each call replaces the previous checklist visually — the
    timeline keeps them all."""
    project, role, _profiles, principal = await _require_write(request, judgement=True)
    projects_api_refuse_archived(project)
    body = await _body(request)
    items = body.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items are required")
    cleaned = []
    for it in items:
        if not isinstance(it, dict) or not it.get("task"):
            raise HTTPException(status_code=422, detail="each item needs a task")
        cleaned.append({
            "task": str(it["task"])[:200],
            "state": it.get("state") if it.get("state") in ("done", "working", "todo") else "todo",
            "detail": str(it["detail"])[:300] if it.get("detail") else None,
        })

    def _post_sync() -> dict:
        with projects_db.connect_closing() as conn:
            return projects_db.add_chat_message(
                conn,
                project_id=project.id,
                user_id=principal.user_id,
                person=str(body.get("person") or "agent"),
                content=str(body.get("title") or "Working…"),
                kind="agent_progress",
                meta={"items": cleaned},
            )

    return await asyncio.to_thread(_post_sync)


@router.post("/{slug}/chat/messages")
async def chat_post_message(request: Request) -> dict[str, Any]:
    """A message to the other members with the agent left out ("Ask agent"
    off). No model call: each member's conversations see it in their next
    catch-up."""
    project, role, _profiles, principal = await _require_write(request, judgement=True)
    projects_api_refuse_archived(project)
    _refuse_unless_poster(project, role, principal)
    content = str((await _body(request)).get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=422, detail="content is required")
    if len(content) > MESSAGE_MAX_CHARS:
        raise HTTPException(status_code=413, detail="message is too long")
    person = _short(
        getattr(principal, "display", None)
        or await _display_name(principal.user_id)
        or principal.user_id,
        60,
    )
    return await asyncio.to_thread(_post_note_sync, project, principal.user_id, person, content)


def _refuse_unless_poster(project, role, principal) -> None:
    if not _can_post(project, role, principal):
        raise HTTPException(status_code=403, detail="Join the project to post in its chat")


def projects_api_refuse_archived(project) -> None:
    from hermes_cli.projects_api import _refuse_if_archived

    _refuse_if_archived(project, "chatting in it")


_MEDIA_REF_RE = re.compile(r"/api/chat/media\?path=([^\s)\"'&<>\]]+)")
# One link per line. agent-home escapes ``\ [ ] ( )`` in a file name; turns
# stored before that may hold any brackets, but never ``](`` (a second link).
_LINK_LINE_RE = re.compile(r"^!?\[(?:\\.|(?!\]\()[^\\])*\]\(([^)\s]+)\)$")
_OLD_LINK_LINE_RE = re.compile(r"^!?\[(?:(?!\]\().)*\]\(([^)\s]+)\)$")


def _attached_refs(content: str) -> list[str]:
    """The media paths in a turn's trailing block of attachment links (what
    agent-home appends for each attached file), never ones quoted in the text
    or in an attached document's inlined contents."""
    from urllib.parse import unquote

    from hermes_cli.ref_mentions import BLOCK_HEADER

    content = (content or "").rstrip()
    # The descriptions of short refs (``P12``) the server appends after them.
    cut = content.rfind(f"\n\n{BLOCK_HEADER}\n")
    if cut >= 0 and all(
        line.startswith("- ") for line in content[cut:].split("\n")[3:]
    ):
        content = content[:cut]
    lines = content.split("\n")
    refs: list[str] = []
    while lines:
        link = _LINK_LINE_RE.match(lines[-1]) or _OLD_LINK_LINE_RE.match(lines[-1])
        if not link:
            break
        lines.pop()
        ref = _MEDIA_REF_RE.fullmatch(link.group(1))
        if ref:
            refs.append(unquote(ref.group(1)))
    return refs


def _shares_media_sync(project, enrolled, names, spans: Spans, path: str) -> bool:
    from hermes_cli.file_registry import agent_home_slug

    owner = path.split("/", 1)[0]
    for r in _group_timeline(project, enrolled, names, spans):
        if r["role"] != "user" or not r.get("person") or agent_home_slug(r["person"]) != owner:
            continue
        if path in _attached_refs(r.get("content") or ""):
            return True
    return False


@router.get("/{slug}/chat/media")
async def chat_media(request: Request) -> dict[str, Any]:
    """Whether the caller may open the file at ``path``: one its sender
    attached in this project's group chat, for anyone on the project
    (viewers included) or an instance admin."""
    project, role, _profiles, principal = await _require_read(request)
    path = str(request.query_params.get("path") or "")
    if not path:
        raise HTTPException(status_code=422, detail="path is required")
    on_project = role in ("lead", "member", "viewer") or project.owner_user_id == principal.user_id
    if not (on_project or projects_api._instance_admin(principal)):
        raise HTTPException(status_code=403, detail="not permitted")
    enrolled, names, spans = await _group(project, role, principal)
    if not await asyncio.to_thread(_shares_media_sync, project, enrolled, names, spans, path):
        raise HTTPException(status_code=403, detail="not permitted")
    return {"path": path, "shared": True}
