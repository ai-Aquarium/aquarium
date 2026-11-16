"""FG-03 P7 E2E — the backend behind the sources UI, on real Postgres.

Real profiles over a tmp hermes root and the real box registry (see
``test_source_registry_e2e``): pausing/relabelling a source through the real
API and CLI (and every reader skipping a paused one), claim conflicts as box
admins' "Needs you" entries settled by keep/transfer, and the routing
decision's message count / first sender filled in from real email, WhatsApp
and Telegram batches by the pipelines' routing step. Only the cheap router
model is a stand-in.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import asyncpg
import pytest

from hermes_cli import source_polling
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
from tests.hermes_cli.test_triage_router_e2e import KeywordModel, NoModel

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "custom"))

ROUTER = {"triage": {"router": {"mode": "shadow", "retry_delay_seconds": 0}}}


def _johns(box, channel, address):
    for profile in ("cfo", "cmo"):
        tsk.write_care(channel, f"John@{profile.upper()}: invoices and launches", layer="user",
                       home=box["homes"][profile], user_id="john", author="john")

    async def setup(c):
        src = await registry.register_source(c, channel=channel, address=address,
                                             owner_user_id="john")
        await registry.set_route(c, source_id=src.source_id, profile_slug="cfo",
                                 enabled=True, actor_user_id="john")
        return src.source_id

    return _box(box["dsn"], setup)


# -- 1. pause / relabel a source ---------------------------------------------------


def test_patch_source_is_owner_or_box_admin_and_readers_skip_it(box, monkeypatch, capsys):
    source_id = _johns(box, "email", MAILBOX)

    _session_as(monkeypatch, "mary")
    assert _client("mary").patch(f"/api/sources/{source_id}",
                                 json={"enabled": False}).status_code == 403

    _session_as(monkeypatch, "john")
    john = _client("john")
    r = john.patch(f"/api/sources/{source_id}", json={"enabled": False, "display": "  Work  mail "})
    assert r.status_code == 200, r.text
    source = r.json()["source"]
    assert (source["enabled"], source["display"]) == (False, "Work mail")
    assert [(x["profile"], x["enabled"]) for x in source["routes"]] == [("cfo", True)]  # kept
    # Omitted fields stay; null clears the label; bad input is refused.
    r = john.patch(f"/api/sources/{source_id}", json={})
    assert (r.json()["source"]["enabled"], r.json()["source"]["display"]) == (False, "Work mail")
    assert john.patch(f"/api/sources/{source_id}", json={"display": None}).json()["source"]["display"] is None
    assert john.patch(f"/api/sources/{source_id}", json={"display": "x" * 201}).status_code == 400
    assert john.patch(f"/api/sources/{source_id}", json={"enabled": "nope"}).status_code == 422
    assert john.patch("/api/sources/00000000-0000-0000-0000-000000000000",
                      json={"enabled": True}).status_code == 404

    # Nothing reads a paused source: pollers, the router (no model call).
    plan = asyncio.run(source_polling.load_poll_plan_async(
        "email", config={"source_registry": {"pollers": "registry"}}, dsn=box["dsn"]))
    assert plan.from_registry and plan.sources == ()
    paused = _box(box["dsn"], lambda c: tr.route_batch(
        c, source_id=source_id, batch_id="b1", batch_text="Invoice", config=ROUTER, llm=NoModel()))
    assert paused.selected == [] and paused.choices == ()

    # The box admin may resume it (and the CLI has the same switch).
    _session_as(monkeypatch, "leo")
    assert _client("leo").patch(f"/api/sources/{source_id}",
                                json={"enabled": True}).json()["source"]["enabled"] is True
    plan = asyncio.run(source_polling.load_poll_plan_async(
        "email", config={"source_registry": {"pollers": "registry"}}, dsn=box["dsn"]))
    assert [s.source_id for s in plan.sources] == [source_id]
    out = _cli(["disable", f"email:{MAILBOX}", "--as", "john", "--json"], capsys)
    assert out["source"]["enabled"] is False
    assert _cli(["enable", source_id, "--as", "john", "--json"], capsys)["source"]["enabled"] is True


# -- 3. claim conflicts --------------------------------------------------------------


def _claims(monkeypatch, user):
    _session_as(monkeypatch, user)
    items = _client(user).get("/api/needs-you").json()["items"]
    return [i for i in items if i["source"] == "source_claim"]


def test_claim_conflict_is_a_box_admin_needs_you_entry_settled_by_keep_or_transfer(
    box, monkeypatch, capsys,
):
    source_id = _johns(box, "whatsapp", "+852 9123 4567")
    _session_as(monkeypatch, "mary")
    assert _client("mary").post(
        "/api/sources", json={"channel": "whatsapp", "address": "85291234567"}).status_code == 409

    # Only the box owner/admin is asked.
    assert _claims(monkeypatch, "john") == [] and _claims(monkeypatch, "mary") == []
    [entry] = _claims(monkeypatch, "leo")
    conflict_id = entry["context"]["conflict_id"]
    assert entry["id"] == f"source_claim:{conflict_id}"
    assert entry["severity"] == "approval"
    assert entry["context"] == {
        "conflict_id": conflict_id, "channel": "whatsapp", "address": "85291234567",
        "claimant_user_id": "mary", "existing_owner_user_id": "john",
    }
    endpoint = f"/api/sources/conflicts/{conflict_id}/resolve"
    assert [(a["id"], a["endpoint"], a["body"]) for a in entry["actions"]] == [
        ("keep", endpoint, {"action": "keep"}), ("transfer", endpoint, {"action": "transfer"})]

    for user in ("john", "mary"):  # not box admins
        _session_as(monkeypatch, user)
        assert _client(user).post(endpoint, json={"action": "transfer"}).status_code == 403

    _session_as(monkeypatch, "leo")
    leo = _client("leo")
    assert leo.post(endpoint, json={"action": "maybe"}).status_code == 422
    assert leo.post("/api/sources/conflicts/999999/resolve",
                    json={"action": "keep"}).status_code == 404
    r = leo.post(endpoint, json={"action": "transfer"})
    assert r.status_code == 200, r.text
    conflict = r.json()["conflict"]
    assert conflict["resolution"] == "transfer" and conflict["resolved_at"]
    moved = _box(box["dsn"], lambda c: registry.get_source(c, source_id))
    # Mary owns it now; John's route (to his profile) is gone.
    assert moved.owner_user_id == "mary" and moved.routes == ()
    assert _claims(monkeypatch, "leo") == []
    _session_as(monkeypatch, "leo")
    assert leo.post(endpoint, json={"action": "keep"}).status_code == 409

    # John claims it back: the admin keeps it with Mary (CLI).
    _session_as(monkeypatch, "john")
    assert _client("john").post(
        "/api/sources", json={"channel": "whatsapp", "address": "85291234567"}).status_code == 409
    [entry] = _claims(monkeypatch, "leo")
    assert entry["context"]["claimant_user_id"] == "john"
    assert entry["context"]["existing_owner_user_id"] == "mary"
    out = _cli(["resolve", str(entry["context"]["conflict_id"]), "keep", "--json"], capsys)
    assert out["conflict"]["resolution"] == "keep"
    assert _box(box["dsn"], lambda c: registry.get_source(c, source_id)).owner_user_id == "mary"
    assert _claims(monkeypatch, "leo") == []
    resolved = _cli(["conflicts", "--resolved", "--json"], capsys)["conflicts"]
    assert [c["resolution"] for c in resolved] == ["transfer", "keep"]


def test_transfer_of_a_removed_source_registers_it_to_the_claimant(box):
    async def scenario(c):
        src = await registry.register_source(c, channel="email", address=MAILBOX,
                                             owner_user_id="john")
        with pytest.raises(registry.SourceOwnedByAnotherUser):
            await registry.register_source(c, channel="email", address=MAILBOX,
                                           owner_user_id="mary")
        [conflict] = await registry.list_conflicts(c)
        await registry.remove_source(c, source_id=src.source_id, actor_user_id="john")
        settled = await registry.settle_conflict(
            c, conflict_id=conflict.conflict_id, action="transfer", actor_user_id="leo")
        return settled, await registry.get_source_by_address(c, "email", MAILBOX)

    settled, source = _box(box["dsn"], scenario)
    assert settled.resolution == "transfer" and source.owner_user_id == "mary"


# -- 4. decision summary ----------------------------------------------------------------


def _email_batch(source_id):
    return {"batch_id": "e1", "channel": "email", "source_id": source_id,
            "owner_user_id": "john", "sender": "ap@supplier.com", "sender_name": "Supplier AP",
            "emails": [{"from_addr": "ap@supplier.com", "from_name": "Supplier AP",
                        "subject": "Invoice INV-77", "body_text": "Invoice INV-77 is overdue"},
                       {"from_addr": "boss@supplier.com", "subject": "Re: invoice",
                        "body_text": "Please pay the invoice"}]}


def _wa_batch(source_id):
    return {"batch_id": "w1", "source_id": source_id, "sender_phone": "+85211112222",
            "owner_user_id": "john",
            "messages": [{"text": "invoice INV-78 attached", "sender_name": "Ann"},
                         {"text": "please confirm the invoice", "sender_name": "Ann"},
                         {"text": "", "media_type": "image", "sender_name": "Ann"}]}


def _tg_batch(source_id):
    return {"batch_id": "t1", "channel": "telegram", "source_id": source_id,
            "owner_user_id": "john", "chat_type": "private",
            "messages": [{"sender_name": "Bob", "sender_username": "bob",
                          "text": "the launch invoice"}]}


@pytest.mark.parametrize(("kind", "address", "make", "expected"), [
    ("email", MAILBOX, _email_batch, (2, "Supplier AP <ap@supplier.com>")),
    ("whatsapp", "85291234567", _wa_batch, (3, "Ann <+85211112222>")),
    ("telegram", "123456789", _tg_batch, (1, "Bob <@bob>")),
])
def test_routing_step_stores_message_count_and_first_sender(
    box, monkeypatch, capsys, kind, address, make, expected,
):
    from shared import batch_routing

    source_id = _johns(box, kind, address)
    model = KeywordModel()
    monkeypatch.setattr(tr, "_AuxiliaryLLM", lambda: model)
    batch = make(source_id)
    outcome = batch_routing.route(kind, batch, config=ROUTER, log=lambda _m: None)
    assert outcome.decision is not None and len(model.calls) == 1
    assert (outcome.decision.message_count, outcome.decision.first_sender) == expected

    _session_as(monkeypatch, "john")
    [decision] = _client("john").get(
        "/api/sources/decisions", params={"source_id": source_id, "batch_id": batch["batch_id"]},
    ).json()["decisions"]
    assert (decision["message_count"], decision["first_sender"]) == expected

    async def stored(c):
        return [dict(r) for r in await c.fetch(
            f"SELECT * FROM {registry.BOX_SCHEMA}.routing_decisions")]

    blob = json.dumps(_box(box["dsn"], stored), default=str)
    assert not any(t in blob for t in ("INV-7", "overdue", "confirm", "launch invoice"))
    text = json.dumps(_cli(["decisions", "--as", "john", "--json"], capsys))
    assert str(expected[1]) in text


def test_initialize_box_adds_the_p7_columns_to_an_old_box(box):
    async def downgrade_and_reconnect():
        c = await asyncpg.connect(box["dsn"], ssl=False)
        try:
            await c.execute(f"ALTER TABLE {registry.BOX_SCHEMA}.routing_decisions "
                            "DROP COLUMN message_count, DROP COLUMN first_sender")
            await c.execute(f"ALTER TABLE {registry.BOX_SCHEMA}.source_claim_conflicts "
                            "DROP COLUMN resolution")
        finally:
            await c.close()
        box_conn = await registry.connect_box(dsn=box["dsn"])  # the initialize_box path
        try:
            return {r["column_name"] for r in await box_conn.fetch(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = $1",
                registry.BOX_SCHEMA)}
        finally:
            await box_conn.close()

    _box(box["dsn"], lambda c: registry.list_sources(c))
    columns = asyncio.run(downgrade_and_reconnect())
    assert {"message_count", "first_sender", "resolution"} <= columns


# -- register WhatsApp / Telegram from the caller's own credential ---------------------

JOHN_NUMBER = "85291234567"
JOHN_TOKEN = "12345:john-bot-secret"


def _own_credentials(box, hermes_root):  # noqa: F811
    """John's bridge ``johnwa`` (linked) and ``spare`` (not linked), Mary's bridge
    ``marywa`` on John's number, and John's saved Telegram bot, all in the default
    profile (the request's)."""
    from hermes_cli import wa_bridge_owners as owners
    from hermes_cli.access import PrincipalStore
    from hermes_cli.console_scope import _scoped_to
    from hermes_cli.credential_store import SupabaseCredentialStore
    from hermes_cli.datastore import get_store
    from tests.hermes_cli._pg_fixture import pg_config

    for name, user, number in (("johnwa", "john", JOHN_NUMBER), ("spare", "john", None),
                               ("marywa", "mary", JOHN_NUMBER)):
        owners.record_owner(name, user, port=3101 if name == "johnwa" else None)
        session = owners.session_dir(name)
        session.mkdir(parents=True, exist_ok=True)
        if number:
            (session / "creds.json").write_text(json.dumps({"me": {"id": f"{number}:7@s.whatsapp.net"}}))

    async def init():
        with _scoped_to(box["homes"]["default"]):
            app = get_store("supabase-app", "prod", config=pg_config(box["dsn"]))
            store = SupabaseCredentialStore(app)
            await store.initialize()
            john = await PrincipalStore(app).get("john")
            await store.put(john, provider="telegram", name="bot", kind="telegram-bot",
                            payload={"token": JOHN_TOKEN, "bot_username": "johns_bot"})

    asyncio.run(init())


def test_register_whatsapp_and_telegram_from_the_callers_own_credential(
    box, hermes_root, monkeypatch,  # noqa: F811
):
    _own_credentials(box, hermes_root)
    _session_as(monkeypatch, "john")
    john = _client("john")

    r = john.post("/api/sources", json={
        "channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "johnwa"}})
    assert r.status_code == 200, r.text
    wa = r.json()["source"]
    assert (wa["channel"], wa["address"], wa["owner_user_id"], wa["display"]) == (
        "whatsapp", JOHN_NUMBER, "john", "johnwa")
    assert wa["credential_ref"] == {"profile": "default", "kind": "wa-bridge", "bridge": "johnwa",
                                    "owner_user_id": "john", "port": 3101}

    r = john.post("/api/sources", json={"channel": "telegram",
                                        "credential_ref": {"kind": "telegram-bot"}})
    assert r.status_code == 200, r.text
    tg = r.json()["source"]
    assert (tg["address"], tg["display"]) == ("12345", "@johns_bot")
    assert tg["credential_ref"] == {"profile": "default", "kind": "telegram-bot",
                                    "provider": "telegram", "name": "bot", "owner_user_id": "john"}
    assert "secret" not in r.text

    # Refusals: wrong kind/channel, unlinked or unknown bridges, no address for email.
    for body, status in (
        ({"channel": "whatsapp", "credential_ref": {"kind": "telegram-bot"}}, 400),
        ({"channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "spare"}}, 409),
        ({"channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "nope"}}, 404),
        ({"channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "../x"}}, 400),
        ({"channel": "email", "credential_ref": {"kind": "email-imap"}}, 400),
        ({"channel": "whatsapp"}, 400),
    ):
        assert john.post("/api/sources", json=body).status_code == status, body

    # Someone else's credential is refused, and nothing leaks the number or token.
    _session_as(monkeypatch, "mary")
    mary = _client("mary")
    for body, status in (
        ({"channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "johnwa"}}, 403),
        ({"channel": "telegram", "credential_ref": {"kind": "telegram-bot"}}, 404),
        # Mary's own bridge, linked to John's number: the one-owner rule, masked.
        ({"channel": "whatsapp", "credential_ref": {"kind": "wa-bridge", "bridge": "marywa"}}, 409),
    ):
        r = mary.post("/api/sources", json=body)
        assert r.status_code == status, (body, r.text)
        assert JOHN_NUMBER not in r.text and "secret" not in r.text and "12345" not in r.text
    _session_as(monkeypatch, "leo")  # the owner can see John's credential row, but not use it
    r = _client("leo").post("/api/sources", json={"channel": "telegram",
                                                  "credential_ref": {"kind": "telegram-bot"}})
    assert r.status_code in (403, 404) and "secret" not in r.text

    # The email address path is unchanged.
    _session_as(monkeypatch, "john")
    r = john.post("/api/sources", json={"channel": "email", "address": "John@Example.com"})
    assert r.status_code == 200 and r.json()["source"]["address"] == MAILBOX
    owners = {s["address"]: s["owner_user_id"]
              for s in _box(box["dsn"], lambda c: registry.list_sources(c))
              for s in [s.as_dict()]}
    assert owners == {JOHN_NUMBER: "john", "12345": "john", MAILBOX: "john"}
