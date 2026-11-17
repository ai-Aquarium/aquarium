"""Move existing to-dos into the two-perspective model (Start task).

``hermes todos migrate-to-projects`` runs this once per profile, as that
profile's owner (who sees every to-do):

* **staged / open** to-dos stay as they are: they already are system to-dos,
  shown as suggestions. Nothing is copied.
* **working / review** to-dos become one-off projects in Manual mode, exactly
  as Start task makes them (:func:`hermes_cli.todo_task._create_or_find_sync`):
  the person who owns the to-do leads the project, the brief carries the
  source message and the draft / reply an earlier "Work on this" left
  (``work_result`` or the files in ``$HERMES_HOME/drafts/todo_<id>/``), and
  the reply route is the message's own. No plan is drafted and no run is
  started: starting is a human act, so the project waits in ``planning`` for
  its lead to press Start.
* **done / dismissed** to-dos stay closed system to-dos.

Idempotent: a to-do that already has a project (``projects.todo_id``,
unique) is skipped, so a re-run moves only what is new. Reversible-safe: the
to-do rows, their history, pending reply approvals and draft files are never
changed, and ``--revert`` removes only migration-made projects nobody has
touched (still ``planning``, no runs, no cards); any other is kept and named.
"""

from __future__ import annotations

import asyncio
import dataclasses
import logging
from types import SimpleNamespace
from typing import Any, Optional

log = logging.getLogger(__name__)

#: ``project_links.added_by`` of a migration-made project — what ``--revert``
#: looks for, so it can never remove a project a person started.
MIGRATION_ACTOR = "migration:todos-into-projects"

MOVED_STAGES = ("working", "review")
_PAGE = 200


def _with_draft_files(todo):
    """``todo`` with the draft / reply text read from its draft folder when
    ``work_result`` does not already carry it."""
    from pathlib import Path

    from hermes_cli.todo_work import DRAFT_FILENAME, REPLY_FILENAME, draft_dir_for

    work = dict(todo.work_result or {})
    folder = Path(str(work.get("draft_dir") or draft_dir_for(todo.id)))
    for key, name in (("draft_text", DRAFT_FILENAME), ("reply_text", REPLY_FILENAME)):
        if str(work.get(key) or "").strip():
            continue
        path = folder / name
        if path.is_file() and not path.is_symlink():
            try:
                work[key] = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
    if folder.is_dir():
        work.setdefault("draft_dir", str(folder))
    return dataclasses.replace(todo, work_result=work or None)


async def _all(store, principal, stages) -> list:
    out, cursor = [], None
    while True:
        items, cursor = await store.list(
            principal, stages=list(stages), include_snoozed=True, limit=_PAGE, cursor=cursor
        )
        out.extend(items)
        if not cursor:
            return out


async def _stage_counts(store, principal) -> dict[str, int]:
    facets = await store.facets(principal)
    return {row["value"]: int(row["count"]) for row in facets.get("stages", [])}


async def migrate(store, principal, *, dry_run: bool = False) -> dict[str, Any]:
    """Move this profile's working / review to-dos into one-off projects."""
    from hermes_cli import profile_refs, projects_db, todo_task
    from hermes_cli.todo_work import _load_arrival

    profile = profile_refs.current_profile()
    counts = await _stage_counts(store, principal)
    report: dict[str, Any] = {
        "profile": profile,
        "dry_run": dry_run,
        "suggestions": counts.get("staged", 0) + counts.get("open", 0),
        "closed": counts.get("done", 0) + counts.get("dismissed", 0),
        "moved": [],
        "already": [],
        "failed": [],
    }
    for todo in await _all(store, principal, MOVED_STAGES):
        def _find(todo_id=todo.id):
            with projects_db.connect_closing() as conn:
                return projects_db.project_for_todo(conn, profile=profile, todo_id=todo_id)

        existing = await asyncio.to_thread(_find)
        if existing is not None:
            report["already"].append({"todo_id": todo.id, "project": existing.slug})
            continue
        if dry_run:
            report["moved"].append({"todo_id": todo.id, "title": todo.title, "project": None})
            continue
        try:
            arrival = await _load_arrival(store, principal, todo)
            carried = _with_draft_files(todo)
            route = todo_task.reply_route_from(arrival)
            text = todo_task.task_request_text(carried, arrival, reply_route=route)
            draft_dir = (carried.work_result or {}).get("draft_dir")
            if draft_dir:
                text += f"\n\n(Earlier draft files: {draft_dir})"
            lead = SimpleNamespace(user_id=todo.owner_user_id, display=todo.owner_user_id)
            project, created = await asyncio.to_thread(
                todo_task._create_or_find_sync,  # noqa: SLF001 - same package
                lead,
                todo,
                profile=profile,
                request_text=text,
                host_profile=profile,
                autonomy=todo_task.DEFAULT_AUTONOMY,
                reply_route=route,
                arrival=arrival,
                added_by=MIGRATION_ACTOR,
            )
        except Exception as exc:  # noqa: BLE001 - one bad row never stops the rest
            log.warning("todo_migration: %s failed (%s)", todo.id, exc)
            report["failed"].append({"todo_id": todo.id, "error": str(exc)[:300]})
            continue
        bucket = "moved" if created else "already"
        report[bucket].append({"todo_id": todo.id, "title": todo.title, "project": project.slug})
    return report


def _untouched(conn, project) -> bool:
    from hermes_cli import projects_api, projects_db

    if project.status != "planning" or projects_db.list_project_runs(conn, project.id):
        return False
    with projects_api._board_conn(project) as bconn:  # noqa: SLF001
        cards = bconn.execute(
            "SELECT COUNT(*) FROM tasks WHERE project_id = ?", (project.id,)
        ).fetchone()[0]
    return not cards


def revert(*, profile: Optional[str] = None, dry_run: bool = False) -> dict[str, Any]:
    """Remove the migration's untouched projects in ``profile`` (sync)."""
    from hermes_cli import profile_refs, projects_db

    profile = profile or profile_refs.current_profile()
    report: dict[str, Any] = {"profile": profile, "dry_run": dry_run, "removed": [], "kept": []}
    with projects_db.connect_closing() as conn:
        rows = conn.execute(
            """SELECT DISTINCT p.id FROM projects p
                 JOIN project_links l
                   ON l.project_id = p.id AND l.kind = 'todo'
                  AND l.profile = p.todo_profile AND l.ref = p.todo_id
                WHERE p.todo_profile = ? AND l.added_by = ?""",
            (profile, MIGRATION_ACTOR),
        ).fetchall()
        for row in rows:
            project = projects_db.get_project(conn, row["id"])
            if project is None:
                continue
            link = projects_db.project_todo(conn, project.id) or {}
            entry = {"project": project.slug, "todo_id": link.get("todo_id")}
            if not _untouched(conn, project):
                report["kept"].append(entry)
                continue
            if not dry_run:
                projects_db.delete_project(conn, project.id)
            report["removed"].append(entry)
    return report
