"""FG-03 P4 E2E: the real email/WhatsApp triage scripts route through the real
router on real Postgres.

The box registry, routes and "What I care about" sections are real (see
``test_triage_router_e2e``); ``config.yaml`` turns the router on and the
scripts read it themselves. Only the cheap model (keyword stand-in) and the
DeepSeek triage are stubbed.
"""

import json
from pathlib import Path

import pytest
import yaml

from hermes_cli import source_registry as registry
from hermes_cli import triage_router as tr
from hermes_cli import triage_skills as tsk
from tests.custom.test_fg03_batch_routing import (  # noqa: F401 — pytest fixtures
    Pipeline,
    credit,
    email_triage,
    wa_triage,
)
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_source_registry_e2e import _box, box  # noqa: F401 — pytest fixture
from tests.hermes_cli.test_triage_router_e2e import KeywordModel

ADDRESS = {"email": "john@example.com", "whatsapp": "85291234567"}
TEXT = {
    "b-invoice": "Invoice INV-77 is overdue",
    "b-launch": "Launch plan and the agency invoice",
    "b-chat": "Are we on for Friday?",
}


def _set_mode(hermes_root, mode):  # noqa: F811
    path = hermes_root / "config.yaml"
    config = yaml.safe_load(path.read_text()) or {}
    config["triage"] = {"router": {"mode": mode, "retry_delay_seconds": 0}}
    path.write_text(yaml.safe_dump(config))


def _johns_source(box, kind):  # noqa: F811
    homes = box["homes"]
    tsk.write_care(kind, "John@CFO: invoices and payments", layer="user",
                   home=homes["cfo"], user_id="john", author="john")
    tsk.write_care(kind, "CMO template: campaigns and launches", layer="template",
                   home=homes["cmo"], author="cmo_owner")

    async def setup(c):
        src = await registry.register_source(c, channel=kind, address=ADDRESS[kind],
                                             owner_user_id="john")
        for profile in ("cfo", "cmo"):
            await registry.set_route(c, source_id=src.source_id, profile_slug=profile,
                                     enabled=True, actor_user_id="john")
        return src.source_id

    return _box(box["dsn"], setup)


def _write(pipe, batch_id, source_id):
    path = pipe.write(batch_id, source_id=source_id)
    batch = json.loads(path.read_text())
    batch["owner_user_id"] = "john"
    if pipe.kind == "email":
        batch["emails"][0]["body_text"] = TEXT[batch_id]
    else:
        batch["messages"][0]["text"] = TEXT[batch_id]
    path.write_text(json.dumps(batch))
    return path


def _stored(box):  # noqa: F811
    async def rows(c):
        return {r["batch_id"]: list(r["selected"]) for r in await c.fetch(
            f"SELECT batch_id, selected FROM {registry.BOX_SCHEMA}.routing_decisions")}

    return _box(box["dsn"], rows)


@pytest.mark.parametrize("kind", ["email", "whatsapp"])
@pytest.mark.parametrize("mode", ["shadow", "enforce"])
def test_triage_scripts_route_through_the_real_router(
        kind, mode, box, hermes_root, request, monkeypatch):  # noqa: F811
    source_id = _johns_source(box, kind)
    _set_mode(hermes_root, mode)
    model = KeywordModel()
    monkeypatch.setattr(tr, "_AuxiliaryLLM", lambda: model)
    module = request.getfixturevalue("email_triage" if kind == "email" else "wa_triage")
    pipe = Pipeline(kind, module, monkeypatch)

    paths = {b: _write(pipe, b, source_id) for b in TEXT}
    for path in paths.values():
        pipe.run(path)

    assert len(model.calls) == len(TEXT)  # one router call per batch
    assert all(TEXT[b] in user for b, (_, user) in zip(TEXT, model.calls))
    assert _stored(box) == {"b-invoice": ["cfo"], "b-launch": ["cfo", "cmo"], "b-chat": []}
    expected = list(TEXT) if mode == "shadow" else ["b-invoice", "b-launch"]
    assert pipe.triaged == expected and pipe.stored == expected
    assert all(pipe.done(p) for p in paths.values())


def test_unreachable_registry_falls_through_to_triage(
        box, hermes_root, email_triage, monkeypatch):  # noqa: F811
    _set_mode(hermes_root, "enforce")
    monkeypatch.setattr(registry, "box_dsn", lambda config=None: "postgresql://nobody@127.0.0.1:1/none")
    monkeypatch.setattr(tr, "_AuxiliaryLLM", KeywordModel)
    pipe = Pipeline("email", email_triage, monkeypatch)
    path = _write(pipe, "b-chat", "33333333-3333-3333-3333-333333333333")
    pipe.run(path)
    assert pipe.triaged == ["b-chat"] and pipe.done(path)
