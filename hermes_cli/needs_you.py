"""Everything that is waiting on the caller, as one list.

Backs ``GET /api/needs-you`` (agent-home's landing "Needs you" panel and the
title/app badge). Every source the system can block on a human is folded
into ``NeedsYouEntry`` rows (``agent-home/src/types/landing.ts``):

* durable notifications (``NotificationStore.list_pending``) — project run
  checkpoints, budget stops, card waits, outgoing to-do actions, proactive
  asks;
* project state that has no notification row — pending card approvals,
  blocked cards, outputs awaiting acceptance, open clarify questions,
  drafted plans awaiting approval, and waiting runs when the notification
  store is unavailable;
* in-memory approvals — chat tool approvals (``tools.approval``) and
  webview actions (``WebviewSession.pending``);
* open profile suggestions;
* data dictionary drafts the caller may approve.

Triage raises to-dos and alerts per user-profile (FG-03 P5), so one arrival
routed to John@CFO and John@CMO lands as a notification in *each* profile's
store. Those notifications carry the arrival in their ``dedupe_key``
(``<base>|arrival:<surface>:<account>:<external id>``, see :func:`arrival_key`);
the route also collects them from the caller's other profiles, and
:func:`merge_arrivals` folds every row for one arrival into a single entry
whose id is the arrival key and whose ``context.profiles`` lists where it was
raised. :func:`claim_arrival_push` keeps it to one push per arrival per person
across profiles and channels.

Ids are ``<source>:<native id>`` and stable for the life of the wait, so the
client can tell what is new since it last looked. Row builders are pure;
the route does the I/O and scoping.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import quote, unquote, urlencode

logger = logging.getLogger(__name__)

SEVERITIES = ("blocking", "approval", "review", "fyi")
_SEVERITY_RANK = {s: i for i, s in enumerate(SEVERITIES)}
_PER_SOURCE_LIMIT = 100

SEVERITY_BY_SOURCE = {
    "project_checkpoint": "blocking",
    "budget": "blocking",
    "card_wait": "blocking",
    "chat_tool_approval": "blocking",
    "card_approval": "approval",
    "webview_approval": "approval",
    "plan_approval": "approval",
    "clarify": "approval",
    "output_acceptance": "review",
    "data_draft": "review",
    "data_schema": "review",
    "data_health": "blocking",
    "card_blocked": "review",
    "todo": "fyi",
    "profile_suggestion": "fyi",
    "pin_suggestion": "fyi",
    "source_claim": "approval",
}

#: Notification ``context`` keys copied onto the entry: the routed batch
#: (FG-03) a triage to-do/alert came from, for "Why this profile?".
ROUTING_KEYS = ("routing_source_id", "routing_batch_id")

# Sources whose producer already sends a Web Push (tagged) at the moment the
# wait begins; the poll-time push must not send a second one.
PUSHED_AT_ORIGIN = frozenset({"chat_tool_approval"})


def _ts(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, datetime):
        return value.timestamp()
    try:
        return float(value)
    except (TypeError, ValueError):
        pass
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return 0.0


def chat_href(session_id: str, profile: Optional[str]) -> str:
    params = {"session": session_id}
    if profile and profile != "default":
        params["profile"] = profile
    return "/chat?" + urlencode(params)


def project_href(slug: str, *rest: Any) -> str:
    return "/" + "/".join(
        ["projects", quote(slug, safe="")] + [quote(str(p), safe="") for p in rest]
    )


def _open_action(href: str, label: str = "Open") -> dict:
    return {"id": "open", "label": label, "style": "primary", "href": href}


def _post_action(
    action_id: str, label: str, style: str, endpoint: str,
    body: Optional[dict] = None,
) -> dict:
    action: dict = {
        "id": action_id, "label": label, "style": style,
        "method": "POST", "endpoint": endpoint,
    }
    if body is not None:
        action["body"] = body
    return action


def entry(
    *,
    id: str,
    source: str,
    title: str,
    href: str,
    created_at: Any,
    detail: Optional[str] = None,
    context: Optional[dict] = None,
    actions: Optional[list] = None,
    reversible: bool = False,
    notification_id: Optional[str] = None,
    severity: Optional[str] = None,
    i18n: Optional[dict] = None,
) -> dict:
    return {
        "id": id,
        "source": source,
        "severity": severity or SEVERITY_BY_SOURCE.get(source, "fyi"),
        "title": title,
        "detail": detail or None,
        "context": {k: v for k, v in (context or {}).items() if v is not None},
        "created_at": _ts(created_at),
        "href": href,
        "actions": actions if actions is not None else [_open_action(href)],
        "reversible": bool(reversible),
        "notification_id": notification_id,
        "i18n": i18n,
    }


def _m(key: str, **values: Any) -> dict:
    """One translatable part: agent-home renders ``needsYou.<key>`` with ``vars``."""
    return {"key": key, "vars": {k: v for k, v in values.items() if v is not None}}


def _title(key: str, **values: Any) -> dict:
    return {"title": [_m(key, **values)]}


# ---------------------------------------------------------------------------
# Durable notifications
# ---------------------------------------------------------------------------

_RUN_KIND_SOURCE = {
    "checkpoint": "project_checkpoint",
    "budget": "budget",
    "waiting_on_you": "card_wait",
}


def parse_project_key(dedupe_key: Optional[str]) -> Optional[dict]:
    """``proj:<slug>:run:<n>:<kind>[:<suffix>]`` → its parts, else ``None``.

    ``raise_approval`` builds the key; ``slug`` is a URL slug (no ``:``) so a
    plain split is exact. The suffix (a card id for ``waiting_on_you``, a
    step key for ``checkpoint``) may itself contain ``:``.
    """
    if not dedupe_key or not dedupe_key.startswith("proj:"):
        return None
    parts = dedupe_key.split(":", 5)
    if len(parts) < 5 or parts[2] != "run":
        return None
    try:
        run_no = int(parts[3])
    except ValueError:
        return None
    return {
        "slug": parts[1],
        "run_no": run_no,
        "kind": parts[4],
        "suffix": parts[5] if len(parts) > 5 else None,
    }


ARRIVAL_PREFIX = "arrival:"
_ARRIVAL_MARK = "|" + ARRIVAL_PREFIX
#: Dedupe-key base of the in-app alert a profile-scoped triage raises when it
#: escalates an arrival (``custom/shared/triage_handlers``).
TRIAGE_ALERT = "triage-alert"
#: ... and when a batch of a channel with no legacy triage (Telegram, FG-03
#: P6) could not be triaged at all and was only stored
#: (``triage-failed:<kind>:<batch id>``).
TRIAGE_FAILED = "triage-failed"
#: ... and the daily "too many asks, review your triage skills" warning
#: (``triage-ask-review:<profile>:<date>``, ``hermes_cli.triage_ask_review``).
TRIAGE_ASK_REVIEW = "triage-ask-review"


def triage_skills_href(profile: str) -> str:
    """Where a profile's triage skills are managed (Profile › My triage skills)."""
    return "/profiles/" + quote(profile or "default", safe="") + "/triage"


def arrival_key(surface: Any, account_id: Any, external_id: Any) -> str:
    """The stable key of one channel arrival, the same in every profile.

    ``arrival:<surface>:<account id>:<external id>``, each part
    percent-encoded so a ``:`` or ``|`` inside an id cannot shift the parts.
    """
    parts = (quote(str(p or ""), safe="") for p in (surface, account_id, external_id))
    return ARRIVAL_PREFIX + ":".join(parts)


def with_arrival(base: str, key: Optional[str]) -> str:
    """``base`` tagged with an arrival key (``base`` unchanged without one)."""
    return f"{base}|{key}" if key else base


def split_arrival(dedupe_key: Optional[str]) -> tuple[str, Optional[str]]:
    """``(base, arrival key or None)`` of a notification dedupe key."""
    base, sep, rest = (dedupe_key or "").partition(_ARRIVAL_MARK)
    return base, (ARRIVAL_PREFIX + rest) if sep and rest else None


def routing_context(source_id: Any, batch_id: Any) -> Optional[dict]:
    """``{"routing_source_id", "routing_batch_id"}`` of a routed batch, or ``None``."""
    if not source_id or not batch_id:
        return None
    return {"routing_source_id": str(source_id), "routing_batch_id": str(batch_id)}


def notification_entries(notifications: Iterable[Any], user_id: str) -> list[dict]:
    """Pending notifications addressed to ``user_id``.

    ``list_pending`` is C2-scoped (an owner can *see* everyone's rows); the
    "needs you" list narrows to the rows that are the caller's to answer.
    """
    from hermes_cli.human_comms import notification_target_user

    out: list[dict] = []
    for n in notifications:
        if getattr(n, "status", "pending") != "pending":
            continue
        if notification_target_user(n) != user_id:
            continue
        key, arrival = split_arrival(n.dedupe_key)
        parsed = parse_project_key(key)
        context: dict = {}
        if parsed:
            slug, run_no = parsed["slug"], parsed["run_no"]
            source = _RUN_KIND_SOURCE.get(parsed["kind"], "project_checkpoint")
            context = {"project_slug": slug, "run_no": run_no}
            if source == "card_wait" and parsed["suffix"]:
                context["task_id"] = parsed["suffix"]
                href = project_href(slug, "cards", parsed["suffix"])
            else:
                href = project_href(slug, "runs", run_no)
            severity = None
        elif key.startswith("todo-action:"):
            source, href, severity = "todo", "/todos", "approval"
        elif key.startswith("todo:"):
            source, href, severity = "todo", "/todos", None
        elif key.startswith(TRIAGE_ASK_REVIEW + ":"):
            profile = unquote(key.split(":")[1]) if key.count(":") >= 2 else ""
            source, href, severity = "notification", triage_skills_href(profile), "review"
        elif key == TRIAGE_ALERT or key.startswith(TRIAGE_FAILED + ":"):
            source, href, severity = "notification", "/inbox", "review"
        else:
            source = "notification"
            href = "/inbox"
            severity = "approval" if n.kind == "approval" else "fyi"
        actions = [_open_action(href)]
        if n.reversible and n.kind == "approval":
            endpoint = f"/api/comms/notifications/{quote(n.id, safe='')}/answer"
            actions = [
                _post_action("approve", "Approve", "primary", endpoint, {"answer": "approved"}),
                _post_action("deny", "Deny", "danger", endpoint, {"answer": "denied"}),
                _open_action(href, "Open"),
            ]
            actions[-1]["style"] = "secondary"
        if arrival:
            context["arrival_key"] = arrival
        extra = getattr(n, "context", None) or {}
        if all(extra.get(k) for k in ROUTING_KEYS):
            context.update({k: str(extra[k]) for k in ROUTING_KEYS})
        out.append(entry(
            id=f"notif:{n.id}",
            source=source,
            severity=severity,
            title=n.title or "Needs your answer",
            i18n=None if n.title else _title("titles.needsAnswer"),
            detail=n.body,
            context=context,
            href=href,
            created_at=n.created_at,
            actions=actions,
            reversible=bool(n.reversible),
            notification_id=n.id,
        ))
    return out


def notification_dedupe_keys(items: Iterable[dict]) -> set[tuple]:
    """``(slug, "run", n)`` / ``(slug, "card", task_id)`` keys already
    covered by a notification row, so derived project rows can be dropped."""
    keys: set[tuple] = set()
    for item in items:
        if not item["id"].startswith("notif:"):
            continue
        ctx = item["context"]
        slug = ctx.get("project_slug")
        if not slug:
            continue
        if ctx.get("run_no") is not None:
            keys.add((slug, "run", ctx["run_no"]))
        if ctx.get("task_id"):
            keys.add((slug, "card", ctx["task_id"]))
    return keys


# ---------------------------------------------------------------------------
# Project-derived waits (sqlite)
# ---------------------------------------------------------------------------


def _actionable_projects(conn, principal, enrolled: set, project_ids: Iterable[str]) -> dict:
    """Projects the caller both reads and is expected to act in.

    Reading is ``_can_read``; acting needs a role on the project (or
    instance admin/owner). A read-only enrolled viewer is not "needed".
    """
    from hermes_cli import projects_db
    from hermes_cli.projects_api import _can_read, _instance_admin, _member_role_sync

    admin = _instance_admin(principal)
    out: dict = {}
    for pid in set(project_ids):
        project = projects_db.get_project(conn, pid)
        if project is None or project.archived:
            continue
        role = _member_role_sync(conn, project.id, principal.user_id)
        profiles = projects_db.get_project_profiles(conn, project.id)
        if not _can_read(project, role, principal, enrolled, profiles):
            continue
        if admin or role is not None or project.owner_user_id == principal.user_id:
            out[project.id] = project
    return out


def _project_cards(principal) -> list[dict]:
    """Blocked cards and cards with pending approvals, on project boards,
    private-visibility filtered like ``kanban_db.list_tasks``."""
    from hermes_cli import kanban_db

    try:
        boards = [
            b.get("slug") or kanban_db.DEFAULT_BOARD
            for b in kanban_db.list_boards(include_archived=False)
        ]
    except Exception:
        logger.debug("needs-you: board discovery failed", exc_info=True)
        boards = [kanban_db.DEFAULT_BOARD]
    vis_sql = ""
    params: list[Any] = []
    if principal is not None and not getattr(principal, "is_owner", False):
        vis_sql = " AND (t.visibility = 'shared' OR t.visibility = ?)"
        params.append(principal.private_visibility)
    blocked_sql = (
        "SELECT t.id, t.title, t.project_id, t.created_at, "
        "COALESCE(t.completed_at, t.started_at, t.created_at) AS since "
        "FROM tasks t WHERE t.status = 'blocked' AND t.project_id IS NOT NULL"
        f"{vis_sql} LIMIT {_PER_SOURCE_LIMIT}"
    )
    approvals_sql = (
        "SELECT t.id, t.title, t.project_id, a.approval_key, a.label, a.detail, "
        "a.requested_at FROM task_approvals a JOIN tasks t ON t.id = a.task_id "
        "WHERE a.status = 'pending' AND t.project_id IS NOT NULL"
        f"{vis_sql} LIMIT {_PER_SOURCE_LIMIT}"
    )
    out: list[dict] = []
    for board in boards:
        try:
            with kanban_db.connect_closing(board=board) as bconn:
                for row in bconn.execute(blocked_sql, params).fetchall():
                    out.append({**dict(row), "board": board, "kind": "blocked"})
                for row in bconn.execute(approvals_sql, params).fetchall():
                    out.append({**dict(row), "board": board, "kind": "approval"})
        except Exception:
            logger.debug("needs-you: board %s unreadable", board, exc_info=True)
    return out


def project_entries(principal, enrolled: Iterable[str], covered: set[tuple]) -> list[dict]:
    """Waits that live only in project/kanban state.

    ``covered`` holds the keys of notification rows already in the list
    (``notification_dedupe_keys``); a derived row for the same run/card is
    dropped so one wait never shows twice.
    """
    from hermes_cli import kanban_db, projects_db

    enrolled_set = set(enrolled)
    cards = _project_cards(principal)
    with projects_db.connect_closing() as conn:
        waiting_runs = [dict(r) for r in conn.execute(
            "SELECT project_id, run_no, started_at FROM project_runs "
            f"WHERE status = 'waiting' ORDER BY started_at LIMIT {_PER_SOURCE_LIMIT}"
        ).fetchall()]
        outputs = [dict(r) for r in conn.execute(
            "SELECT id, project_id, title, delivered_at, created_at FROM project_outputs "
            f"WHERE status = 'delivered' ORDER BY delivered_at LIMIT {_PER_SOURCE_LIMIT}"
        ).fetchall()]
        clarify = [dict(r) for r in conn.execute(
            "SELECT c.project_id, c.round_no, COUNT(*) AS open_count, "
            "MIN(r.created_at) AS created_at FROM project_clarifications c "
            "JOIN project_clarify_rounds r ON r.project_id = c.project_id "
            "AND r.round_no = c.round_no WHERE c.status = 'open' AND r.status = 'open' "
            f"GROUP BY c.project_id, c.round_no LIMIT {_PER_SOURCE_LIMIT}"
        ).fetchall()]
        # A drafted plan with no active revision on a project that never ran.
        plans = [dict(r) for r in conn.execute(
            "SELECT p.project_id, MAX(p.rev) AS rev, MAX(p.created_at) AS created_at "
            "FROM project_playbook p GROUP BY p.project_id "
            "HAVING SUM(p.active) = 0 AND NOT EXISTS "
            "(SELECT 1 FROM project_runs r WHERE r.project_id = p.project_id) "
            f"LIMIT {_PER_SOURCE_LIMIT}"
        ).fetchall()]
        wanted = (
            {r["project_id"] for r in waiting_runs}
            | {o["project_id"] for o in outputs}
            | {c["project_id"] for c in clarify}
            | {p["project_id"] for p in plans}
            | {c["project_id"] for c in cards}
        )
        projects = _actionable_projects(conn, principal, enrolled_set, wanted)

    out: list[dict] = []
    for run in waiting_runs:
        project = projects.get(run["project_id"])
        if project is None or (project.slug, "run", run["run_no"]) in covered:
            continue
        href = project_href(project.slug, "runs", run["run_no"])
        out.append(entry(
            id=f"project_run:{project.slug}:{run['run_no']}",
            source="project_checkpoint",
            title=f"{project.name} · run {run['run_no']} is waiting on you",
            i18n=_title("titles.runWaiting", project=project.name, run=run["run_no"]),
            context={"project_slug": project.slug, "run_no": run["run_no"]},
            href=href, created_at=run["started_at"],
        ))
    covered_cards = {k[2] for k in covered if k[1] == "card"}
    for card in cards:
        project = projects.get(card["project_id"])
        if project is None:
            continue
        if (project.board_slug or kanban_db.DEFAULT_BOARD) != card["board"]:
            continue
        href = project_href(project.slug, "cards", card["id"])
        ctx = {"project_slug": project.slug, "task_id": card["id"]}
        if card["kind"] == "approval":
            out.append(entry(
                id=f"card_approval:{card['id']}:{card['approval_key']}",
                source="card_approval",
                title=f"Approve: {card['label']}",
                i18n=_title("titles.approveCard", label=card["label"]),
                detail=card.get("detail") or f"{project.name} · {card['title']}",
                context=ctx, href=href, created_at=card["requested_at"],
            ))
        elif card["id"] not in covered_cards:
            out.append(entry(
                id=f"card_blocked:{card['id']}",
                source="card_blocked",
                title=f"Blocked: {card['title']}",
                i18n=_title("titles.blocked", title=card["title"]),
                detail=project.name,
                context=ctx, href=href, created_at=card["since"],
            ))
    for o in outputs:
        project = projects.get(o["project_id"])
        if project is None:
            continue
        out.append(entry(
            id=f"output:{o['id']}",
            source="output_acceptance",
            title=f"Review output: {o['title']}",
            i18n=_title("titles.reviewOutput", title=o["title"]),
            detail=project.name,
            context={"project_slug": project.slug},
            href=project_href(project.slug), created_at=o["delivered_at"] or o["created_at"],
        ))
    for c in clarify:
        project = projects.get(c["project_id"])
        if project is None:
            continue
        n = int(c["open_count"])
        out.append(entry(
            id=f"clarify:{project.slug}:{c['round_no']}",
            source="clarify",
            title=f"{project.name}: {n} question{'s' if n != 1 else ''} to answer",
            i18n=_title("titles.clarifyOne" if n == 1 else "titles.clarify", project=project.name, n=n),
            context={"project_slug": project.slug},
            href=project_href(project.slug), created_at=c["created_at"],
        ))
    for p in plans:
        project = projects.get(p["project_id"])
        if project is None:
            continue
        out.append(entry(
            id=f"plan:{project.slug}:{p['rev']}",
            source="plan_approval",
            title=f"{project.name}: plan awaiting approval",
            i18n=_title("titles.planApproval", project=project.name),
            context={"project_slug": project.slug},
            href=project_href(project.slug), created_at=p["created_at"],
        ))
    return out


# ---------------------------------------------------------------------------
# In-memory approvals
# ---------------------------------------------------------------------------


def chat_approval_entries(
    approvals: Iterable[dict], runs: dict, principal, *, admin: bool,
) -> list[dict]:
    """Rows for ``tools.approval.list_pending_gateway_approvals()``.

    ``runs`` maps an agent-home ``run_id`` (the approval session key) to
    ``{session_id, profile}``; approvals on other surfaces (Telegram, CLI)
    are answered there and skipped. A run is the requester's; one with no
    recorded requester is the instance admin's.
    """
    from gateway.run import _redact_approval_command

    out: list[dict] = []
    for a in approvals:
        run = runs.get(a["session_key"])
        if run is None:
            continue
        requester = a.get("requester_user_id")
        if requester != principal.user_id and not (requester is None and admin):
            continue
        run_id = a["session_key"]
        href = chat_href(run["session_id"], run.get("profile"))
        endpoint = "/api/chat/approval"
        command = _redact_approval_command(a.get("command") or "")
        out.append(entry(
            id=f"chat_approval:{run_id}:{a['approval_id']}",
            source="chat_tool_approval",
            title=f"Approve tool use: {a.get('description') or 'command'}",
            i18n=_title("titles.approveTool", what=a["description"]) if a.get("description")
            else _title("titles.approveToolCommand"),
            detail=command or None,
            context={
                "session_id": run["session_id"], "run_id": run_id,
                "profile": run.get("profile"),
            },
            href=href, created_at=a.get("created_at"),
            actions=[
                _post_action("once", "Allow once", "primary", endpoint,
                             {"runId": run_id, "choice": "once"}),
                _post_action("deny", "Deny", "danger", endpoint,
                             {"runId": run_id, "choice": "deny"}),
                {**_open_action(href, "Open chat"), "style": "secondary"},
            ],
        ))
    return out


def webview_entries(session) -> list[dict]:
    """Pending actions in the caller's own webview session."""
    if session is None:
        return []
    out: list[dict] = []
    for p in list(getattr(session, "pending", {}).values()):
        if getattr(p, "resolved", None) is not None:
            continue
        endpoint = f"/api/webview/approval/{quote(p.id, safe='')}"
        action = getattr(p, "action", None)
        kind = getattr(action, "kind", "action")
        url = getattr(action, "url", "") or ""
        out.append(entry(
            id=f"webview:{p.id}",
            source="webview_approval",
            title=f"Webview wants to {kind}" + (f" on {url}" if url else ""),
            i18n=_title("titles.webviewOn" if url else "titles.webview", kind=kind, url=url or None),
            detail=p.reason,
            href="/webview", created_at=p.created_at,
            actions=[
                _post_action("grant", "Allow", "primary", endpoint, {"grant": True}),
                _post_action("deny", "Deny", "danger", endpoint, {"grant": False}),
                {**_open_action("/webview"), "style": "secondary"},
            ],
        ))
    return out


def profile_suggestion_entries(suggestions: Iterable[Any]) -> list[dict]:
    out: list[dict] = []
    for s in suggestions:
        out.append(entry(
            id=f"profile_suggestion:{s.id}",
            source="profile_suggestion",
            title=f"New profile suggested: {s.proposed_name}",
            i18n=_title("titles.profileSuggested", name=s.proposed_name),
            detail=s.rationale or s.proposed_role,
            context={"profile": s.origin_profile},
            href="/profiles", created_at=s.created_at,
        ))
    return out


_ORIGIN_TEXT = {"chat": "from a chat", "feedback": "from answer feedback", "study": "from a study",
                "schema_check": "from a schema check", "edit": "from an edit"}


def data_draft_entries(sources: Iterable[dict]) -> list[dict]:
    """Open dictionary drafts on sources the caller manages (owner or admin approves)."""
    out: list[dict] = []
    for s in sources:
        if s.get("access") != "manage" or not s.get("draft_version"):
            continue
        n = int(s.get("draft_changes") or 0)
        known = [o for o in s.get("draft_origins") or [] if o in _ORIGIN_TEXT][:2]
        origins = [_ORIGIN_TEXT[o] for o in known]
        name = s.get("name")
        href = f"/data/{quote(str(s['id']), safe='')}/review"
        out.append(entry(
            id=f"data_draft:{s['id']}:{s['draft_version']}",
            source="data_draft",
            title=f"Dictionary draft v{s['draft_version']} for {name or 'a data source'} is ready",
            detail=" · ".join([f"{n} change{'s' if n != 1 else ''}"] + origins),
            i18n={
                "title": [_m("titles.dataDraft" if name else "titles.dataDraftUnnamed",
                             v=s["draft_version"], source=name)],
                "detail": [_m("details.changesOne" if n == 1 else "details.changes", n=n)]
                + [_m(f"details.origin.{o}") for o in known],
            },
            href=href, created_at=s.get("draft_proposed_at"),
            actions=[_open_action(href, "Review")],
        ))
    return out


_SCHEMA_DRIFT_TEXT = {
    "added": "{table} is new", "removed": "{table} is gone", "columns": "{table}: columns changed",
}


def data_schema_entries(sources: Iterable[dict]) -> list[dict]:
    """Sources whose schema no longer matches their approved dictionary.

    One card per drifted source (``manage`` approves its dictionary); the id
    is stable while drift persists so a still-open check shows once.
    """
    out: list[dict] = []
    for s in sources:
        if s.get("access") != "manage":
            continue
        drift = [
            d for d in s.get("schema_drift") or []
            if d.get("change") in _SCHEMA_DRIFT_TEXT and d.get("table")
        ]
        if not drift:
            continue
        n, shown = len(drift), drift[:2]
        name = s.get("name")
        href = f"/data/{quote(str(s['id']), safe='')}"
        out.append(entry(
            id=f"data_schema:{s['id']}",
            source="data_schema",
            title=f"The {name or 'data source'} schema changed — its dictionary needs an update",
            detail=" · ".join(
                [f"{n} table{'s' if n != 1 else ''} differ"]
                + [_SCHEMA_DRIFT_TEXT[d["change"]].format(table=d["table"]) for d in shown]
            ),
            i18n={
                "title": [_m("titles.dataSchema" if name else "titles.dataSchemaUnnamed",
                             source=name)],
                "detail": [_m("details.schemaDriftOne" if n == 1 else "details.schemaDrift", n=n)]
                + [_m(f"details.schemaItem.{d['change']}", table=d["table"]) for d in shown],
            },
            href=href, created_at=s.get("schema_checked_at"),
            actions=[_open_action(href, "Open dictionary")],
        ))
    return out


def data_health_entries(sources: Iterable[dict]) -> list[dict]:
    """Settings data sources whose hourly health check failed (one card each, to the owner)."""
    out: list[dict] = []
    for s in sources:
        health = s.get("health") or {}
        if s.get("access") != "manage" or health.get("status") != "failed":
            continue
        name = s.get("name")
        href = f"/data/{quote(str(s['id']), safe='')}"
        out.append(entry(
            id=f"data_health:{s['id']}",
            source="data_health",
            title=f"Can't connect to {name or 'a data source'} — its hourly check failed",
            detail=health.get("error") or None,
            i18n={"title": [_m("titles.dataHealth" if name else "titles.dataHealthUnnamed",
                               source=name)]},
            href=href, created_at=health.get("checked_at"),
            actions=[_open_action(href, "Open data source")],
        ))
    return out


# ---------------------------------------------------------------------------
# Response
# ---------------------------------------------------------------------------


#: Where a box admin settles a source claim in agent-home.
SOURCES_HREF = "/settings/sources"
_CHANNEL_LABELS = {"email": "mailbox", "whatsapp": "WhatsApp number", "telegram": "Telegram bot"}


def source_claim_entries(conflicts: Iterable[Any]) -> list[dict]:
    """Open source claim conflicts (FG-03), for the box owner/admin to settle.

    One entry per conflict (``source_claim:<id>``), with one-tap ``keep`` /
    ``transfer`` actions; resolving it clears the entry.
    """
    out: list[dict] = []
    for c in conflicts:
        if getattr(c, "resolved_at", None) is not None:
            continue
        endpoint = f"/api/sources/conflicts/{int(c.conflict_id)}/resolve"
        label = _CHANNEL_LABELS.get(c.channel, c.channel)
        owner = c.existing_owner_user_id or "nobody"
        out.append(entry(
            id=f"source_claim:{int(c.conflict_id)}",
            source="source_claim",
            title=f"{c.claimant_user_id} claims the {label} {c.address}",
            detail=f"It is registered to {owner}. Keep it with them, or transfer it "
                   f"to {c.claimant_user_id}.",
            context={
                "conflict_id": int(c.conflict_id),
                "channel": c.channel,
                "address": c.address,
                "claimant_user_id": c.claimant_user_id,
                "existing_owner_user_id": c.existing_owner_user_id,
            },
            href=SOURCES_HREF,
            created_at=c.created_at,
            actions=[
                _post_action("keep", "Keep current owner", "secondary", endpoint,
                             {"action": "keep"}),
                _post_action("transfer", "Transfer to claimant", "primary", endpoint,
                             {"action": "transfer"}),
            ],
        ))
    return out


async def source_claims_for(user_id: str) -> list[dict]:
    """The open source claims when ``user_id`` is the box owner/admin, else nothing."""
    from hermes_cli import source_registry as registry

    if not await registry.is_box_admin(user_id):
        return []
    return source_claim_entries(await registry.open_conflicts_on_box())


def _profile_href(href: str, profile: Optional[str]) -> str:
    if not profile or profile == "default" or "profile=" in href:
        return href
    return href + ("&" if "?" in href else "?") + urlencode({"profile": profile})


def tag_profile(items: Iterable[dict], profile: str, *, link: bool = False) -> list[dict]:
    """Stamp ``context.profile`` on arrival entries raised in ``profile``.

    With ``link`` (rows from a profile other than the request's) the entry's
    links also carry ``?profile=`` so opening it lands in that profile.
    """
    out: list[dict] = []
    for item in items:
        if not item["context"].get("arrival_key"):
            continue
        item = {**item, "context": {**item["context"], "profile": profile}}
        if link:
            item["href"] = _profile_href(item["href"], profile)
            item["actions"] = [
                {**a, "href": _profile_href(a["href"], profile)} if a.get("href") else a
                for a in item["actions"]
            ]
        out.append(item)
    return out


def merge_arrivals(items: Iterable[dict]) -> list[dict]:
    """One entry per arrival, however many profiles (or rows) raised it.

    Rows sharing ``context.arrival_key`` collapse onto the most severe (then
    oldest) one, re-keyed with the arrival key as its id so the entry, its
    "new" badge and its push stay the same as profiles join or leave. Its
    ``context.profiles`` lists every profile that raised it. Everything else
    passes through untouched, in order.
    """
    order: list[Any] = []
    groups: dict[str, list[dict]] = {}
    for item in items:
        key = (item.get("context") or {}).get("arrival_key")
        if not key:
            order.append(item)
            continue
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(item)
    out: list[dict] = []
    for slot in order:
        if not isinstance(slot, str):
            out.append(slot)
            continue
        group = groups[slot]
        primary = min(group, key=lambda i: (_SEVERITY_RANK.get(i["severity"], 99), i["created_at"]))
        profiles = sorted({i["context"].get("profile") for i in group} - {None})
        context = {**primary["context"], "profiles": profiles}
        if not all(context.get(k) for k in ROUTING_KEYS):
            routed = next((i["context"] for i in group
                           if all(i["context"].get(k) for k in ROUTING_KEYS)), None)
            if routed is not None:
                context.update({k: routed[k] for k in ROUTING_KEYS})
        if len(profiles) != 1:
            context.pop("profile", None)
        out.append({
            **primary,
            "id": slot,
            "created_at": min(i["created_at"] for i in group),
            "context": context,
        })
    return out


async def arrival_entries_elsewhere(
    user_id: str, *, registry: Optional[list] = None, current_home: Optional[Path] = None,
) -> list[dict]:
    """Arrival-keyed pending notifications for ``user_id`` in their other profiles.

    Enters each served profile but the request's own and asks that profile's
    notification store, as that profile's principal for ``user_id`` (absent or
    suspended there: nothing). A profile that cannot be read is skipped.
    """
    from hermes_cli.access import PrincipalStore
    from hermes_cli.config import load_config_readonly
    from hermes_cli.console_scope import _scoped_to
    from hermes_cli.datastore import get_store
    from hermes_cli.human_comms import NotificationStore
    from hermes_constants import get_hermes_home

    if registry is None:
        from hermes_cli.profile_registry import get_profile_registry

        registry = get_profile_registry()
    here = Path(current_home or get_hermes_home()).resolve()
    out: list[dict] = []
    for profile in registry:
        home = Path(profile.hermes_home)
        if not home.is_dir() or home.resolve() == here:
            continue
        try:
            with _scoped_to(home):
                config = load_config_readonly() or {}
                app = get_store("supabase-app", "prod", config=config)
                principal = await PrincipalStore(app).get(user_id)
                if principal is None or not getattr(principal, "active", True):
                    continue
                rows = await NotificationStore(app, config=config).list_pending(principal)
            out.extend(tag_profile(notification_entries(rows, user_id), profile.name, link=True))
        except Exception:
            logger.debug("needs-you: profile %s unreadable", profile.name, exc_info=True)
    return out


def finalize(items: Iterable[dict]) -> list[dict]:
    """Merge per-arrival rows, drop duplicate ids; severity first, then oldest wait first."""
    seen: set[str] = set()
    unique: list[dict] = []
    for item in merge_arrivals(items):
        if not item.get("href") or item["id"] in seen:
            continue
        seen.add(item["id"])
        unique.append(item)
    unique.sort(key=lambda i: (_SEVERITY_RANK.get(i["severity"], 99), i["created_at"]))
    return unique


def by_severity(items: Iterable[dict]) -> dict[str, int]:
    counts = {s: 0 for s in SEVERITIES}
    for item in items:
        if item["severity"] in counts:
            counts[item["severity"]] += 1
    return counts


def response(items: list[dict], *, count_only: bool = False) -> dict:
    payload: dict = {
        "count": len(items),
        "by_severity": by_severity(items),
        "collected_at": time.time(),
    }
    payload["items"] = [] if count_only else items
    return payload


# ---------------------------------------------------------------------------
# Web Push on new items
# ---------------------------------------------------------------------------

_LEDGER_TTL_SECONDS = 7 * 24 * 3600


def _safe_user(user_id: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in user_id) or "anon"


def _arrival_ledger_path(user_id: str) -> Path:
    """Box-level, not per-profile: one arrival raised in N profiles is one push."""
    from hermes_constants import get_default_hermes_root

    return Path(get_default_hermes_root()) / "needs_you" / f"arrivals-{_safe_user(user_id)}.json"


def _update_arrival_ledger(user_id: str, change) -> Any:
    import fcntl

    path = _arrival_ledger_path(user_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "a", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            ledger = json.loads(path.read_text())
            if not isinstance(ledger, dict):
                ledger = {}
        except FileNotFoundError:
            ledger = {}
        except Exception:
            logger.debug("needs-you: unreadable arrival ledger %s", path, exc_info=True)
            ledger = {}
        now = time.time()
        ledger = {k: ts for k, ts in ledger.items() if now - float(ts) < _LEDGER_TTL_SECONDS}
        outcome = change(ledger, now)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(ledger))
        os.replace(tmp, path)
        return outcome


def claim_arrival_push(user_id: str, key: str) -> bool:
    """True the first time ``key`` is pushed to ``user_id`` (within a week).

    Shared by every profile and push channel (the triage to-do Telegram push
    and the needs-you Web Push), so the person is buzzed once per arrival. A
    ledger that cannot be read or written fails open (a duplicate push beats
    a lost one).
    """

    def claim(ledger: dict, now: float) -> bool:
        if key in ledger:
            return False
        ledger[key] = now
        return True

    try:
        return bool(_update_arrival_ledger(user_id, claim))
    except Exception:
        logger.warning("needs-you: arrival ledger unavailable for %s", user_id, exc_info=True)
        return True


def release_arrival_push(user_id: str, key: str) -> None:
    """Undo :func:`claim_arrival_push` after the push itself failed."""
    try:
        _update_arrival_ledger(user_id, lambda ledger, now: ledger.pop(key, None))
    except Exception:
        logger.debug("needs-you: could not release %s for %s", key, user_id, exc_info=True)


def _ledger_path(user_id: str) -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "needs_you" / f"pushed-{_safe_user(user_id)}.json"


def claim_new_for_push(user_id: str, items: Iterable[dict]) -> list[dict]:
    """Blocking/approval items not yet pushed for ``user_id``; records them.

    The ledger (``$HERMES_HOME/needs_you/pushed-<user>.json``) keeps an id
    until it has been gone from the list for a week, so a wait that is
    still open never re-buzzes and one that reappears much later does. The
    first collection for a user seeds the ledger silently — turning the
    feature on must not replay every existing wait as a push.
    """
    path = _ledger_path(user_id)
    now = time.time()
    try:
        ledger: Optional[dict] = json.loads(path.read_text())
        if not isinstance(ledger, dict):
            ledger = {}
    except FileNotFoundError:
        ledger = None
    except Exception:
        logger.debug("needs-you: unreadable push ledger %s", path, exc_info=True)
        ledger = {}
    current = {i["id"]: i for i in items if i["severity"] in ("blocking", "approval")}
    # A still-open wait is re-stamped every collection, so a stale stamp
    # means it has been gone for the whole TTL.
    kept = {
        iid: ts for iid, ts in (ledger or {}).items()
        if now - float(ts) < _LEDGER_TTL_SECONDS
    }
    fresh = [] if ledger is None else [
        i for iid, i in current.items()
        if iid not in kept and i["source"] not in PUSHED_AT_ORIGIN
    ]
    for iid in current:
        kept[iid] = now
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(kept))
        os.replace(tmp, path)
    except Exception:
        logger.warning("needs-you: could not write push ledger %s", path, exc_info=True)
        return []
    return [
        i for i in fresh
        if not i["context"].get("arrival_key")
        or claim_arrival_push(user_id, i["context"]["arrival_key"])
    ]


async def push_new(user_id: str, items: list[dict]) -> int:
    """Best-effort tagged Web Push for each newly appeared wait.

    The tag is the item id, so a device that already shows it replaces
    rather than stacks. Never raises.
    """
    try:
        fresh = claim_new_for_push(user_id, items)
        if not fresh:
            return 0
        from plugins.platforms.app.push import send_push

        sent = 0
        for item in fresh[:5]:
            sent += await send_push(
                item["id"], title=item["title"],
                body=item.get("detail") or "Waiting on you", url=item["href"],
            )
        return sent
    except Exception:
        logger.warning("needs-you: push failed", exc_info=True)
        return 0
