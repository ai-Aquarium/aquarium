"""FG-03 P6 (C) E2E: an approved reply leaves only through the account the
arrival came in on, and only its source's owner can send it.

Real profiles (``default``, ``cfo``, ``cmo``, ``hr``) over a tmp hermes root
and one throwaway Postgres (see ``test_source_registry_e2e``); John and Mary
are people in CFO, John in CMO. John owns a personal mailbox, a Telegram bot
and a WhatsApp bridge in the box source registry; their credentials are saved
in CFO. The real arrival registry, to-do and notification stores, proposal,
approval answer route, ``execute_proposal``, ``send_message_tool`` account
resolution and the email adapter's SMTP sender run; only the network edge is
captured (SMTP, the Telegram/WhatsApp platform send).
"""

import asyncio
import smtplib

import pytest

import hermes_cli.datastore as datastore
from hermes_cli import reply_accounts
from hermes_cli import source_registry as registry
from hermes_cli import todo_outbound
from hermes_cli.access import PrincipalStore
from hermes_cli.console_scope import _scoped_to
from hermes_cli.consent import ConsentPolicy
from hermes_cli.credential_store import SupabaseCredentialStore
from hermes_cli.datastore import get_store
from hermes_cli.human_comms import NotificationStore
from hermes_cli.inbound_registry import InboundRegistry
from hermes_cli.todo_store import TodoStore
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: F401
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: F401
    _box,
    _client,
    _session_as,
    box,
)

JOHN_MAIL = "john@example.com"
JOHN_MAIL_2 = "john.second@example.com"
MARY_MAIL = "mary@example.com"
JOHN_BOT = "12345"
JOHN_BOT_TOKEN = "12345:john-bot-secret"
JOHN_WA = "85291112222"
JOHN_WA_PORT = 3101


def _mailbox(address):
    return {
        "address": address, "username": address, "password": f"pw-{address}",
        "imap_host": "imap.example.com", "imap_port": 993,
        "smtp_host": "smtp.example.com", "smtp_port": 465, "smtp_security": "ssl",
    }


def _cred_ref(kind, provider, name, owner):
    return {"profile": "cfo", "kind": kind, "provider": provider,
            "name": name, "owner_user_id": owner}


@pytest.fixture
def world(box, monkeypatch):  # noqa: F811
    dsn, homes = box["dsn"], box["homes"]
    config = pg_config(dsn)

    async def init(home, *, creds=()):
        with _scoped_to(home):
            app = get_store("supabase-app", "prod", config=config)
            await InboundRegistry(app).initialize()
            await TodoStore(app).initialize()
            await NotificationStore(app, config=config).initialize()
            store = SupabaseCredentialStore(app)
            await store.initialize()
            people = PrincipalStore(app)
            for owner, provider, name, kind, payload in creds:
                await store.put(await people.get(owner), provider=provider,
                                name=name, kind=kind, payload=payload)

    asyncio.run(init(homes["default"]))
    asyncio.run(init(homes["cfo"], creds=[
        ("john", "imap", JOHN_MAIL, "email-imap", _mailbox(JOHN_MAIL)),
        ("john", "imap", JOHN_MAIL_2, "email-imap", _mailbox(JOHN_MAIL_2)),
        ("mary", "imap", MARY_MAIL, "email-imap", _mailbox(MARY_MAIL)),
        ("john", "telegram", "johns-bot", "telegram-bot", {"token": JOHN_BOT_TOKEN}),
    ]))
    asyncio.run(init(homes["cmo"]))
    datastore._verified_schemas.clear()

    async def sources(conn):
        for channel, address, owner, ref in (
            ("email", JOHN_MAIL, "john", _cred_ref("email-imap", "imap", JOHN_MAIL, "john")),
            ("email", JOHN_MAIL_2, "john", _cred_ref("email-imap", "imap", JOHN_MAIL_2, "john")),
            ("email", MARY_MAIL, "mary", _cred_ref("email-imap", "imap", MARY_MAIL, "mary")),
            ("telegram", f"tgbot:{JOHN_BOT}", "john",
             _cred_ref("telegram-bot", "telegram", "johns-bot", "john")),
            ("whatsapp", f"+{JOHN_WA}", "john",
             {"profile": "cfo", "kind": "wa-bridge", "bridge": "john",
              "owner_user_id": "john", "port": JOHN_WA_PORT}),
        ):
            await registry.register_source(conn, channel=channel, address=address,
                                           owner_user_id=owner, credential_ref=ref)

    _box(dsn, sources)

    sent = []

    async def fake_platform(platform, pconfig, chat_id, message, **_kw):
        sent.append({"platform": platform.value, "chat_id": str(chat_id),
                     "token": pconfig.token, "extra": dict(pconfig.extra or {}),
                     "message": message})
        return {"success": True}

    from tools import send_message_tool

    real_send = send_message_tool._send_to_platform

    async def send(platform, pconfig, chat_id, message, **kw):
        if platform.value == "email":  # the real adapter, down to SMTP
            return await real_send(platform, pconfig, chat_id, message, **kw)
        return await fake_platform(platform, pconfig, chat_id, message, **kw)

    monkeypatch.setattr(send_message_tool, "_send_to_platform", send)

    class FakeSMTP:
        def __init__(self, host, port, **_kw):
            self.host, self.port = host, port

        def starttls(self, **_kw):
            pass

        def login(self, user, password):
            self.user, self.password = user, password

        def send_message(self, msg):
            sent.append({"platform": "email", "chat_id": msg["To"], "from": msg["From"],
                         "smtp": (self.host, self.port, self.user, self.password),
                         "message": msg.get_payload(decode=True).decode()})

        def quit(self):
            pass

    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSMTP)
    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr("hermes_cli.send_cmd._load_hermes_env", lambda *a, **k: None)
    return {"dsn": dsn, "homes": homes, "config": config, "sent": sent}


def _app(world):
    return get_store("supabase-app", "prod", config=world["config"])


def _offer(world, profile, user, *, surface, account, conversation, sender,
           override=None, policy=None):
    """``user`` gets an arrival in ``profile`` and a reply proposal for it."""

    async def run():
        with _scoped_to(world["homes"][profile]):
            app = _app(world)
            principal = await PrincipalStore(app).get(user)
            item = await InboundRegistry(app).register(
                principal, surface=surface, external_id=f"x-{surface}-{account}",
                account_id=account, conversation=conversation, sender_id=sender,
                body="Is INV-77 paid?")
            todos = TodoStore(app)
            todo = await todos.create(principal, title="Reply about INV-77",
                                      source_kind="inbound", source_ref=item.id)
            action = todo_outbound.parse_action(
                {"body": "Yes, paid today.", **(override or {})}, arrival=item.as_dict())
            notifications = NotificationStore(app, config=world["config"], policy=policy)
            return await todo_outbound.propose(todos, notifications, principal, todo, action)

    return asyncio.run(run())


def _answer_and_execute(world, profile, user, proposal, answer="approved"):
    async def run():
        with _scoped_to(world["homes"][profile]):
            app = _app(world)
            principal = await PrincipalStore(app).get(user)
            notifications = NotificationStore(app, config=world["config"])
            await notifications.answer(proposal.notification_id, principal,
                                       answer=answer, via="web")
            return await todo_outbound.execute_proposal(
                TodoStore(app), principal, proposal.todo_id)

    return asyncio.run(run())


def _outbound(world, profile, user, todo_id):
    async def run():
        with _scoped_to(world["homes"][profile]):
            app = _app(world)
            principal = await PrincipalStore(app).get(user)
            return sorted(e["event"] for e in await TodoStore(app).list_outbound(principal, todo_id))

    return asyncio.run(run())


def test_johns_reply_leaves_through_his_personal_mailbox(world):
    proposal = _offer(world, "cfo", "john", surface="email", account=JOHN_MAIL,
                      conversation="ann@example.com", sender="ann@example.com")
    outcome = _answer_and_execute(world, "cfo", "john", proposal)

    assert outcome["event"] == "sent", outcome
    assert world["sent"] == [{
        "platform": "email", "chat_id": "ann@example.com", "from": JOHN_MAIL,
        "smtp": ("smtp.example.com", 465, JOHN_MAIL, f"pw-{JOHN_MAIL}"),
        "message": "Yes, paid today.",
    }]
    assert _outbound(world, "cfo", "john", proposal.todo_id) == ["proposed", "sent"]


def test_johns_reply_leaves_through_his_bot_to_the_arrival_chat(world):
    proposal = _offer(world, "cfo", "john", surface="telegram",
                      account=f"tgbot:{JOHN_BOT}", conversation="555", sender="9001")
    outcome = _answer_and_execute(world, "cfo", "john", proposal)

    assert outcome["event"] == "sent", outcome
    [sent] = world["sent"]
    assert (sent["platform"], sent["chat_id"], sent["token"]) == (
        "telegram", "555", JOHN_BOT_TOKEN)


def test_johns_reply_leaves_through_his_bridge(world):
    proposal = _offer(world, "cfo", "john", surface="whatsapp", account=JOHN_WA,
                      conversation="85290000000", sender="85290000000")
    outcome = _answer_and_execute(world, "cfo", "john", proposal)

    assert outcome["event"] == "sent", outcome
    [sent] = world["sent"]
    assert (sent["platform"], sent["extra"]["bridge_port"]) == ("whatsapp", JOHN_WA_PORT)


def test_mary_cannot_send_from_johns_source(world):
    # Mary's own arrival record naming John's mailbox: the registry says the
    # mailbox is John's, so nothing leaves.
    proposal = _offer(world, "cfo", "mary", surface="email", account=JOHN_MAIL,
                      conversation="ann@example.com", sender="ann@example.com")
    outcome = _answer_and_execute(world, "cfo", "mary", proposal)

    assert outcome["error"] == "not_source_owner"
    assert world["sent"] == []
    assert _outbound(world, "cfo", "mary", proposal.todo_id) == ["proposed"]


def test_mary_cannot_send_from_johns_bot_through_the_tool_either(world):
    from tools.access_policy import acting_as
    from tools.send_message_tool import send_message_tool

    with acting_as("mary", "member"):
        result = send_message_tool({"action": "send", "target": "telegram:555",
                                    "message": "hi", "account": f"tgbot:{JOHN_BOT}"})
    assert "belongs to another user" in result
    assert world["sent"] == []


@pytest.mark.parametrize("override, code", [
    ({"account_id": JOHN_MAIL_2}, "wrong_account"),  # John's, but not the arrival's
    ({"channel": "whatsapp", "target": "85290000000", "account_id": JOHN_WA}, "wrong_account"),
])
def test_a_reply_cannot_leave_through_another_account(world, override, code):
    proposal = _offer(world, "cfo", "john", surface="email", account=JOHN_MAIL,
                      conversation="ann@example.com", sender="ann@example.com",
                      override=override)
    outcome = _answer_and_execute(world, "cfo", "john", proposal)

    assert outcome["error"] == code
    assert world["sent"] == []


def test_a_bot_reply_cannot_go_to_another_chat(world):
    proposal = _offer(world, "cfo", "john", surface="telegram",
                      account=f"tgbot:{JOHN_BOT}", conversation="555", sender="9001",
                      override={"target": "666"})
    outcome = _answer_and_execute(world, "cfo", "john", proposal)

    assert outcome["error"] == "wrong_chat"
    assert world["sent"] == []


def test_approval_in_john_at_cmo_sends_from_the_web_route(world, monkeypatch):
    proposal = _offer(world, "cmo", "john", surface="telegram",
                      account=f"tgbot:{JOHN_BOT}", conversation="555", sender="9001")
    _session_as(monkeypatch, "john")

    response = _client("john").post(
        f"/api/comms/notifications/{proposal.notification_id}/answer?profile=cmo",
        json={"answer": "approved"},
    )

    assert response.status_code == 200, response.text
    action = response.json()["action"]
    assert action["type"] == "send" and action["event"] == "sent", action
    [sent] = world["sent"]
    assert (sent["chat_id"], sent["token"]) == ("555", JOHN_BOT_TOKEN)
    assert _outbound(world, "cmo", "john", proposal.todo_id) == ["proposed", "sent"]
    assert _outbound(world, "cfo", "john", proposal.todo_id) == []


def test_standing_consent_cannot_send(world):
    consent = ConsentPolicy(auto_approve_reversible=True)
    proposal = _offer(world, "cfo", "john", surface="email", account=JOHN_MAIL,
                      conversation="ann@example.com", sender="ann@example.com",
                      policy=consent)

    assert proposal.auto_approved is False

    async def execute():
        with _scoped_to(world["homes"]["cfo"]):
            app = _app(world)
            principal = await PrincipalStore(app).get("john")
            return await todo_outbound.execute_proposal(
                TodoStore(app), principal, proposal.todo_id)

    assert asyncio.run(execute())["error"] == "pending"
    assert world["sent"] == []


def test_registry_resolves_reply_accounts(world):
    async def run():
        found = {}
        for channel, account in (("email", JOHN_MAIL.upper()), ("telegram", f"tgbot:{JOHN_BOT}"),
                                 ("whatsapp", f"+{JOHN_WA}"), ("telegram", "install-bot"),
                                 ("email", "nobody@example.com")):
            source = await reply_accounts.find_source(channel, account)
            found[(channel, account)] = source.owner_user_id if source else None
        return found

    assert asyncio.run(run()) == {
        ("email", JOHN_MAIL.upper()): "john", ("telegram", f"tgbot:{JOHN_BOT}"): "john",
        ("whatsapp", f"+{JOHN_WA}"): "john", ("telegram", "install-bot"): None,
        ("email", "nobody@example.com"): None,
    }
