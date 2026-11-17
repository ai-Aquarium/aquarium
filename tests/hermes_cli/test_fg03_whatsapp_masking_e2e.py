"""FG-03: a WhatsApp source's number never reaches a browser unmasked.

Real profiles over a tmp hermes root and the real box registry on Docker
Postgres (as ``test_fg03_p7_e2e``): registering from the caller's own bridge,
listing, relabelling, routing, refused claims (typed and bridge-derived),
conflicts, the box admin's "Needs you" entry, settling and transferring, and
routing decisions all show ``+85••••••67``; the registry keeps the full
number, and source ids / routes keep working. Only the cheap router model is
a stand-in.
"""

from __future__ import annotations

import pytest

from hermes_cli import source_registry as registry
from hermes_cli import triage_router as tr
from hermes_cli import triage_skills as tsk
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_fg03_p7_e2e import JOHN_NUMBER, ROUTER, _claims, _own_credentials
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: F401 — pytest fixture
    _box,
    _client,
    _session_as,
    box,
)
from tests.hermes_cli.test_triage_router_e2e import KeywordModel

MASKED = "+85••••••67"
#: The full number, and its hidden middle on its own.
RAW = (JOHN_NUMBER, JOHN_NUMBER[2:-2])


def _no_raw(response, what):
    assert response.status_code < 500, (what, response.text)
    for raw in RAW:
        assert raw not in response.text, (what, response.text)
    return response


def test_whatsapp_number_is_masked_in_every_sources_response(
    box, hermes_root, monkeypatch,  # noqa: F811
):
    from shared import batch_routing

    _own_credentials(box, hermes_root)
    tsk.write_care("whatsapp", "John@CFO: invoices", layer="user",
                   home=box["homes"]["cfo"], user_id="john", author="john")

    # John registers his own bridge's number.
    _session_as(monkeypatch, "john")
    john = _client("john")
    r = _no_raw(john.post("/api/sources", json={
        "channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "johnwa"}}),
        "register")
    assert r.status_code == 200 and r.json()["source"]["address"] == MASKED
    source_id = r.json()["source"]["source_id"]
    assert JOHN_NUMBER not in source_id  # ids are uuids: URLs never carry the number

    # The id still drives every per-source route.
    r = _no_raw(john.put(f"/api/sources/{source_id}/routes/cfo", json={"enabled": True}), "route")
    assert r.status_code == 200, r.text
    r = _no_raw(john.patch(f"/api/sources/{source_id}", json={"display": "Work phone"}), "patch")
    assert r.json()["source"]["address"] == MASKED
    [listed] = _no_raw(john.get("/api/sources"), "list").json()["sources"]
    assert (listed["source_id"], listed["address"]) == (source_id, MASKED)

    # Mary claims it, typed in two forms and via her own bridge on that number.
    _session_as(monkeypatch, "mary")
    mary = _client("mary")
    for body in ({"channel": "whatsapp", "address": "+852 9123 4567"},
                 {"channel": "whatsapp", "address": JOHN_NUMBER},
                 {"channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "marywa"}}):
        assert _no_raw(mary.post("/api/sources", json=body), body).status_code == 409
    [mine] = _no_raw(mary.get("/api/sources/conflicts"), "conflicts").json()["conflicts"]
    assert mine["address"] == MASKED

    # The box admin: every source, every conflict, the Needs you entry.
    _session_as(monkeypatch, "leo")
    leo = _client("leo")
    [everyone] = _no_raw(leo.get("/api/sources", params={"all": 1}), "list all").json()["sources"]
    assert everyone["address"] == MASKED
    conflicts = _no_raw(leo.get("/api/sources/conflicts", params={"all": 1}),
                        "conflicts all").json()["conflicts"]
    assert {c["address"] for c in conflicts} == {MASKED}
    _no_raw(leo.get("/api/needs-you"), "needs-you")
    [entry] = _claims(monkeypatch, "leo")
    assert entry["context"]["address"] == MASKED and MASKED in entry["title"]
    r = _no_raw(leo.post(f"/api/sources/conflicts/{entry['context']['conflict_id']}/resolve",
                         json={"action": "keep"}), "resolve")
    assert r.status_code == 200 and r.json()["conflict"]["address"] == MASKED

    # A routed batch the number sent itself (a note to self): the decision masks it.
    model = KeywordModel()
    monkeypatch.setattr(tr, "_AuxiliaryLLM", lambda: model)
    batch = {"batch_id": "w-self", "source_id": source_id, "sender_phone": f"+{JOHN_NUMBER}",
             "owner_user_id": "john", "messages": [{"text": "invoice INV-9", "sender_name": "John"}]}
    outcome = batch_routing.route("whatsapp", batch, config=ROUTER, log=lambda _m: None)
    assert outcome.decision is not None and JOHN_NUMBER in outcome.decision.first_sender
    _session_as(monkeypatch, "john")
    [decision] = _no_raw(john.get("/api/sources/decisions", params={"source_id": source_id}),
                         "decisions").json()["decisions"]
    assert decision["first_sender"] == f"John <{MASKED}>"
    _session_as(monkeypatch, "leo")
    _no_raw(leo.get("/api/sources/decisions", params={"all": 1}), "decisions all")

    # Transfer (box admin) answers masked too.
    r = _no_raw(leo.post(f"/api/sources/{source_id}/transfer",
                         json={"new_owner_user_id": "mary"}), "transfer")
    assert r.status_code == 200 and r.json()["source"]["address"] == MASKED

    # The registry itself keeps the full number.
    stored = _box(box["dsn"], lambda c: registry.get_source(c, source_id))
    assert (stored.address, stored.owner_user_id) == (JOHN_NUMBER, "mary")


@pytest.mark.parametrize(("channel", "address", "shown"), [
    ("email", "John@Example.com", "john@example.com"),
    ("telegram", "123456789", "123456789"),
])
def test_email_and_telegram_addresses_are_shown_as_they_are(
    box, monkeypatch, channel, address, shown,
):
    _session_as(monkeypatch, "john")
    r = _client("john").post("/api/sources", json={"channel": channel, "address": address})
    assert r.status_code == 200, r.text
    assert r.json()["source"]["address"] == shown
    [listed] = _client("john").get("/api/sources").json()["sources"]
    assert listed["address"] == shown
