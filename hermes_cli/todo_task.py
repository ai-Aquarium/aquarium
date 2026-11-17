"""Start task: a system to-do becomes the user's one-off project.

Two perspectives on one "to-do" (Leo, 2026-11-17):

* the **system to-do** — what triage noticed in a message (``hermes todos``,
  :mod:`hermes_cli.todo_store`); it stays a suggestion until a person acts;
* the **user to-do** — "I want to do X" — which is a task, and a task in
  Aquarium is a one-off project (Projects Task mode).

Starting a suggested to-do therefore creates a one-off project in Manual mode
through the same path as Task mode's Start task
(:func:`hermes_cli.projects_api.create_task_project_sync` +
``_start_quick_task_job``), with the source message as the project's brief
and an ``arrival`` link. The project row records the to-do
(``projects.todo_profile`` / ``todo_id``, unique), so starting it again
returns the same project, and the to-do closes when the project is done.

Replies are drafted in the project (``hermes projects propose-send``), which
defaults the route to the message's own channel, recipient and account
(:func:`hermes_cli.todo_outbound.target_from_arrival`); a person approves on
the card, the account check of :func:`hermes_cli.reply_accounts.check_reply`
runs at send time, and the sent reply is recorded on the to-do's history.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Awaitable, Callable, Mapping, Optional, TypeVar

log = logging.getLogger(__name__)

_T = TypeVar("_T")

#: A started to-do runs in Manual mode ("Every step"): nothing is promoted
#: without a person, whatever the plan says.
DEFAULT_AUTONOMY = "manual"

MAX_SOURCE_CHARS = 4_000
MAX_CARRIED_DRAFT_CHARS = 8_000
MAX_REQUEST_CHARS = 8_000

_START_LOCK = threading.Lock()


class TodoTaskError(Exception):
    """A start the caller asked for that cannot be honoured."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def reply_route_from(arrival: Optional[Mapping[str, Any]]) -> Optional[dict[str, Any]]:
    """The C4 reply route of the source message, or None without one."""
    if not arrival or not arrival.get("id"):
        return None
    from hermes_cli.todo_outbound import target_from_arrival

    route = {k: v for k, v in target_from_arrival(arrival).items() if v}
    if not route.get("channel") or not route.get("target"):
        return None
    route["arrival_id"] = str(arrival["id"])
    return route


def _source_block(arrival: Mapping[str, Any]) -> str:
    who = (
        str(arrival.get("sender_name") or "").strip()
        or str(arrival.get("sender_id") or "").strip()
    )
    head = ["Source message"]
    meta = [str(arrival.get("surface") or "").strip()]
    if who:
        meta.append(f"from {who}")
    subject = str(arrival.get("subject") or "").strip()
    if subject:
        meta.append(f"subject “{subject}”")
    meta = [m for m in meta if m]
    if meta:
        head.append(f" ({', '.join(meta)})")
    body = str(arrival.get("body") or "")[:MAX_SOURCE_CHARS]
    return "".join(head) + ":\n" + body


def task_request_text(
    todo,
    arrival: Optional[Mapping[str, Any]],
    *,
    reply_route: Optional[dict] = None,
    request: Optional[str] = None,
) -> str:
    """The project brief a started to-do carries: what it asks, the message
    behind it, any draft an earlier "Work on this" left, and how to reply.

    ``request`` is the person's own wording of what to do (the Start task
    sheet's editable text); it replaces the to-do's title / description
    lead, and the rest is still appended."""
    if request and request.strip():
        parts = [request.strip()]
    else:
        parts = [todo.title]
        if todo.description:
            parts.append(todo.description)
        if todo.source_note:
            parts.append(f"(From {todo.source_note})")
    if arrival and arrival.get("body"):
        parts.append("---\n" + _source_block(arrival))
    work = todo.work_result or {}
    for key, label in (("draft_text", "Earlier draft"), ("reply_text", "Earlier reply draft")):
        text = str(work.get(key) or "").strip()
        if text:
            parts.append(f"---\n{label}:\n{text[:MAX_CARRIED_DRAFT_CHARS]}")
    if reply_route:
        parts.append(
            "---\nReplying: when the work calls for a reply to whoever sent the "
            "source message, draft it in their language and propose it with "
            "`hermes projects propose-send --body-file <file>` — the channel, "
            "recipient and account default to the message this task came from. "
            "Nothing is sent until a person approves it."
        )
    return "\n\n".join(parts)


async def in_profile(
    principal, profile: str, fn: Callable[[Any], Awaitable[_T]]
) -> Optional[_T]:
    """Run ``fn(principal)`` in ``profile``'s scope, as the caller's own
    enrolment there (never that profile's owner); None when the caller has
    none or the profile is not served here."""
    from hermes_cli import profile_refs

    if profile == profile_refs.current_profile():
        return await fn(principal)
    home = profile_refs._profile_home(profile)  # noqa: SLF001 - same package
    if home is None:
        return None
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        who = await profile_refs._principal_here(principal.user_id)  # noqa: SLF001
        if who is None:
            return None
        return await fn(who)


def _todo_store():
    from hermes_cli.todo_store import default_store

    return default_store()


def _create_or_find_sync(
    principal,
    todo,
    *,
    profile: str,
    request_text: str,
    host_profile: str,
    autonomy: str,
    reply_route: Optional[dict],
    arrival: Optional[Mapping[str, Any]],
) -> tuple[Any, bool]:
    """``(project, created)``: the to-do's project, created when it has none."""
    from hermes_cli import projects_api, projects_db

    with _START_LOCK:
        with projects_db.connect_closing() as conn:
            existing = projects_db.project_for_todo(conn, profile=profile, todo_id=todo.id)
        if existing is not None:
            return existing, False
        project = projects_api.create_task_project_sync(
            principal, request_text, host_profile, autonomy, title=todo.title
        )
        with projects_db.connect_closing() as conn:
            if not projects_db.set_project_todo(
                conn, project.id, profile=profile, todo_id=todo.id, reply_route=reply_route
            ):
                # Another process won the race: keep its project, drop ours.
                projects_db.delete_project(conn, project.id)
                found = projects_db.project_for_todo(conn, profile=profile, todo_id=todo.id)
                if found is None:
                    raise TodoTaskError(500, "the task project could not be recorded")
                return found, False
            projects_db.add_project_link(
                conn, project_id=project.id, kind="todo", profile=profile,
                ref=todo.id, label=todo.title[:200], added_by=principal.user_id,
            )
            if arrival and arrival.get("id"):
                label = (
                    str(arrival.get("subject") or "").strip()
                    or str(arrival.get("sender_name") or arrival.get("sender_id") or "")
                    or "Source message"
                )
                projects_db.add_project_link(
                    conn, project_id=project.id, kind="arrival", profile=profile,
                    ref=str(arrival["id"]), label=label[:200], added_by=principal.user_id,
                )
            return projects_db.get_project(conn, project.id), True


async def start_todo_as_project(
    store,
    principal,
    todo,
    *,
    arrival: Optional[Mapping[str, Any]],
    host_profile: str,
    autonomy: str = DEFAULT_AUTONOMY,
    check_plan_first: bool = False,
    request: Optional[str] = None,
) -> dict[str, Any]:
    """Start ``todo`` as a one-off project, or return the one it already is.

    The caller is a verified human (``_require_human``) who can read the
    to-do in the serving profile. A second start of the same to-do returns
    the existing project and starts nothing.
    """
    from hermes_cli import profile_refs, projects_api

    profile = profile_refs.current_profile()
    actor = f"user:{principal.user_id}"
    reply_route = reply_route_from(arrival)
    request_text = task_request_text(
        todo, arrival, reply_route=reply_route, request=request
    )

    from hermes_cli import projects_db

    def _find():
        with projects_db.connect_closing() as conn:
            return projects_db.project_for_todo(conn, profile=profile, todo_id=todo.id)

    if await asyncio.to_thread(_find) is None and not todo.is_live:
        raise TodoTaskError(409, f"this to-do is already {todo.stage}")

    try:
        project, created = await asyncio.to_thread(
            _create_or_find_sync,
            principal,
            todo,
            profile=profile,
            request_text=request_text,
            host_profile=host_profile,
            autonomy=autonomy,
            reply_route=reply_route,
            arrival=arrival,
        )
    except ValueError as exc:
        raise TodoTaskError(422, str(exc)) from exc

    draft = None
    if created:
        if todo.stage != "working":
            try:
                todo = await store.set_stage(
                    principal, todo.id, "working",
                    outcome=f"Started as project {project.slug}", actor=actor,
                )
            except Exception as exc:  # noqa: BLE001 - the project is the work now
                log.warning("todo_task: stage for %s failed (%s)", todo.id, exc)
        accessible = await projects_api._accessible_profiles(principal, project)  # noqa: SLF001
        draft = projects_api._start_quick_task_job(  # noqa: SLF001
            project, request_text, principal, check_plan_first, accessible
        )
    todo_payload = (
        await profile_refs.attach(profile_refs.TODO, [todo.as_dict()], created_key="created_at")
    )[0]
    return {
        "created": created,
        "project": projects_api._project_payload(  # noqa: SLF001
            project, extra={"draft": draft, "check_plan_first": check_plan_first}
            if created else None,
        ),
        "todo": todo_payload,
    }


async def start_from_request(principal, todo_id: str, body: Mapping[str, Any]) -> dict[str, Any]:
    """The shared body of both Start-task routes (``POST /todos/{id}/start-task``
    and ``POST /projects/quick-task`` with ``from_todo``); the caller has
    already passed ``_require_human``. Body keys, all optional:
    ``host_profile`` (default: the serving profile), ``autonomy`` (default
    ``manual``), ``check_plan_first`` and ``request`` (the person's own
    wording, replacing the to-do's title/description in the brief)."""
    from hermes_cli import profile_refs
    from hermes_cli.projects_api import QUICK_TASK_AUTONOMY
    from hermes_cli.todos_api import _source_item, _store, _table_ready

    autonomy = str(body.get("autonomy") or DEFAULT_AUTONOMY).strip()
    if autonomy not in QUICK_TASK_AUTONOMY:
        raise TodoTaskError(
            422, f"autonomy must be one of {', '.join(QUICK_TASK_AUTONOMY)}"
        )
    host_profile = (
        str(body.get("host_profile") or "").strip() or profile_refs.current_profile()
    )
    request = body.get("request")
    if request is not None and not isinstance(request, str):
        raise TodoTaskError(422, "request must be a string")
    if request and len(request) > MAX_REQUEST_CHARS:
        raise TodoTaskError(422, f"request must be at most {MAX_REQUEST_CHARS} characters")
    store = _store()
    if not await _table_ready(store):
        raise TodoTaskError(404, "No such to-do")
    todo = await store.get(principal, todo_id)
    if todo is None:
        raise TodoTaskError(404, "No such to-do")
    arrival = await _source_item(principal, todo)
    return await start_todo_as_project(
        store,
        principal,
        todo,
        arrival=arrival,
        host_profile=host_profile,
        autonomy=autonomy,
        check_plan_first=bool(body.get("check_plan_first")),
        request=request or None,
    )


async def close_linked_todo(principal, project_id: str) -> Optional[dict[str, Any]]:
    """Close the to-do a done project was started from; best-effort.

    Read and written as the caller (their enrolment in the to-do's profile),
    so a to-do they cannot see stays as it is. Returns the closed to-do's
    payload, or None when there was nothing to close.
    """
    from hermes_cli import projects_db

    def _link():
        with projects_db.connect_closing() as conn:
            project = projects_db.get_project(conn, project_id)
            return project, projects_db.project_todo(conn, project_id)

    project, link = await asyncio.to_thread(_link)
    if project is None or link is None:
        return None

    async def _close(who):
        store = _todo_store()
        todo = await store.get(who, link["todo_id"])
        if todo is None or not todo.is_live:
            return None
        closed = await store.set_stage(
            who, todo.id, "done",
            outcome=f"Project {project.slug} done",
            actor=f"user:{principal.user_id}",
        )
        return closed.as_dict()

    try:
        return await in_profile(principal, link["profile"], _close)
    except Exception as exc:  # noqa: BLE001 - the project is done regardless
        log.warning("todo_task: closing the to-do of %s failed (%s)", project_id, exc)
        return None


def reply_defaults(project_id: Optional[str]) -> Optional[dict[str, Any]]:
    """The reply route and to-do of a project started from a to-do, for
    ``propose-send`` (sync; the card worker has no principal)."""
    if not project_id:
        return None
    from hermes_cli import projects_db

    with projects_db.connect_closing() as conn:
        link = projects_db.project_todo(conn, project_id)
    if link is None or not link.get("reply_route"):
        return None
    return link


async def _arrival(principal, reply_to: Mapping[str, Any]) -> Optional[dict[str, Any]]:
    arrival_id = str(reply_to.get("arrival_id") or "")
    if not arrival_id:
        return None

    async def _read(who):
        from hermes_cli.inbound_registry import default_registry

        item = await default_registry().get(who, arrival_id)
        return item.as_dict() if item is not None else None

    try:
        return await in_profile(principal, str(reply_to.get("profile") or ""), _read)
    except Exception as exc:  # noqa: BLE001 - check_reply still checks ownership
        log.debug("todo_task: source arrival unavailable (%s)", exc)
        return None


async def check_project_reply(principal, msg: Mapping[str, Any]) -> None:
    """The send-time account check for a project's reply to its source
    message — the same one ``todo_outbound.execute_proposal`` runs. Raises
    :class:`hermes_cli.reply_accounts.ReplyRefused`."""
    reply_to = msg.get("reply_to")
    if not isinstance(reply_to, Mapping):
        return
    from hermes_cli.reply_accounts import check_reply

    await check_reply(
        principal.user_id,
        str(msg.get("channel") or ""),
        str(msg.get("account") or "") or None,
        target=str(msg.get("target") or ""),
        arrival=await _arrival(principal, reply_to),
    )


async def record_project_reply(principal, msg: Mapping[str, Any], event: str) -> None:
    """Put a project reply's outcome on its to-do's history; a ``sent`` one
    is also what ``execute_proposal``'s replay guard refuses a second send
    of the old to-do proposal on."""
    reply_to = msg.get("reply_to")
    if not isinstance(reply_to, Mapping) or not reply_to.get("todo_id"):
        return

    async def _record(who):
        await _todo_store().record_outbound(
            who, str(reply_to["todo_id"]), event=event,
            channel=str(msg.get("channel") or ""), actor=f"user:{principal.user_id}",
        )

    try:
        await in_profile(principal, str(reply_to.get("profile") or ""), _record)
    except Exception as exc:  # noqa: BLE001 - the send already happened
        log.warning("todo_task: recording the reply on the to-do failed (%s)", exc)
