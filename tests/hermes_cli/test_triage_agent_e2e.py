"""FG-03 P5 E2E — full triage in each chosen user-profile's agent.

Real profiles over a tmp hermes root, real per-profile people stores on real
Postgres (the owner check is the scheduler's), the real layered triage skills
and the real box registry; comparisons land in
``aquarium_box.triage_comparisons`` and are read back through the real API and
CLI. Only the model turn is a stand-in.
"""

from __future__ import annotations

import asyncio
import json

import asyncpg

from hermes_cli import source_registry as registry
from hermes_cli import triage_agent as ta
from hermes_cli import triage_skills as tsk
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: F401 — pytest fixture
    MAILBOX,
    _box,
    _cli,
    _client,
    _seed,
    _session_as,
    box,
)

BATCH = {
    "batch_id": "b-inv", "sender": "supplier@example.com", "sender_name": "Supplier",
    "account_id": MAILBOX, "email_count": 1,
    "emails": [{"subject": "Invoice INV-77 overdue", "body_text": "HKD 12,000 is overdue."}],
}
REPLY = {"classification": "invoice", "summary": "An overdue invoice.", "escalate": True,
         "escalation_reason": "invoice", "escalation_priority": "high", "tasks": [],
         "todos": [], "work_request": None, "notes": [], "memory_facts": []}
LEGACY = {"classification": "invoice", "summary": "Invoice", "escalate": False}


class Model:
    """The one stand-in: records every turn, answers with the triage JSON."""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        return f"```json\n{json.dumps(REPLY)}\n```"


def _layers(box):
    """John and Mary both in CFO and CMO, each with their own user layer."""
    homes = box["homes"]
    asyncio.run(_seed(homes["cmo"], box["dsn"], [("mary", "member", True)]))
    for profile in ("cfo", "cmo"):
        for user in ("john", "mary"):
            tag = f"{user.title()}@{profile.upper()}"
            tsk.write_care("email", f"{tag} care: what {user} wants from {profile}",
                           layer="user", home=homes[profile], user_id=user, author=user)
            tsk.write_file("email", "user", "my-rules.md", f"{tag} rule: escalate my things",
                           home=homes[profile], user_id=user, author=user)
        tsk.write_file("email", "template", "house-rules.md",
                       f"{profile.upper()} template rule", home=homes[profile], author="owner")
    return homes


def test_john_at_cfo_triages_with_only_his_cfo_skills(box, monkeypatch):
    homes = _layers(box)
    model = Model()
    monkeypatch.setattr(ta, "_default_runner", model)
    picks = ta.triage_selected("email", BATCH, ["cfo", "cmo"], owner_user_id="john", config={})
    assert [(p.profile, p.ok, p.skills_layer) for p in picks] == [
        ("cfo", True, "user"), ("cmo", True, "user")]
    assert [p.result for p in picks] == [REPLY, REPLY]
    assert [p.session_id for p in picks] == ["triage_email_b-inv_cfo", "triage_email_b-inv_cmo"]

    cfo, cmo = model.calls
    assert cfo["profile_home"] == homes["cfo"] and cfo["owner_user_id"] == "john"
    prompt = cfo["prompt"]
    assert "John@CFO care" in prompt and "John@CFO rule" in prompt and "CFO template rule" in prompt
    for other in ("Mary@", "John@CMO", "CMO template"):
        assert other not in prompt
    assert prompt.rstrip().endswith("Body: HKD 12,000 is overdue.")
    assert "John@CMO rule" in cmo["prompt"] and "CFO" not in cmo["prompt"].split("Triage this")[0]

    # Mary@CFO gets hers, and John's prefix is byte-stable across batches.
    mary = ta.triage_selected("email", BATCH, ["cfo"], owner_user_id="mary", config={})
    assert mary[0].ok and "Mary@CFO rule" in model.calls[-1]["prompt"]
    assert "John@" not in model.calls[-1]["prompt"]
    ta.run_profile_triage("email", {**BATCH, "batch_id": "b-2", "emails": []},
                          profile="cfo", owner_user_id="john", config={})
    prefix = ta._prompt_prefix("email", homes["cfo"], "john")
    assert model.calls[-1]["prompt"].startswith(prefix) and prompt.startswith(prefix)


def test_a_non_member_owner_is_refused_without_a_turn(box, monkeypatch):
    _layers(box)
    model = Model()
    monkeypatch.setattr(ta, "_default_runner", model)
    outs = [
        ta.run_profile_triage("email", BATCH, profile="hr", owner_user_id="john", config={}),
        ta.run_profile_triage("email", BATCH, profile="cmo", owner_user_id="sus", config={}),
        ta.run_profile_triage("email", BATCH, profile="cfo", owner_user_id="nobody", config={}),
        ta.run_profile_triage("email", BATCH, profile="ghost", owner_user_id="john", config={}),
    ]
    assert all(o.error and o.error.startswith("refused") and o.result is None for o in outs)
    assert "john is not an active person" in outs[0].error
    assert "sus is not an active person" in outs[1].error
    assert "no profile 'ghost'" in outs[3].error
    assert model.calls == []


def _sources(box):
    async def setup(c):
        john = await registry.register_source(c, channel="email", address=MAILBOX, owner_user_id="john")
        mary = await registry.register_source(
            c, channel="email", address="mary@example.com", owner_user_id="mary")
        return john.source_id, mary.source_id

    return _box(box["dsn"], setup)


def test_comparisons_are_stored_once_without_batch_text_and_owner_only(box, monkeypatch, capsys):
    _layers(box)
    john_src, mary_src = _sources(box)
    monkeypatch.setattr(ta, "_default_runner", Model())
    johns = ta.triage_selected("email", BATCH, ["cfo", "cmo", "hr"], owner_user_id="john", config={})
    kwargs = dict(source_id=john_src, batch_id="b-inv", channel="email", owner_user_id="john",
                  legacy_result=LEGACY, agents=johns, dsn=box["dsn"])
    assert ta.record_comparisons_sync(**kwargs)
    assert ta.record_comparisons_sync(**kwargs)  # idempotent
    marys = ta.triage_selected("email", {**BATCH, "batch_id": "m-1"}, ["cfo"],
                               owner_user_id="mary", config={})
    assert ta.record_comparisons_sync(source_id=mary_src, batch_id="m-1", channel="email",
                                      owner_user_id="mary", legacy_result=None, agents=marys,
                                      dsn=box["dsn"])
    assert not ta.record_comparisons_sync(**{**kwargs, "dsn": "postgresql://nobody@127.0.0.1:1/none"})
    assert not ta.record_comparisons_sync(**{**kwargs, "source_id": "not-a-source"})

    async def rows(c):
        return [dict(r) for r in await c.fetch(
            f"SELECT * FROM {registry.BOX_SCHEMA}.triage_comparisons ORDER BY comparison_id")]

    stored = _box(box["dsn"], rows)
    assert [(r["batch_id"], r["profile"], r["owner_user_id"]) for r in stored] == [
        ("b-inv", "cfo", "john"), ("b-inv", "cmo", "john"), ("b-inv", "hr", "john"),
        ("m-1", "cfo", "mary")]
    assert stored[2]["agent_result"] is None and stored[2]["agent_error"].startswith("refused")
    assert stored[0]["session_id"] == "triage_email_b-inv_cfo" and stored[0]["skills_layer"] == "user"
    assert not any(t in json.dumps(stored, default=str) for t in ("INV-77", "HKD 12,000"))

    # API: each owner sees only their own.
    _session_as(monkeypatch, "john")
    john = _client("john")
    body = john.get("/api/sources/comparisons").json()["comparisons"]
    assert sorted(c["profile"] for c in body) == ["cfo", "cmo", "hr"]
    assert body[0]["legacy_result"] == LEGACY and {c["owner_user_id"] for c in body} == {"john"}
    one = john.get("/api/sources/comparisons",
                   params={"source_id": john_src, "batch_id": "b-inv", "limit": 1}).json()
    assert len(one["comparisons"]) == 1
    assert john.get("/api/sources/comparisons", params={"source_id": mary_src}).json() == {"comparisons": []}
    assert john.get("/api/sources/comparisons?all=1").status_code == 403

    _session_as(monkeypatch, "mary")
    mary = _client("mary")
    mine = mary.get("/api/sources/comparisons").json()["comparisons"]
    assert [(c["batch_id"], c["agent_result"], c["legacy_result"]) for c in mine] == [("m-1", REPLY, None)]
    assert mary.get("/api/sources/comparisons", params={"batch_id": "b-inv"}).json() == {"comparisons": []}
    assert mary.get("/api/sources/comparisons?all=1").status_code == 403

    _session_as(monkeypatch, "leo")  # the box owner, for support
    leo = _client("leo")
    assert len(leo.get("/api/sources/comparisons?all=1").json()["comparisons"]) == 4
    assert leo.get("/api/sources/comparisons").json() == {"comparisons": []}

    # CLI.
    out = _cli(["comparisons", "--as", "john", "--source", f"email:{MAILBOX}", "--json"], capsys)
    assert sorted(c["profile"] for c in out["comparisons"]) == ["cfo", "cmo", "hr"]
    assert len(_cli(["comparisons", "--all", "--json"], capsys)["comparisons"]) == 4
    assert _cli(["comparisons", "--as", "mary", "--source", john_src, "--json"], capsys) == {
        "comparisons": []}


def test_migrate_box_creates_the_comparisons_table(box):
    from hermes_cli.db_migrate import migrate_box

    async def drop_and_check():
        c = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            await c.execute(f"DROP TABLE IF EXISTS {registry.BOX_SCHEMA}.triage_comparisons")
            await migrate_box(box["dsn"])
            return await c.fetchval("SELECT to_regclass('aquarium_box.triage_comparisons')")
        finally:
            await c.close()

    _box(box["dsn"], lambda c: registry.list_sources(c))
    assert asyncio.run(drop_and_check()) is not None
