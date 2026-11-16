"""MySQL / SQLite connections in Settings: private, write-only passwords, SQLite roots."""

from __future__ import annotations

import asyncio
import sqlite3

import pytest
from fastapi import HTTPException

import hermes_cli.db_connections as dbc
import hermes_cli.db_connections_api as api
from hermes_cli.access import Principal
from hermes_cli.credential_store import FileCredentialStore, default_credential_store
from hermes_cli.data_engines import EngineError

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
BOSS = Principal(user_id="boss", display="Boss", role="admin")
SECRET = "my-pass-51c0e2"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def file_store(monkeypatch):
    store = default_credential_store()
    assert isinstance(store, FileCredentialStore), "tests need the file backend"
    forgotten = []

    async def forget(owner, engine, name):
        forgotten.append((owner, engine, name))

    import hermes_cli.data_engines as de

    monkeypatch.setattr(de, "forget_connection", forget)
    return forgotten


@pytest.fixture
def root(tmp_path, monkeypatch):
    folder = (tmp_path / "data-sources").resolve()
    folder.mkdir()
    monkeypatch.setattr(dbc, "sqlite_roots", lambda: [folder])
    db = folder / "shop.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t (a INTEGER)")
    conn.commit()
    conn.close()
    return folder


def mysql_body(**over):
    return {"host": "db.example", "database": "shop", "username": "reader", "password": SECRET, **over}


def test_postgres_connection_is_private_with_the_postgres_port():
    saved = run(dbc.save(ALICE, "postgres", "crm", mysql_body(vpn="")))
    assert saved["engine"] == "postgres" and saved["port"] == 5432
    assert saved["password_set"] is True and SECRET not in str(saved)
    assert [c["name"] for c in run(dbc.list_mine(ALICE)) if c["engine"] == "postgres"] == ["crm"]
    assert run(dbc.list_mine(BOB)) == []
    with pytest.raises(EngineError):
        run(dbc.save(ALICE, "postgres", "bad", mysql_body(password="")))


def test_mysql_connection_is_private_and_password_write_only():
    saved = run(dbc.save(ALICE, "mysql", "shop", mysql_body()))
    assert saved["password_set"] is True and SECRET not in str(saved)
    assert [c["name"] for c in run(dbc.list_mine(ALICE))] == ["shop"]
    assert run(dbc.list_mine(BOB)) == []
    assert run(dbc.list_mine(BOSS)) == []
    # Editing without a password keeps it.
    run(dbc.save(ALICE, "mysql", "shop", mysql_body(password="", port=3307)))
    entry = run(dbc.find_own(ALICE, "mysql", "shop"))
    assert entry.payload["password"] == SECRET and entry.payload["port"] == 3307
    with pytest.raises(EngineError):
        run(dbc.delete(BOB, "mysql", "shop"))


def test_mysql_needs_password_and_valid_fields():
    with pytest.raises(EngineError):
        run(dbc.save(ALICE, "mysql", "new", mysql_body(password="")))
    with pytest.raises(EngineError):
        run(dbc.save(ALICE, "mysql", "new", mysql_body(tls="maybe")))
    with pytest.raises(EngineError):
        run(dbc.save(ALICE, "oracle", "new", mysql_body()))


def test_anyone_adds_sqlite_but_only_their_own_files(root, tmp_path, file_store):
    outside = tmp_path / "other.db"
    sqlite3.connect(outside).close()
    with pytest.raises(EngineError):
        run(dbc.save(BOSS, "sqlite", "other", {"path": str(outside)}))
    with pytest.raises(EngineError):
        run(dbc.save(ALICE, "sqlite", "other", {"path": str(outside)}))
    # a member can't register a file someone else keeps under the shared root
    with pytest.raises(EngineError) as err:
        run(dbc.save(ALICE, "sqlite", "shop", {"path": str(root / "shop.db")}))
    assert err.value.status == 403
    (root / "bob").mkdir()
    (root / "alice").mkdir()
    (root / "shop.db").rename(root / "alice" / "shop.db")
    sqlite3.connect(root / "bob" / "b.db").close()
    with pytest.raises(EngineError):
        run(dbc.save(ALICE, "sqlite", "b", {"path": str(root / "bob" / "b.db")}))
    saved = run(dbc.save(ALICE, "sqlite", "shop", {"path": str(root / "alice" / "shop.db")}))
    assert saved["path"] == str(root / "alice" / "shop.db")
    tested = run(dbc.run_test(ALICE, "sqlite", "shop"))
    assert tested["test"] == {"ok": True, "tables": 1}
    assert run(dbc.delete(ALICE, "sqlite", "shop")) is True
    assert file_store == [("alice", "sqlite", "shop")]
    assert run(dbc.save(BOSS, "sqlite", "b", {"path": str(root / "bob" / "b.db")}))["path"]


def test_api_routes_act_on_the_caller_only(monkeypatch):
    current = {"p": ALICE}

    async def caller(_request):
        return current["p"]

    class Req:
        def __init__(self, doc=None):
            self._doc = doc

        async def json(self):
            return self._doc

    monkeypatch.setattr(api, "_caller", caller)
    run(api.put_connection("mysql", "shop", Req(mysql_body())))
    listed = run(api.list_connections(Req()))
    assert [c["name"] for c in listed["connections"]] == ["shop"] and "sqlite" in listed["drivers"]
    current["p"] = BOB
    assert run(api.list_connections(Req()))["connections"] == []
    with pytest.raises(HTTPException) as err:
        run(api.delete_connection("mysql", "shop", Req()))
    assert err.value.status_code == 404
