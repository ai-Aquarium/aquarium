"""Postgres E2E for the daily triage ask-volume review.

Runs through the real path a gateway takes: a temp HERMES_HOME whose
config.yaml carries the datastore DSN and ``triage.ask_review``, the profile
scope, the owner lookup, the to-do and notification stores, and the Needs you
mapping of the resulting row. Contracts: only triage to-dos from the last 24
hours count; nothing is raised at or under the threshold; above it exactly one
warning per profile per day, naming the count and the busiest skills and
linking to the profile's triage skills; a new day may warn again; each profile
is reviewed against its own store.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import asyncpg
import yaml

from hermes_cli import needs_you
from hermes_cli.access import PrincipalStore
from hermes_cli.console_scope import _scoped_to
from hermes_cli.datastore import app_schema, get_store, initialize_supabase_app
from hermes_cli.human_comms import NotificationStore
from hermes_cli.task_registry import TASKS_TABLE
from hermes_cli.todo_store import TodoStore
from hermes_cli.triage_ask_review import dedupe_key, run_ask_review
from tests.hermes_cli.test_todo_store_e2e import postgres_dsn  # noqa: F401 — fixture


def _write_config(home: Path, dsn: str, threshold: int) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "datastore": {"supabase_app": {"dsn": dsn}},
                "triage": {"ask_review": {"daily_threshold": threshold}},
            }
        )
    )


async def _prepare(home: Path, dsn: str):
    """Fresh schema + owner for the profile at ``home``; its stores and owner."""
    from hermes_cli.config import load_config

    with _scoped_to(home):
        conn = await asyncpg.connect(dsn, ssl=False)
        try:
            await conn.execute(f"DROP SCHEMA IF EXISTS {app_schema('prod')} CASCADE")
            await conn.execute(f"DROP SCHEMA IF EXISTS {app_schema('dev')} CASCADE")
            await initialize_supabase_app(conn)
        finally:
            await conn.close()
        config = load_config()
        app = get_store("supabase-app", "prod", config=config)
        todos = TodoStore(app)
        await todos.initialize()
        notifications = NotificationStore(app, config=config)
        await notifications.initialize()
        principals = PrincipalStore(app)
        await principals.enroll("leo", display="Leo", role="owner")
        owner = await principals.get("leo")
    return app, todos, notifications, owner


async def _triage(todos, owner, channel: str, n: int) -> None:
    for _ in range(n):
        await todos.create(
            owner,
            title=f"Reply about {uuid.uuid4().hex[:8]}",
            stage="staged",
            source_kind="inbound",
            source_ref=str(uuid.uuid4()),
            origin="triage",
            actor=f"skill:{channel}-triage",
        )


async def _warnings(notifications, owner) -> list:
    rows = await notifications.list_pending(owner)
    return [
        r for r in rows
        if (r.dedupe_key or "").startswith(needs_you.TRIAGE_ASK_REVIEW + ":")
    ]


def test_above_threshold_warns_once_a_day(postgres_dsn: str) -> None:  # noqa: F811
    home = Path(os.environ["HERMES_HOME"])
    _write_config(home, postgres_dsn, threshold=5)
    app, todos, notifications, owner = asyncio.run(_prepare(home, postgres_dsn))

    async def _seed() -> None:
        await _triage(todos, owner, "email", 4)
        await _triage(todos, owner, "whatsapp", 1)
        # Not triage, and not from the last day: neither counts.
        await todos.create(owner, title="Book the dentist", origin="user", actor="user:leo")
        await _triage(todos, owner, "telegram", 3)
        conn = await app.connect()
        try:
            await conn.execute(
                f"UPDATE {TASKS_TABLE} SET created_at = NOW() - INTERVAL '2 days' "
                "WHERE id IN (SELECT task_id FROM task_transitions "
                "WHERE actor = 'skill:telegram-triage')"
            )
        finally:
            await conn.close()

    asyncio.run(_seed())

    # 5 asks at threshold 5: at the threshold is not "too many".
    [review] = run_ask_review([("default", home)])
    assert (review.count, review.threshold, review.warned) == (5, 5, False)
    assert asyncio.run(_warnings(notifications, owner)) == []

    asyncio.run(_triage(todos, owner, "whatsapp", 2))
    [review] = run_ask_review([("default", home)])
    assert review.count == 7
    assert review.by_skill == [("email-triage", 4), ("whatsapp-triage", 3)]
    assert review.warned
    [row] = asyncio.run(_warnings(notifications, owner))
    assert row.kind == "proactive_ask"
    assert "7 asks" in row.title
    assert "email-triage (4)" in row.body and "whatsapp-triage (3)" in row.body
    assert "/profiles/default/triage" in row.body
    [entry] = needs_you.notification_entries([row], owner.user_id)
    assert entry["href"] == "/profiles/default/triage"

    # More asks the same day, after the warning was answered: no second one.
    asyncio.run(_triage(todos, owner, "email", 3))
    asyncio.run(notifications.answer(row.id, owner, answer="ok", via="web"))
    [again] = run_ask_review([("default", home)])
    assert again.count == 10 and not again.warned
    assert asyncio.run(_warnings(notifications, owner)) == []

    # The next day may warn again: the same asks, seen from tomorrow.
    tomorrow = datetime.now().astimezone() + timedelta(days=1)

    async def _age() -> None:
        conn = await app.connect()
        try:
            await conn.execute(
                f"UPDATE {TASKS_TABLE} SET created_at = $1 "
                "WHERE origin = 'triage' AND created_at > NOW() - INTERVAL '1 day'",
                tomorrow - timedelta(hours=1),
            )
        finally:
            await conn.close()

    asyncio.run(_age())
    [next_day] = run_ask_review([("default", home)], now=tomorrow)
    assert next_day.warned
    [fresh] = asyncio.run(_warnings(notifications, owner))
    assert fresh.dedupe_key == dedupe_key("default", tomorrow.date())


def test_each_profile_is_reviewed_against_its_own_store(postgres_dsn: str) -> None:  # noqa: F811
    default_home = Path(os.environ["HERMES_HOME"])
    work_home = default_home / "profiles" / "work"
    _write_config(default_home, postgres_dsn, threshold=2)
    _write_config(work_home, postgres_dsn, threshold=2)
    _, d_todos, d_notes, d_owner = asyncio.run(_prepare(default_home, postgres_dsn))
    _, w_todos, w_notes, w_owner = asyncio.run(_prepare(work_home, postgres_dsn))

    with _scoped_to(default_home):
        asyncio.run(_triage(d_todos, d_owner, "email", 1))
    with _scoped_to(work_home):
        asyncio.run(_triage(w_todos, w_owner, "calendar", 3))

    reviews = {
        r.profile: r
        for r in run_ask_review([("default", default_home), ("work", work_home)])
    }
    assert (reviews["default"].count, reviews["default"].warned) == (1, False)
    assert (reviews["work"].count, reviews["work"].warned) == (3, True)
    with _scoped_to(default_home):
        assert asyncio.run(_warnings(d_notes, d_owner)) == []
    with _scoped_to(work_home):
        [row] = asyncio.run(_warnings(w_notes, w_owner))
    assert "/profiles/work/triage" in row.body


def test_threshold_comes_from_config_yaml(tmp_path: Path) -> None:
    from hermes_cli.config import DEFAULT_CONFIG, load_config
    from hermes_cli.triage_ask_review import DEFAULT_DAILY_THRESHOLD, review_settings

    assert review_settings(DEFAULT_CONFIG) == (True, DEFAULT_DAILY_THRESHOLD)
    home = tmp_path / "home"
    home.mkdir()
    (home / "config.yaml").write_text(
        "triage:\n  ask_review:\n    enabled: false\n    daily_threshold: 7\n"
    )
    with _scoped_to(home):
        assert review_settings(load_config()) == (False, 7)
