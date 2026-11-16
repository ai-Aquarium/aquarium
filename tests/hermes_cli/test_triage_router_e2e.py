"""FG-03 P4 E2E — the triage router on real Postgres.

Real profiles over a tmp hermes root, the real box source registry and the
real care sections (see ``test_triage_skills_routing_e2e``); decisions land in
``aquarium_box.routing_decisions`` and are read back through the real API and
CLI. Only the model is a stand-in: it picks by keyword, or fails on demand.
"""

from __future__ import annotations

import asyncio
import json

import asyncpg

from hermes_cli import source_registry as registry
from hermes_cli import triage_router as tr
from hermes_cli import triage_skills as tsk
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: F401 — pytest fixture
    MAILBOX,
    _box,
    _cli,
    _client,
    _session_as,
    box,
)

BATCHES = {
    "b-invoice": "From: supplier\nInvoice INV-77 for HKD 12,000 is overdue.",
    "b-launch-invoice": "Launch budget: the agency invoice for the press event.",
    "b-newsletter": "Your weekly gardening newsletter.",
    "b-outage": "Payment run failed for INV-78.",
}
KEYWORDS = {"cfo": "invoice", "cmo": "launch"}
NO_CALL = {"triage": {"router": {"retry_delay_seconds": 0}}}


class KeywordModel:
    """Picks a profile when its keyword is in the batch; records every prompt."""

    def __init__(self, fail_first: int = 0, model: str = "cheap-router-1"):
        self.fail_first = fail_first
        self.model = model
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, system: str, user: str) -> str:
        self.calls.append((system, user))
        if len(self.calls) <= self.fail_first:
            if len(self.calls) % 2:
                raise ConnectionError("provider 503")
            return "I think the CFO should look at this."
        text = user.lower()
        return json.dumps({"routes": [
            {"profile": p, "selected": k in text, "reason": f"mentions {k}" if k in text else "not relevant"}
            for p, k in KEYWORDS.items()
        ] + [{"profile": "hr", "selected": True, "reason": "not routed, dropped"}]})


class NoModel:
    async def __call__(self, system: str, user: str) -> str:
        raise AssertionError("a stored decision must not call the model")


def _johns_mailbox(box):
    homes = box["homes"]
    tsk.write_care("email", "John@CFO: invoices and payments", layer="user",
                   home=homes["cfo"], user_id="john", author="john")
    tsk.write_care("email", "Mary@CFO: board papers", layer="user",
                   home=homes["cfo"], user_id="mary", author="mary")
    tsk.write_care("email", "CMO template: campaigns, launches and press", layer="template",
                   home=homes["cmo"], author="cmo_owner")

    async def setup(c):
        src = await registry.register_source(c, channel="email", address=MAILBOX, owner_user_id="john")
        for profile in ("cfo", "cmo"):
            await registry.set_route(c, source_id=src.source_id, profile_slug=profile,
                                     enabled=True, actor_user_id="john")
        mary = await registry.register_source(
            c, channel="email", address="mary@example.com", owner_user_id="mary")
        return src.source_id, mary.source_id

    return _box(box["dsn"], setup)


def _route(box, source_id, batch_id, llm, sleeps=None):
    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)

    return _box(box["dsn"], lambda c: tr.route_batch(
        c, source_id=source_id, batch_id=batch_id, batch_text=BATCHES[batch_id],
        config=NO_CALL, llm=llm, sleep=sleep,
    ))


def test_johns_mailbox_routes_each_batch_and_falls_back(box, monkeypatch, capsys):
    john_src, mary_src = _johns_mailbox(box)

    model = KeywordModel()
    cfo_only = _route(box, john_src, "b-invoice", model)
    both = _route(box, john_src, "b-launch-invoice", model)
    neither = _route(box, john_src, "b-newsletter", model)
    assert [d.selected for d in (cfo_only, both, neither)] == [["cfo"], ["cfo", "cmo"], []]
    assert all(d.attempts == 1 and not d.fallback and d.model == "cheap-router-1"
               for d in (cfo_only, both, neither))
    assert cfo_only.choices == (
        tr.RouteChoice("cfo", True, "mentions invoice"),
        tr.RouteChoice("cmo", False, "not relevant"),
    )
    # One byte-stable system prompt for every batch: John's care, never Mary's.
    systems = {system for system, _ in model.calls}
    assert len(systems) == 1
    [system] = systems
    assert "John@CFO: invoices" in system and "CMO template" in system
    assert "Mary" not in system and "INV-77" not in system

    flaky, sleeps = KeywordModel(fail_first=4), []
    down = _route(box, john_src, "b-outage", flaky, sleeps)
    assert len(flaky.calls) == 4 and sleeps == [0.0, 0.0, 0.0]
    assert down.fallback is True and down.attempts == 4 and down.selected == ["cfo", "cmo"]
    assert down.error.startswith("ValueError")

    # Idempotent per (source_id, batch_id): no second call, no second row.
    again = _route(box, john_src, "b-invoice", NoModel())
    assert again == cfo_only

    async def rows(c):
        return [dict(r) for r in await c.fetch(
            f"SELECT * FROM {registry.BOX_SCHEMA}.routing_decisions ORDER BY decision_id")]

    stored = _box(box["dsn"], rows)
    assert [r["batch_id"] for r in stored] == list(BATCHES)
    assert [list(r["selected"]) for r in stored] == [["cfo"], ["cfo", "cmo"], [], ["cfo", "cmo"]]
    assert all(r["owner_user_id"] == "john" for r in stored)
    blob = json.dumps(stored, default=str)
    assert not any(text in blob for text in ("INV-77", "gardening", "Payment run", "agency"))

    # No routes: no call, nothing picked.
    _box(box["dsn"], lambda c: tr.route_batch(
        c, source_id=mary_src, batch_id="m1", batch_text="hi", config=NO_CALL, llm=NoModel()))
    assert _box(box["dsn"], lambda c: tr.get_decision(c, mary_src, "m1")).selected == []

    # API: John sees his own, newest first; Mary never sees John's.
    _session_as(monkeypatch, "john")
    john = _client("john")
    body = john.get("/api/sources/decisions").json()
    assert [d["batch_id"] for d in body["decisions"]] == list(reversed(BATCHES))
    one = john.get("/api/sources/decisions",
                   params={"source_id": john_src, "batch_id": "b-outage"}).json()["decisions"]
    assert [(d["fallback"], d["attempts"], d["selected"]) for d in one] == [(True, 4, ["cfo", "cmo"])]
    assert len(john.get("/api/sources/decisions?limit=2").json()["decisions"]) == 2
    assert john.get("/api/sources/decisions?all=1").status_code == 403

    _session_as(monkeypatch, "mary")
    mary = _client("mary")
    assert [d["batch_id"] for d in mary.get("/api/sources/decisions").json()["decisions"]] == ["m1"]
    assert mary.get("/api/sources/decisions", params={"source_id": john_src}).json() == {"decisions": []}
    assert mary.get("/api/sources/decisions", params={"batch_id": "b-invoice"}).json() == {"decisions": []}
    assert mary.get("/api/sources/decisions?all=1").status_code == 403

    _session_as(monkeypatch, "leo")  # the box owner, for support
    leo = _client("leo")
    assert len(leo.get("/api/sources/decisions?all=1").json()["decisions"]) == 5
    assert leo.get("/api/sources/decisions").json() == {"decisions": []}

    # CLI.
    out = _cli(["decisions", "--as", "john", "--source", f"email:{MAILBOX}",
                "--batch", "b-invoice", "--json"], capsys)
    assert [(d["batch_id"], d["selected"]) for d in out["decisions"]] == [("b-invoice", ["cfo"])]
    assert len(_cli(["decisions", "--all", "--json"], capsys)["decisions"]) == 5
    assert _cli(["decisions", "--as", "mary", "--source", john_src, "--json"], capsys) == {"decisions": []}


def test_route_batch_sync_uses_the_box_and_never_raises(box):
    john_src, _ = _johns_mailbox(box)
    kwargs = dict(source_id=john_src, batch_id="b-invoice", batch_text=BATCHES["b-invoice"],
                  config=NO_CALL, llm=KeywordModel())
    decision = tr.route_batch_sync(dsn=box["dsn"], **kwargs)
    assert decision is not None and decision.selected == ["cfo"]
    assert tr.route_batch_sync(dsn="postgresql://nobody@127.0.0.1:1/none", **kwargs) is None
    assert tr.route_batch_sync(dsn=box["dsn"], **{**kwargs, "source_id": "not-a-source"}) is None


def test_migrate_box_creates_the_decisions_table(box):
    from hermes_cli.db_migrate import migrate_box

    async def drop_and_check():
        c = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            await c.execute(f"DROP TABLE IF EXISTS {registry.BOX_SCHEMA}.routing_decisions")
            await migrate_box(box["dsn"])
            return await c.fetchval("SELECT to_regclass('aquarium_box.routing_decisions')")
        finally:
            await c.close()

    _box(box["dsn"], lambda c: registry.list_sources(c))  # connect_box made the schema
    assert asyncio.run(drop_and_check()) is not None
