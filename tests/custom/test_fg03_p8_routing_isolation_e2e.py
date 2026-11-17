"""FG-03 P8 E2E, part two: router failure, isolation between users, one owner
per source, and the shadow router with legacy triage.

Split out of ``test_fg03_p8_e2e.py`` (same fixtures, same stand-ins) so each
file stays well under the runner's per-file timeout on CI.
"""

import pytest

from hermes_cli import source_registry as registry
import tests.custom.test_fg03_profile_triage_e2e as p5
from tests.custom.test_fg03_batch_routing import credit  # noqa: F401 — pytest fixture
from tests.custom.test_fg03_p8_e2e import (  # noqa: F401 — pytest fixtures
    CARE,
    CHANNELS,
    SENDER,
    _api,
    _memory,
    _nothing_for_mary,
    _propose_reply,
    _routers,
    _source_ids,
    _why,
    box,
    design,
    model,
)
from tests.custom.test_fg03_profile_triage_e2e import NOTHING, _arrival_entries, _profile_rows
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: F401
from tests.hermes_cli.test_fg03_reply_accounts_e2e import (  # noqa: F401 — pytest fixture
    JOHN_BOT,
    JOHN_MAIL,
    JOHN_WA,
    MARY_MAIL,
    world,
)


@pytest.mark.parametrize("kind", CHANNELS)
def test_router_failure_falls_back_to_every_routed_profile(design, model, box, monkeypatch, kind):  # noqa: F811
    pipe, john, _mary = design(kind)
    model.router_fails = True
    batch_id = pipe.arrive("chat", john[kind])  # would route nowhere
    pipe.triage()

    attempts = len(_routers(model))
    assert attempts == 1 + 3  # one call, retried 3 times
    assert sorted(model.turns()) == [[("John", "CFO")], [("John", "CMO")]]
    rows = _profile_rows(box)
    assert [o for o, _ in rows["cfo"]["todos"]] == ["john"] == [o for o, _ in rows["cmo"]["todos"]]
    assert rows["default"] == NOTHING
    _nothing_for_mary(box, monkeypatch)
    [why] = _why(monkeypatch, "john", john[kind], batch_id)
    assert why["selected"] == ["cfo", "cmo"] and why["fallback"]

    pipe.triage()  # a later pass never re-routes the batch
    assert len(_routers(model)) == attempts


def test_mary_and_john_never_see_each_other(design, model, box, world, monkeypatch):  # noqa: F811
    pipe, john, mary = design("email")
    johns = pipe.arrive("launch", john["email"])
    marys = pipe.arrive("invoice", mary, owner="mary", account=MARY_MAIL)
    pipe.triage()

    assert pipe.pending() == []
    routers = _routers(model)
    assert len(routers) == 2  # one per batch
    cares = sorted(CARE.findall(r[1]) for r in routers)
    assert cares == [[("John", "CFO"), ("John", "CMO")], [("Mary", "CFO")]]  # Mary's source: CFO only
    assert sorted(model.turns()) == [[("John", "CFO")], [("John", "CMO")], [("Mary", "CFO")]]
    rows = _profile_rows(box)
    assert sorted(rows["cfo"]["todos"]) == [("john", "Pay INV-77 (John@CFO)"),
                                            ("mary", "Pay INV-77 (Mary@CFO)")]
    assert rows["cmo"]["todos"] == [("john", "Pay INV-77 (John@CMO)")]
    assert [t["title"] for t in p5._todo_dicts(box, "cfo", "john")] == ["Pay INV-77 (John@CFO)"]
    assert [t["title"] for t in p5._todo_dicts(box, "cfo", "mary")] == ["Pay INV-77 (Mary@CFO)"]
    assert p5._todo_dicts(box, "cmo", "mary") == []
    assert "Mary" not in _memory(box, "cfo", "john") + _memory(box, "cmo", "john")
    assert "John" not in _memory(box, "cfo", "mary") + _memory(box, "cmo", "mary")
    assert "(Mary@CFO)" in _memory(box, "cfo", "mary")

    [j] = _arrival_entries(monkeypatch, "john")
    [m] = _arrival_entries(monkeypatch, "mary")
    assert j["context"]["profiles"] == ["cfo", "cmo"] and m["context"]["profiles"] == ["cfo"]
    assert [d["batch_id"] for d in _api(monkeypatch, "john", "/api/sources/decisions").json()[
        "decisions"]] == [johns]
    assert [d["batch_id"] for d in _api(monkeypatch, "mary", "/api/sources/decisions").json()[
        "decisions"]] == [marys]
    assert _why(monkeypatch, "john", mary, marys) == [] and _why(monkeypatch, "mary", john["email"], johns) == []
    assert _api(monkeypatch, "mary", "/api/sources/decisions", params={"all": 1}).status_code == 403
    mine = {s["address"] for s in _api(monkeypatch, "mary", "/api/sources").json()["sources"]}
    assert mine == {MARY_MAIL}

    # Mary's reply leaves through her mailbox; John's to-do is not hers to answer.
    [todo] = p5._todo_dicts(box, "cfo", "mary")
    proposal = _propose_reply(world, "cfo", "mary", todo["id"])
    assert world["sent"] == []
    assert _api(monkeypatch, "mary",
                f"/api/comms/notifications/{proposal.notification_id}/answer?profile=cfo",
                method="post", json={"answer": "approved"}).json()["action"]["event"] == "sent"
    [sent] = world["sent"]
    assert (sent["from"], sent["chat_id"]) == (MARY_MAIL, SENDER["email"])


@pytest.mark.parametrize("kind", CHANNELS)
def test_a_source_has_one_owner(design, model, box, monkeypatch, kind):  # noqa: F811
    pipe, john, _mary = design(kind)
    address = {"email": JOHN_MAIL, "whatsapp": f"+{JOHN_WA}", "telegram": f"tgbot:{JOHN_BOT}"}[kind]
    claim = _api(monkeypatch, "mary", "/api/sources", method="post",
                 json={"channel": kind, "address": address})
    assert claim.status_code == 409, claim.text
    assert "john" not in claim.json()["detail"].lower().replace(JOHN_MAIL, "")
    assert _source_ids(box)[(kind, "john", registry.normalize_address(kind, address))] == john[kind]
    assert all(owner != "mary" or a == MARY_MAIL for (_c, owner, a) in _source_ids(box))

    # The refused claim changes nothing: John's batch still routes to John only.
    pipe.arrive("invoice", john[kind])
    pipe.triage()
    assert model.turns() == [[("John", "CFO")]]
    _nothing_for_mary(box, monkeypatch)


@pytest.mark.parametrize("kind", ["email", "whatsapp"])
def test_shadow_router_with_legacy_triage_is_unchanged(design, model, box, monkeypatch, kind):  # noqa: F811
    """Today's default: the router only records; the legacy triage acts, box-wide."""
    pipe, john, _mary = design(kind, router="shadow", agent="legacy")
    batch_id = pipe.arrive("invoice", john[kind])
    pipe.triage()

    assert pipe.pending() == [] and model.kinds() == ["router", "legacy"]
    assert pipe.ch.box_rows()["escalations"] == ["legacy verdict"]
    rows = _profile_rows(box)
    assert [t for _, t in rows["default"]["todos"]] == ["Legacy to-do"]
    assert rows["cfo"] == NOTHING and rows["cmo"] == NOTHING
    [why] = _why(monkeypatch, "john", john[kind], batch_id)
    assert why["selected"] == ["cfo"]  # recorded, not acted on
