"""Engine adapters behind one interface (data-dictionary plan, Phase 7).

SQLite runs everywhere (stdlib). MySQL and SQL Server run against real servers
when ``HERMES_TEST_MYSQL_DSN`` / ``HERMES_TEST_MSSQL_DSN`` /
``HERMES_TEST_POSTGRES_DSN`` (``mysql://user:pass@host:port/db``) are set;
skipped otherwise.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
from urllib.parse import unquote, urlparse

import pytest

import hermes_cli.data_dictionary as dd
import hermes_cli.data_engines as de
from hermes_cli.access import Principal
from hermes_cli.credential_store import CREDENTIAL_KINDS

ALICE = Principal(user_id="alice", display="Alice", role="member")
BOB = Principal(user_id="bob", display="Bob", role="member")
BOSS = Principal(user_id="boss", display="Boss", role="admin")


def run(coro):
    return asyncio.run(coro)


# -- read-only, one statement ------------------------------------------------------------


@pytest.mark.parametrize("engine", ["mysql", "sqlite", "postgres"])
@pytest.mark.parametrize("sql", [
    "SELECT 1",
    "select * from t where a = ';' -- ; drop table t",
    "WITH x AS (SELECT 1) SELECT * FROM x;",
    "SELECT 'delete' AS word",
])
def test_read_only_accepts_single_selects(engine, sql):
    assert de.check_read_only(sql, engine)


@pytest.mark.parametrize("engine", ["mysql", "sqlite", "postgres"])
@pytest.mark.parametrize("sql", [
    "",
    "DELETE FROM t",
    "SELECT 1; DROP TABLE t",
    "UPDATE t SET a = 1",
    "INSERT INTO t VALUES (1)",
    "/* x */ DROP TABLE t",
])
def test_read_only_rejects_writes_and_batches(engine, sql):
    with pytest.raises(de.EngineError):
        de.check_read_only(sql, engine)


@pytest.mark.parametrize("sql", ["SELECT 1 INTO OUTFILE '/tmp/x'", "SELECT * FROM t FOR UPDATE"])
def test_mysql_rejects_side_effects_inside_select(sql):
    with pytest.raises(de.EngineError):
        de.check_read_only(sql, "mysql")


@pytest.mark.parametrize("sql", ["ATTACH DATABASE '/tmp/x' AS x", "PRAGMA writable_schema = 1"])
def test_sqlite_rejects_attach_and_pragmas(sql):
    with pytest.raises(de.EngineError):
        de.check_read_only(sql, "sqlite")


# -- named parameters -----------------------------------------------------------------------


def test_bind_named_per_engine_and_leaves_strings_alone():
    sql = "SELECT ':skip', a FROM t WHERE a = :x AND b = :y AND c = :x AND d LIKE '5%'"
    pg, pg_args = de.bind_named(sql, {"x": 1, "y": "z"}, "postgres")
    assert "$1" in pg and "$2" in pg and "':skip'" in pg and pg_args == [1, "z"]
    my, my_args = de.bind_named(sql, {"x": 1, "y": "z"}, "mysql")
    assert "%(x)s" in my and "'5%%'" in my and my_args == {"x": 1, "y": "z"}
    lite, lite_args = de.bind_named(sql, {"x": 1, "y": "z"}, "sqlite")
    assert ":x" in lite and lite_args == {"x": 1, "y": "z"}


def test_bind_named_requires_matching_values():
    with pytest.raises(de.EngineError):
        de.bind_named("SELECT :a", {"b": 1}, "mysql")
    with pytest.raises(de.EngineError):
        de.bind_named("SELECT 1", {"b": 1}, "sqlite")
    with pytest.raises(de.EngineError):
        de.bind_named("SELECT :a", {"a": {"nested": 1}}, "sqlite")


def test_fingerprint_ignores_order_but_not_columns():
    a = de.schema_fingerprint({"t": {"a", "b"}, "u": {"c"}})
    assert a == de.schema_fingerprint({"u": ["c"], "t": ["b", "a"]})
    assert a != de.schema_fingerprint({"t": {"a"}, "u": {"c"}})


# -- credentials stay server-side ----------------------------------------------------------


@pytest.mark.parametrize("kind", ["mssql", "postgres", "mysql", "sqlite"])
def test_connection_kinds_never_reach_agent_terminals(kind):
    assert CREDENTIAL_KINDS[kind].materialize is False


# -- access: private to its owner until shared; admins read all; read via the owner's login --


def _connection(owner="alice"):
    return dd.Source(
        id="00000000-0000-0000-0000-000000000001", kind="connection", profile="default",
        name="ERP", owner_user_id=owner, site_id=None, engine="mssql", connection_name="erp",
    )


def test_connection_access_is_owner_grant_or_admin_read():
    source = _connection()
    assert dd.access_level(source, ALICE, None) == "manage"
    assert dd.access_level(source, BOSS, None) == "read"
    assert dd.access_level(source, BOSS, "propose") == "propose"
    assert dd.access_level(source, BOB, None) is None
    assert dd.access_level(source, BOB, "read") == "read"
    assert source.view("read")["ref"] == "mssql:erp"


def test_everyone_who_may_read_opens_it_with_the_owners_login(monkeypatch):
    opened = []
    alice_as_owner = Principal(user_id="alice", display="Alice", role="owner")

    async def owner_principal(user_id):
        assert user_id == "alice"
        return alice_as_owner

    async def connection_adapter(source, principal, *, agent):
        opened.append((principal.user_id, principal.role))
        return de.SqliteAdapter({"path": ":memory:"})

    monkeypatch.setattr(de, "_owner_principal", owner_principal)
    monkeypatch.setattr(de, "_connection_adapter", connection_adapter)
    for who in (ALICE, BOB, BOSS):
        run(de.adapter_for(_connection(), who))
    # the owner's own role (and so the VPNs they may use) is kept for every reader
    assert opened == [("alice", "member"), ("alice", "owner"), ("alice", "owner")]
    with pytest.raises(de.EngineError):
        run(de.adapter_for(_connection(owner=""), BOSS))


# -- SQLite, for real ------------------------------------------------------------------------


@pytest.fixture
def shop(tmp_path, monkeypatch):
    root = tmp_path / "data-sources"
    root.mkdir()
    from hermes_cli import db_connections

    monkeypatch.setattr(db_connections, "sqlite_roots", lambda: [root.resolve()])
    path = root / "shop.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE orders (order_no TEXT PRIMARY KEY, customer_id INTEGER REFERENCES customers (id),
                             amount REAL, note TEXT);
        INSERT INTO customers VALUES (1, 'Ann'), (2, 'Ben');
        INSERT INTO orders VALUES ('A1', 1, 10.5, 'x'), ('A2', 2, 20, 'y'), ('A3', 1, 5, 'z');
        """
    )
    conn.commit()
    conn.close()
    return path


def test_sqlite_adapter_lists_describes_and_queries(shop):
    adapter = de.SqliteAdapter({"path": str(shop)}, label="shop")
    tables = run(adapter.list_tables())
    assert {t["name"]: t["rows"] for t in tables} == {"customers": 2, "orders": 3}
    assert [t["name"] for t in run(adapter.list_tables("order"))] == ["orders"]
    table = run(adapter.describe_table("orders"))
    assert table["key"] == ["order_no"]
    assert table["foreign_keys"][0]["to_table"] == "customers"
    cols = {c["name"]: c for c in table["columns"]}
    assert set(cols) == {"order_no", "customer_id", "amount", "note"}
    result = run(adapter.query(
        "SELECT order_no, amount FROM orders WHERE customer_id = :c ORDER BY order_no", {"c": 1}))
    assert result["rows"] == [["A1", 10.5], ["A3", 5.0]] or result["rows"] == [
        {"order_no": "A1", "amount": 10.5}, {"order_no": "A3", "amount": 5.0}]
    assert result["row_count"] == 2
    capped = run(adapter.query("SELECT * FROM orders", max_rows=1))
    assert capped["row_count"] == 1 and capped["truncated"] is True
    assert run(adapter.schema()) == {
        "customers": {"id", "name"}, "orders": {"order_no", "customer_id", "amount", "note"}}


def test_find_tables_adds_ranked_tables_the_keyword_filter_missed(shop):
    adapter = de.SqliteAdapter({"path": str(shop)})
    assert [t["name"] for t in run(adapter.find_tables("order"))] == ["orders"]
    found = run(adapter.find_tables("order", ["customers", "orders", "gone"]))
    assert [t["name"] for t in found] == ["orders", "customers"]


def test_sqlite_adapter_cannot_write(shop):
    adapter = de.SqliteAdapter({"path": str(shop)})
    with pytest.raises(de.EngineError):
        run(adapter.query("DELETE FROM orders"))
    with pytest.raises(de.EngineError):
        run(adapter.query("SELECT 1; DELETE FROM orders"))
    conn = sqlite3.connect(shop)
    assert conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 3


def test_sqlite_files_must_be_inside_a_root(shop, tmp_path):
    from hermes_cli import db_connections

    outside = tmp_path / "elsewhere.db"
    sqlite3.connect(outside).close()
    with pytest.raises(de.EngineError):
        db_connections.sqlite_path(str(outside))
    with pytest.raises(de.EngineError):
        db_connections.sqlite_path(str(shop.parent / ".." / "elsewhere.db"))
    assert db_connections.sqlite_path(str(shop)) == shop.resolve()


def test_byte_cap_trims_rows(shop):
    adapter = de.SqliteAdapter({"path": str(shop)})
    big = run(adapter.query(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400) "
        "SELECT i, printf('%.1500c', 'x') AS pad FROM n"))
    import json

    assert len(json.dumps(big["rows"], default=str)) <= de.MAX_BYTES
    assert big["truncated"] is True


# -- MySQL / SQL Server against real servers (env-gated) -----------------------------------


def _payload(dsn: str, port: int):
    url = urlparse(dsn)
    return {
        "host": url.hostname, "port": url.port or port, "username": unquote(url.username or ""),
        "password": unquote(url.password or ""), "database": url.path.lstrip("/"),
    }


MYSQL_DSN = os.environ.get("HERMES_TEST_MYSQL_DSN", "")
MSSQL_DSN = os.environ.get("HERMES_TEST_MSSQL_DSN", "")
POSTGRES_DSN = os.environ.get("HERMES_TEST_POSTGRES_DSN", "")


@pytest.mark.skipif(not POSTGRES_DSN, reason="HERMES_TEST_POSTGRES_DSN not set")
def test_postgres_adapter_against_a_real_server():
    pg8000 = pytest.importorskip("pg8000.native")
    payload = {**_payload(POSTGRES_DSN, 5432), "tls": "off"}
    conn = pg8000.Connection(user=payload["username"], password=payload["password"],
                             host=payload["host"], port=payload["port"], database=payload["database"])
    for stmt in (
        "DROP SCHEMA IF EXISTS de_shop CASCADE",
        "CREATE SCHEMA de_shop",
        "CREATE TABLE de_shop.customers (id int PRIMARY KEY, name text)",
        "COMMENT ON TABLE de_shop.customers IS 'People who buy'",
        "CREATE TABLE de_shop.orders (order_no text PRIMARY KEY, customer_id int "
        "REFERENCES de_shop.customers (id), amount numeric(10,2))",
        "COMMENT ON COLUMN de_shop.orders.amount IS 'HKD'",
        "INSERT INTO de_shop.customers VALUES (1, 'Ann'), (2, 'Ben')",
        "INSERT INTO de_shop.orders VALUES ('A1', 1, 10.5), ('A2', 2, 20), ('A3', 1, 5)",
    ):
        conn.run(stmt)
    conn.close()
    adapter = de.PostgresAdapter(payload, label="shop")
    tables = {t["name"]: t for t in run(adapter.list_tables("de_shop"))}
    assert tables["de_shop.customers"]["comment"] == "People who buy"
    assert tables["de_shop.orders"]["schema"] == "de_shop"
    table = run(adapter.describe_table("de_shop.orders"))
    assert table["key"] == ["order_no"]
    assert table["foreign_keys"][0]["to_table"] == "de_shop.customers"
    assert {c["name"]: c["comment"] for c in table["columns"]}["amount"] == "HKD"
    result = run(adapter.query(
        "SELECT order_no, amount::text FROM de_shop.orders WHERE customer_id = :c "
        "AND order_no LIKE 'A%' ORDER BY 1", {"c": 1}))
    assert result["row_count"] == 2
    assert run(adapter.query("SELECT * FROM de_shop.orders", max_rows=1))["truncated"] is True
    with pytest.raises(de.EngineError):
        run(adapter.query("DELETE FROM de_shop.orders"))
    # the session itself is read-only, even past the statement check
    with pytest.raises(de.EngineError):
        run(adapter.query("WITH d AS (DELETE FROM de_shop.orders RETURNING 1) SELECT * FROM d"))
    assert run(adapter.schema())["de_shop.orders"] == {"order_no", "customer_id", "amount"}


@pytest.mark.skipif(not MYSQL_DSN, reason="HERMES_TEST_MYSQL_DSN not set")
def test_mysql_adapter_against_a_real_server():
    pymysql = pytest.importorskip("pymysql")
    payload = {**_payload(MYSQL_DSN, 3306), "tls": "off"}
    conn = pymysql.connect(host=payload["host"], port=payload["port"], user=payload["username"],
                           password=payload["password"], database=payload["database"], autocommit=True)
    with conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS de_orders")
        cur.execute("DROP TABLE IF EXISTS de_customers")
        cur.execute("CREATE TABLE de_customers (id INT PRIMARY KEY, name VARCHAR(50)) COMMENT 'People who buy'")
        cur.execute("CREATE TABLE de_orders (order_no VARCHAR(10) PRIMARY KEY, customer_id INT, "
                    "amount DECIMAL(10,2) COMMENT 'HKD', FOREIGN KEY (customer_id) REFERENCES de_customers (id))")
        cur.execute("INSERT INTO de_customers VALUES (1, 'Ann'), (2, 'Ben')")
        cur.execute("INSERT INTO de_orders VALUES ('A1', 1, 10.5), ('A2', 2, 20), ('A3', 1, 5)")
    conn.close()
    adapter = de.MysqlAdapter(payload, label="shop")
    names = {t["name"] for t in run(adapter.list_tables("de_"))}
    assert {"de_orders", "de_customers"} <= names
    table = run(adapter.describe_table("de_orders"))
    assert table["key"] == ["order_no"]
    assert table["foreign_keys"][0]["to_table"] == "de_customers"
    assert {c["name"]: c["comment"] for c in table["columns"]}["amount"] == "HKD"
    result = run(adapter.query(
        "SELECT order_no FROM de_orders WHERE customer_id = :c AND order_no LIKE 'A%' ORDER BY 1", {"c": 1}))
    assert result["row_count"] == 2
    with pytest.raises(de.EngineError):
        run(adapter.query("DELETE FROM de_orders"))
    assert run(adapter.schema())["de_orders"] == {"order_no", "customer_id", "amount"}


@pytest.mark.skipif(not MSSQL_DSN, reason="HERMES_TEST_MSSQL_DSN not set")
def test_mssql_adapter_against_a_real_server():
    pytest.importorskip("pytds")
    from hermes_cli import mssql_connections as mssql

    payload = {**_payload(MSSQL_DSN, 1433), "encrypt": "on", "trust_server_certificate": True}
    conn = mssql.connect(payload)
    cur = conn.cursor()
    cur.execute("IF OBJECT_ID('dbo.de_orders') IS NOT NULL DROP TABLE dbo.de_orders")
    cur.execute("IF OBJECT_ID('dbo.de_customers') IS NOT NULL DROP TABLE dbo.de_customers")
    cur.execute("CREATE TABLE dbo.de_customers (id INT PRIMARY KEY, name NVARCHAR(50))")
    cur.execute("CREATE TABLE dbo.de_orders (order_no NVARCHAR(10) PRIMARY KEY, "
                "customer_id INT REFERENCES dbo.de_customers (id), amount DECIMAL(10,2))")
    cur.execute("EXEC sp_addextendedproperty 'MS_Description', 'HKD', 'SCHEMA', 'dbo', "
                "'TABLE', 'de_orders', 'COLUMN', 'amount'")
    cur.execute("INSERT INTO dbo.de_customers VALUES (1, 'Ann'), (2, 'Ben')")
    cur.execute("INSERT INTO dbo.de_orders VALUES ('A1', 1, 10.5), ('A2', 2, 20), ('A3', 1, 5)")
    conn.commit()
    conn.close()
    adapter = de.MssqlAdapter(payload, label="erp")
    names = {t["name"] for t in run(adapter.list_tables("de_"))}
    assert {"dbo.de_orders", "dbo.de_customers"} <= names
    table = run(adapter.describe_table("dbo.de_orders"))
    assert table["key"] == ["order_no"]
    assert table["foreign_keys"][0]["to_table"] == "dbo.de_customers"
    assert {c["name"]: c["comment"] for c in table["columns"]}["amount"] == "HKD"
    result = run(adapter.query(
        "SELECT order_no FROM dbo.de_orders WHERE customer_id = :c ORDER BY 1", {"c": 1}))
    assert result["row_count"] == 2
    with pytest.raises(de.EngineError):
        run(adapter.query("DELETE FROM dbo.de_orders"))
    assert run(adapter.schema())["dbo.de_orders"] == {"order_no", "customer_id", "amount"}


def test_listed_tables_keep_their_schema_for_study_choices(shop):
    class Schemas(de.SqliteAdapter):
        def _tables(self, conn):
            return [{**t, "schema": "main"} for t in super()._tables(conn)]

    tables = run(Schemas({"path": str(shop)}).list_tables())
    assert tables and {t["schema"] for t in tables} == {"main"}
    assert "schema" not in run(de.SqliteAdapter({"path": str(shop)}).list_tables())[0]
