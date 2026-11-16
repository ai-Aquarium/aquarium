"""The email poller and WhatsApp batcher read the source registry (FG-03 P2).

Real throwaway Postgres for the box registry, real channel SQLite DBs and
config.yaml under tmp dirs, the real credential store with a local TLS IMAP
server, and a local HTTP stand-in for the WhatsApp bridge. Only the Supabase
inbound registry calls are captured in-process.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom" / "email"))
sys.path.insert(0, str(ROOT / "custom"))

import email_poller  # noqa: E402
import hermes_cli.source_registry as sr  # noqa: E402
from gateway.person_whatsapp_bridges import (  # noqa: E402
    PersonBridgeSpec,
    PersonWhatsAppBridgesMixin,
)
from hermes_cli import source_polling  # noqa: E402
from tests.custom.test_wa_batcher_poll_interval import _load  # noqa: E402
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: E402,F401
from tests.hermes_cli.test_email_poller_personal import (  # noqa: E402,F401
    ALICE,
    BOB,
    imap,
    registry,
    save,
)
from tests.hermes_cli.test_email_poller_personal import rfc822  # noqa: E402

EMAIL_DDL = """
CREATE TABLE email_accounts ( id TEXT PRIMARY KEY, address TEXT UNIQUE NOT NULL, label TEXT,
  last_poll TEXT, last_uid INTEGER DEFAULT 0, status TEXT DEFAULT 'active');
CREATE TABLE email_messages ( id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
  from_addr TEXT NOT NULL, from_name TEXT, to_addrs TEXT, cc_addrs TEXT, subject TEXT,
  body_text TEXT, body_html TEXT, has_attachments INTEGER DEFAULT 0, attachment_info TEXT,
  message_id TEXT UNIQUE, in_reply_to TEXT, thread_id TEXT, folder TEXT DEFAULT 'INBOX',
  received_at TEXT NOT NULL, batch_id TEXT, raw_headers TEXT );
"""


async def _yes(*_):
    return True


def run(coro):
    return asyncio.run(coro)


async def _reset(dsn):
    conn = await sr.connect_box(dsn=dsn)
    try:
        await conn.execute(
            "TRUNCATE aquarium_box.source_routes, aquarium_box.source_claim_conflicts, "
            "aquarium_box.sources CASCADE"
        )
    finally:
        await conn.close()


async def _add(dsn, channel, address, owner, *, ref=None, routes=(), enabled=True):
    conn = await sr.connect_box(dsn=dsn)
    try:
        source = await sr.register_source(
            conn, channel=channel, address=address, owner_user_id=owner, credential_ref=ref
        )
        for profile in routes:
            await sr.set_route(
                conn, source_id=source.source_id, profile_slug=profile, enabled=True,
                actor_user_id=owner, membership=_yes,
            )
        if not enabled:
            await sr.set_source_enabled(
                conn, source_id=source.source_id, enabled=False, actor_user_id=owner,
                box_admin=_yes,
            )
        return source.source_id
    finally:
        await conn.close()


@pytest.fixture
def box(hermes_root, postgres_dsn, monkeypatch):  # noqa: F811
    """A hermes home whose registry is the test Postgres; ``box(...)`` rewrites
    config.yaml's ``source_registry.pollers`` / points the registry elsewhere.

    The registry DSN is the datastore's (``box_dsn``); it is pointed at the
    test Postgres directly so the rest of the home (the credential store)
    stays local, as on a box without a profile datastore."""
    run(_reset(postgres_dsn))
    target = {"dsn": postgres_dsn}
    monkeypatch.setattr(sr, "box_dsn", lambda config=None: target["dsn"])

    def configure(pollers="registry", dsn=postgres_dsn):
        target["dsn"] = dsn
        (hermes_root / "config.yaml").write_text(
            yaml.safe_dump({"source_registry": {"pollers": pollers}})
        )

    configure()
    return configure


@pytest.fixture
def email_db(tmp_path, monkeypatch):
    path = tmp_path / "email-messages" / "email_data.db"
    path.parent.mkdir()
    conn = sqlite3.connect(path)
    conn.executescript(EMAIL_DDL)
    conn.close()
    monkeypatch.setattr(email_poller, "DB_PATH", str(path))
    config = tmp_path / "email-messages" / "config.json"
    monkeypatch.setattr(email_poller, "CONFIG_PATH", str(config))
    monkeypatch.setitem(source_polling.FALLBACK_CONFIG_PATHS, "email", str(config))
    email_poller.poll_status["accounts"] = {}
    return path, config


def _email_rows(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(
            "SELECT account_id, subject, source_id, owner_user_id FROM email_messages "
            "ORDER BY subject"
        ).fetchall()
    finally:
        conn.close()


def _imap_ref(address, owner):
    return {"kind": "email-imap", "provider": "imap", "name": address, "owner_user_id": owner}


def _poll_email():
    plan = email_poller.load_poll_plan()
    db = email_poller.get_db()
    try:
        email_poller.poll_round(plan, db)
    finally:
        db.close()
    return plan


# --- Email ------------------------------------------------------------------------


def test_routed_settings_mailbox_polled_once_and_tagged(box, email_db, imap, registry, postgres_dsn):  # noqa: F811
    path, _ = email_db
    save(ALICE, imap.port)
    source_id = run(_add(postgres_dsn, "email", "alice@example.com", "alice",
                         ref=_imap_ref("alice@example.com", "alice"), routes=("work", "home")))

    plan = _poll_email()
    assert plan.mode == "registry" and [s.source_id for s in plan.sources] == [source_id]
    assert len(imap.logins) == 1  # routed to two profiles, read once
    rows = _email_rows(path)
    assert rows == [
        ("alice@example.com", "Invoice", source_id, "alice"),
        ("alice@example.com", "Quote for October", source_id, "alice"),
    ]
    calls, _, _ = registry
    assert [c[0] for c in calls] == ["alice", "alice"]

    # The next round only files new mail: nothing is stored (so triaged) twice.
    imap.messages[3] = rfc822("Follow-up", msg_id="m3@example.com")
    _poll_email()
    assert [r[1] for r in _email_rows(path)] == ["Follow-up", "Invoice", "Quote for October"]
    assert len(calls) == 3


def test_unrouted_and_disabled_mailboxes_not_polled(box, email_db, imap, registry, postgres_dsn):  # noqa: F811
    path, _ = email_db
    save(ALICE, imap.port)
    save(BOB, imap.port, address="bob@example.com")
    run(_add(postgres_dsn, "email", "alice@example.com", "alice",
             ref=_imap_ref("alice@example.com", "alice"), routes=("work",), enabled=False))
    run(_add(postgres_dsn, "email", "bob@example.com", "bob",
             ref=_imap_ref("bob@example.com", "bob")))

    plan = _poll_email()
    assert plan.mode == "registry" and plan.sources == ()
    assert imap.logins == [] and _email_rows(path) == []
    assert registry[0] == []


async def _transfer_and_route(dsn, source_id, new_owner, profile):
    conn = await sr.connect_box(dsn=dsn)
    try:
        await sr.transfer_source(
            conn, source_id=source_id, new_owner_user_id=new_owner, actor_user_id="admin",
            box_admin=_yes, known_user=_yes,
        )
        await sr.set_route(
            conn, source_id=source_id, profile_slug=profile, enabled=True,
            actor_user_id=new_owner, membership=_yes,
        )
    finally:
        await conn.close()


def test_transferred_mailbox_is_not_read_with_the_old_owners_credential(box, email_db, imap, registry, postgres_dsn):  # noqa: F811
    path, _ = email_db
    save(ALICE, imap.port)
    source_id = run(_add(postgres_dsn, "email", "alice@example.com", "alice",
                         ref=_imap_ref("alice@example.com", "alice"), routes=("work",)))
    run(_transfer_and_route(postgres_dsn, source_id, "bob", "home"))

    plan = _poll_email()
    assert [s.source_id for s in plan.sources] == [source_id]
    assert imap.logins == [] and _email_rows(path) == []
    status = email_poller.poll_status["accounts"]["alice@example.com"]
    assert status["auth"] == "no_credential"


def test_empty_registry_falls_back_to_config_json(box, email_db, imap, registry, caplog):  # noqa: F811
    path, config = email_db
    save(ALICE, imap.port)
    config.write_text(json.dumps({"accounts": [{
        "id": "acct1", "address": "alice@example.com", "auth": "password",
        "imap": {"host": "localhost", "port": imap.port},
    }]}))

    plan = _poll_email()
    assert plan.mode == "config" and "no email source" in plan.reason
    assert [r[0] for r in _email_rows(path)] == ["acct1", "acct1"]
    assert {(r[2], r[3]) for r in _email_rows(path)} == {(None, "alice")}


def test_unreachable_registry_falls_back_unless_registry_only(box, email_db, imap, registry):  # noqa: F811
    path, config = email_db
    save(ALICE, imap.port)
    config.write_text(json.dumps({"accounts": [{
        "id": "acct1", "address": "alice@example.com", "auth": "password",
        "imap": {"host": "localhost", "port": imap.port},
    }]}))
    dead = "postgresql://postgres:x@127.0.0.1:9/none"

    box(dsn=dead)
    plan = _poll_email()
    assert plan.mode == "config" and "unreachable" in plan.reason
    assert len(_email_rows(path)) == 2

    box(pollers="registry_only", dsn=dead)
    plan = _poll_email()
    assert plan.mode == "registry" and plan.sources == ()

    box(pollers="config")
    assert email_poller.load_poll_plan().mode == "config"


def test_source_columns_migration_is_idempotent(email_db):
    from shared.channel_db import ensure_source_columns

    path, _ = email_db
    for _ in range(2):
        email_poller.get_db().close()
    conn = sqlite3.connect(path)
    ensure_source_columns(conn, "email_messages")
    cols = [r[1] for r in conn.execute("PRAGMA table_info(email_messages)")]
    conn.close()
    assert cols.count("source_id") == 1 and cols.count("owner_user_id") == 1


# --- WhatsApp ---------------------------------------------------------------------


class _Bridge:
    """A local stand-in for bridge.js: GET /messages drains, /health advertises."""

    def __init__(self, messages=(), *, split=True):
        self.queue = list(messages)
        self.requests = []
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                bridge.requests.append(self.path)
                if self.path.startswith("/health"):
                    body = {"status": "connected", **({"queues": ["self", "external"]} if split else {})}
                else:
                    body, bridge.queue = bridge.queue, []
                payload = json.dumps(body).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


def _wa_message(msg_id, sender):
    return {"messageId": msg_id, "chatId": f"{sender}@s.whatsapp.net",
            "senderId": f"{sender}@s.whatsapp.net", "senderName": "Client",
            "isGroup": False, "body": "hello", "timestamp": 1790766223}


@pytest.fixture
def batcher(tmp_path, monkeypatch):
    db_path = tmp_path / "messages.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        """CREATE TABLE messages (
               id TEXT PRIMARY KEY, source_phone TEXT, sender_phone TEXT,
               sender_name TEXT, chat_id TEXT, is_group INTEGER, text TEXT,
               media_type TEXT, media_path TEXT, media_mimetype TEXT,
               timestamp TEXT, received_at TEXT, batch_id TEXT, raw_json TEXT);
           CREATE TABLE contacts (
               phone TEXT PRIMARY KEY, name TEXT, is_family INTEGER,
               first_seen TEXT, last_seen TEXT, message_count INTEGER);"""
    )
    conn.close()
    monkeypatch.setenv("MESSAGING_DB_PATH", str(db_path))
    module = _load(tmp_path, batching={"window_seconds": 3600})
    monkeypatch.setitem(source_polling.FALLBACK_CONFIG_PATHS, "whatsapp", module.CONFIG_PATH)
    import shared.inbound_registration as inbound_registration

    monkeypatch.setattr(inbound_registration, "register_item", lambda **_: None)
    monkeypatch.setattr("hermes_cli.wa_bridge_owners.bridge_ports", lambda: {})
    yield module, db_path
    with module._batch_lock:
        for batch in module._pending_batches.values():
            batch["timer"].cancel()


def _set_phones(module, phones):
    Path(module.CONFIG_PATH).write_text(json.dumps({"phones": phones}))


def _drain_once(module, phones):
    """Run one bridge poller per wanted phone until its bridge is empty."""
    pollers = {}
    module.reconcile_pollers(pollers, phones)
    deadline = time.time() + 10
    while time.time() < deadline:
        time.sleep(0.2)
        if not any(p[0].get("_bridge").queue for p in pollers.values()):
            time.sleep(0.3)
            break
    module.reconcile_pollers(pollers, {})


def _wa_rows(path):
    conn = sqlite3.connect(path)
    try:
        return conn.execute(
            "SELECT id, source_phone, source_id, owner_user_id FROM messages ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


def test_routed_bridge_read_once_and_tagged(box, batcher, postgres_dsn):
    module, db_path = batcher
    routed = _Bridge([_wa_message("wa-1", "85211112222"), _wa_message("wa-2", "85233334444")])
    unrouted, paused = _Bridge([_wa_message("wa-x", "85299990000")]), _Bridge()
    try:
        source_id = run(_add(postgres_dsn, "whatsapp", "+852 9000 0001", "alice",
                             ref={"bridge": "alice", "port": routed.port}, routes=("work", "home")))
        run(_add(postgres_dsn, "whatsapp", "+852 9000 0002", "bob",
                 ref={"bridge": "bob", "port": unrouted.port}))
        run(_add(postgres_dsn, "whatsapp", "+852 9000 0003", "carol",
                 ref={"bridge": "carol", "port": paused.port}, routes=("work",), enabled=False))
        _set_phones(module, [{"id": "phone1", "bridge_port": unrouted.port}])

        plan = module.load_poll_plan()
        wanted = module.desired_phones(plan)
        assert plan.mode == "registry" and list(wanted) == [routed.port]
        wanted[routed.port]["_bridge"] = routed
        _drain_once(module, wanted)

        assert _wa_rows(db_path) == [
            ("wa-1", "alice", source_id, "alice"),
            ("wa-2", "alice", source_id, "alice"),
        ]
        reads = [p for p in routed.requests if p.startswith("/messages")]
        assert reads and set(reads) == {"/messages?only=external"}
        assert not [p for p in unrouted.requests if p.startswith("/messages")]
        assert unrouted.queue  # the unrouted bridge was never drained
    finally:
        for b in (routed, unrouted, paused):
            b.close()


def test_empty_registry_falls_back_to_config_phones(box, batcher):
    module, db_path = batcher
    bridge = _Bridge([_wa_message("wa-1", "85211112222")])
    try:
        _set_phones(module, [{"id": "phone1", "bridge_port": bridge.port, "owner_user_id": "alice"}])
        plan = module.load_poll_plan()
        assert plan.mode == "config"
        wanted = module.desired_phones(plan)
        assert list(wanted) == [bridge.port]
        wanted[bridge.port]["_bridge"] = bridge
        _drain_once(module, wanted)
        assert _wa_rows(db_path) == [("wa-1", "phone1", None, "alice")]
    finally:
        bridge.close()


# --- One reader per bridge / mailbox ---------------------------------------------


class _Gateway(PersonWhatsAppBridgesMixin):
    pass


def _spec(name, port, number):
    return PersonBridgeSpec(name, "alice", port, number, f"/tmp/{name}")


def test_gateway_keeps_only_self_chat_on_a_pipeline_bridge(box, batcher, postgres_dsn, caplog):
    module, _ = batcher
    split, legacy, own = _Bridge(split=True), _Bridge(split=False), _Bridge()
    try:
        run(_add(postgres_dsn, "whatsapp", "85290000001", "alice",
                 ref={"bridge": "alice", "port": split.port}, routes=("work",)))
        run(_add(postgres_dsn, "whatsapp", "85290000002", "alice",
                 ref={"bridge": "alice2", "port": legacy.port}, routes=("work",)))
        desired = {s.account_id: s for s in (
            _spec("alice", split.port, "85290000001"),
            _spec("alice2", legacy.port, "85290000002"),
            _spec("alice3", own.port, "85290000003"),  # not a pipeline source
        )}
        gateway = _Gateway()
        with caplog.at_level(logging.INFO, logger="gateway.person_whatsapp_bridges"):
            specs = run(gateway._person_wa_one_reader(desired, main_port=None))

        assert specs["wabridge:alice"].messages_query == "only=self"
        assert "wabridge:alice2" not in specs  # can't split: the pipeline is its one reader
        assert specs["wabridge:alice3"].messages_query == ""
        warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
        assert any("alice2" in w and "both" in w for w in warnings)

        # Logged once, not on every reconcile.
        caplog.clear()
        run(gateway._person_wa_one_reader(desired, main_port=None))
        assert not [r for r in caplog.records if r.levelno >= logging.INFO]
    finally:
        for b in (split, legacy, own):
            b.close()


def test_main_bridge_in_both_warns(box, batcher, caplog):
    module, _ = batcher
    _set_phones(module, [{"id": "phone1", "bridge_port": 3000}])
    with caplog.at_level(logging.WARNING, logger="gateway.person_whatsapp_bridges"):
        run(_Gateway()._person_wa_one_reader({}, main_port=3000))
    assert any("port 3000" in r.getMessage() and "phone1" in r.getMessage() for r in caplog.records)


def test_mailbox_in_both_is_reported(box, email_db, postgres_dsn):
    source_id = run(_add(postgres_dsn, "email", "Agent@Example.com", "alice",
                         ref=_imap_ref("agent@example.com", "alice"), routes=("work",)))
    assert run(source_polling.pipeline_reads_mailbox("agent@example.com")) == source_id
    assert run(source_polling.pipeline_reads_mailbox("other@example.com")) is None
