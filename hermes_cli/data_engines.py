"""Database engines behind one adapter interface (data-dictionary plan, Phase 7).

Every data source — a site schema, Aquarium's own data, or a database someone
connected in Settings (SQL Server, PostgreSQL, MySQL, SQLite) — is read through one
:class:`EngineAdapter`: list tables, describe a table (keys, comments, row
estimate, sample values), run one bounded read-only parameterised query, and
a schema fingerprint for drift checks.

Credentials stay server-side: an adapter is built here from the stored
connection and only ever hands back rows. A Settings connection is always
opened with its owner's saved read-only login; sharing it never shares the
login itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
import sqlite3
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple
from urllib.parse import quote

from hermes_cli import site_sources as ss
from hermes_cli.site_sources import SiteError

logger = logging.getLogger(__name__)

ENGINES = ("postgres", "mssql", "mysql", "sqlite")
CONNECTION_ENGINES = ("mssql", "postgres", "mysql", "sqlite")
MAX_ROWS = 500
QUERY_TIMEOUT = 30
MAX_BYTES = 200_000
MAX_CELL_CHARS = 2000
SAMPLE_VALUES = 5
STATS_SAMPLE_ROWS = 10_000
STATS_MAX_COLUMNS = 60
MAX_TABLES = 500
SQLITE_COUNT_CAP = 100_000

_PARAM_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")


class EngineError(SiteError):
    """A refusal or failure reading a data source (safe to show the person)."""


# -- the interface --------------------------------------------------------------------


def schema_fingerprint(schema: Mapping[str, Iterable[str]]) -> str:
    """A stable hash of ``{table: columns}``; changes exactly when the schema does."""
    doc = {str(t): sorted(str(c) for c in cols) for t, cols in schema.items()}
    return hashlib.sha256(json.dumps(doc, sort_keys=True).encode()).hexdigest()


class EngineAdapter(ABC):
    """One data source's database, read-only, as the source's own login."""

    engine: str = ""

    @abstractmethod
    async def list_tables(self, q: Optional[str] = None) -> List[Dict[str, Any]]:
        """Tables with row estimates and comments; ``q`` keeps those matching every word."""

    @abstractmethod
    async def describe_table(self, name: str, *, samples: int = SAMPLE_VALUES) -> Dict[str, Any]:
        """One table: keys, comments, row estimate and per-column fill/distinct/common values."""

    @abstractmethod
    async def query(
        self, sql: str, params: Optional[Mapping[str, Any]] = None, *, max_rows: int = MAX_ROWS
    ) -> Dict[str, Any]:
        """One read-only statement with ``:name`` parameters, under the time/row/byte caps."""

    @abstractmethod
    async def schema(self) -> Dict[str, Set[str]]:
        """``{table: {columns}}`` — what the dictionary should describe."""

    async def fingerprint(self) -> str:
        return schema_fingerprint(await self.schema())

    async def find_tables(
        self, q: Optional[str] = None, names: Optional[Sequence[str]] = None
    ) -> List[Dict[str, Any]]:
        """``list_tables(q)`` plus the tables in ``names`` (in that order) it missed."""
        found = await self.list_tables(q)
        if not names:
            return found
        have = {t.get("name") or t.get("table") for t in found}
        everything = {t.get("name") or t.get("table"): t for t in await self.list_tables()}
        return found + [everything[n] for n in dict.fromkeys(names) if n in everything and n not in have]


def _clamp_rows(max_rows: Any) -> int:
    try:
        value = int(max_rows or MAX_ROWS)
    except (TypeError, ValueError):
        raise EngineError("max_rows must be a number") from None
    return max(1, min(value, MAX_ROWS))


def _cell(value: Any, cell_chars: Optional[int]) -> Any:
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        return "0x" + raw[:32].hex() + ("…" if len(raw) > 32 else "")
    value = ss.jsonable(value)
    if isinstance(value, float) and value != value:
        return None
    if cell_chars and isinstance(value, str) and len(value) > cell_chars:
        return value[:cell_chars] + "…"
    return value


def shape(
    columns: Sequence[str],
    rows: Sequence[Sequence[Any]],
    *,
    max_rows: int,
    max_bytes: int = MAX_BYTES,
    cell_chars: Optional[int] = MAX_CELL_CHARS,
) -> Dict[str, Any]:
    """Cap rows, cells and total size; ``truncated`` when anything was cut."""
    out: List[List[Any]] = []
    size = len(json.dumps(list(columns), ensure_ascii=False))
    truncated = len(rows) > max_rows
    for row in rows[:max_rows]:
        cells = [_cell(v, cell_chars) for v in row]
        size += len(json.dumps(cells, ensure_ascii=False, default=str)) + 1
        if size > max_bytes:
            truncated = True
            break
        out.append(cells)
    return {"columns": list(columns), "rows": out, "row_count": len(out), "truncated": truncated}


def _byte_cap(result: Dict[str, Any], max_rows: int) -> Dict[str, Any]:
    """The byte cap for results that are already JSON-ready (cells untouched)."""
    shaped = shape(result["columns"], result["rows"], max_rows=max_rows, cell_chars=None)
    return {**result, **shaped, "truncated": bool(result.get("truncated")) or shaped["truncated"]}


def _matches(words: Sequence[str], *texts: Any) -> bool:
    text = " ".join(str(t or "") for t in texts).lower()
    return all(w in text for w in words)


# -- SQL text: one read-only statement, :name parameters --------------------------------


def _segments(sql: str, engine: str) -> List[Tuple[str, str]]:
    """Split ``sql`` into ``code`` / ``string`` / ``ident`` / ``comment`` pieces."""
    out: List[Tuple[str, str]] = []
    buf: List[str] = []
    i, n = 0, len(sql)
    backslash = engine == "mysql"

    def flush() -> None:
        if buf:
            out.append(("code", "".join(buf)))
            buf.clear()

    while i < n:
        c, two = sql[i], sql[i:i + 2]
        if two == "--" or (c == "#" and engine == "mysql"):
            j = sql.find("\n", i)
            j = n if j < 0 else j
            flush()
            out.append(("comment", sql[i:j]))
            i = j
            continue
        if two == "/*":
            j = sql.find("*/", i + 2)
            if j < 0:
                raise EngineError("unterminated /* comment")
            flush()
            out.append(("comment", sql[i:j + 2]))
            i = j + 2
            continue
        if engine == "postgres" and c == "$":
            m = re.match(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$", sql[i:])
            if m:
                tag = m.group(0)
                j = sql.find(tag, i + len(tag))
                if j < 0:
                    raise EngineError("unterminated $-quoted string")
                flush()
                out.append(("string", sql[i:j + len(tag)]))
                i = j + len(tag)
                continue
        if c in "'\"`" or (c == "[" and engine == "mssql"):
            close = "]" if c == "[" else c
            j = i + 1
            while j < n:
                if backslash and sql[j] == "\\" and close in "'\"":
                    j += 2
                    continue
                if sql[j] == close:
                    if j + 1 < n and sql[j + 1] == close:
                        j += 2
                        continue
                    break
                j += 1
            if j >= n:
                raise EngineError("unterminated quoted text")
            flush()
            out.append(("string" if c == "'" else "ident", sql[i:j + 1]))
            i = j + 1
            continue
        buf.append(c)
        i += 1
    flush()
    return out


_READ_ONLY_FIRST = {
    "postgres": ("select", "with", "table", "values"),
    "mysql": ("select", "with"),
    "sqlite": ("select", "with", "values"),
}
_FORBIDDEN = {
    # Belt and braces: the read-only session is what enforces it.
    "mysql": re.compile(
        r"\b(INSERT|UPDATE|DELETE|REPLACE|INTO|OUTFILE|DUMPFILE|LOAD_FILE|GET_LOCK|LOCK|"
        r"CALL|HANDLER)\b",
        re.IGNORECASE,
    ),
    "sqlite": re.compile(
        r"\b(INSERT|UPDATE|DELETE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|LOAD_EXTENSION)\b",
        re.IGNORECASE,
    ),
}


def check_read_only(sql: Any, engine: str) -> str:
    """One ``SELECT``/``WITH`` statement for ``engine`` (trailing ``;`` dropped), or :class:`EngineError`."""
    text = str(sql or "").strip()
    while text.endswith(";"):
        text = text[:-1].rstrip()
    if not text:
        raise EngineError("sql is required")
    if engine == "mssql":
        from hermes_cli import mssql_connections as mssql

        try:
            mssql.check_read_only(text)
        except mssql.MssqlError as exc:
            raise EngineError(str(exc)) from None
        return text
    code = " ".join(t if k == "code" else " " for k, t in _segments(text, engine))
    if ";" in code:
        raise EngineError("one statement at a time")
    words = code.split(None, 1)
    first = words[0].lower() if words else ""
    if first not in _READ_ONLY_FIRST.get(engine, ("select", "with")):
        raise EngineError("only SELECT / WITH queries are allowed (read-only)")
    forbidden = _FORBIDDEN.get(engine)
    found = forbidden.search(code) if forbidden else None
    if found:
        raise EngineError(f"'{found.group(0).upper()}' is not allowed in a read-only query")
    return text


def _clean_params(params: Optional[Mapping[str, Any]]) -> Dict[str, Any]:
    if params is None:
        return {}
    if not isinstance(params, Mapping):
        raise EngineError("params must be an object of name -> value")
    out: Dict[str, Any] = {}
    for key, value in params.items():
        if not _PARAM_NAME_RE.fullmatch(str(key)):
            raise EngineError("param names must be letters, digits and _")
        if value is not None and not isinstance(value, (str, int, float, bool)):
            raise EngineError(f"param {key!r} must be text, a number, true/false or null")
        out[str(key)] = value
    return out


def bind_named(
    sql: str, params: Optional[Mapping[str, Any]], engine: str
) -> Tuple[str, Any]:
    """``:name`` placeholders (SQL Server also ``@name``) -> the driver's own style.

    Returns the rewritten SQL and the driver arguments: a positional list for
    Postgres (``$1``), a dict for the others. Placeholders inside strings,
    quoted names and comments are left alone. Every placeholder needs a value
    and every value a placeholder.
    """
    values = _clean_params(params)
    if not values:
        return sql, ([] if engine == "postgres" else None)
    marker = r"(?<![:\w]):([A-Za-z_]\w*)"
    if engine == "mssql":
        marker = r"(?<![:\w]):([A-Za-z_]\w*)|(?<![@\w])@([A-Za-z_]\w*)"
    pattern = re.compile(marker)
    used: List[str] = []
    positional: List[Any] = []

    def sub(m: "re.Match[str]") -> str:
        name = m.group(1) or (m.group(2) if m.lastindex and m.lastindex >= 2 else None)
        if m.group(0).startswith("@") and name not in values:
            return m.group(0)
        if name not in values:
            raise EngineError(f"no value given for :{name}")
        if name not in used:
            used.append(name)
            positional.append(values[name])
        if engine == "postgres":
            return f"${used.index(name) + 1}"
        if engine == "sqlite":
            return f":{name}"
        return f"%({name})s"

    pieces = []
    for kind, text in _segments(sql, engine):
        if engine in ("mysql", "mssql"):
            text = text.replace("%", "%%")
        pieces.append(pattern.sub(sub, text) if kind == "code" else text)
    unused = sorted(set(values) - set(used))
    if unused:
        raise EngineError(f"param {unused[0]!r} is not used in the sql")
    if engine == "postgres":
        return "".join(pieces), positional
    return "".join(pieces), {k: values[k] for k in used}


# -- Postgres: site schemas and Aquarium's own data ------------------------------------


class SiteAdapter(EngineAdapter):
    """A site's schema in Aquarium's Supabase, read as the site's ``_ro`` role."""

    engine = "postgres"

    def __init__(self, site: Any, *, db: Any = None) -> None:
        self.site = site
        self.db = db

    async def list_tables(self, q: Optional[str] = None) -> List[Dict[str, Any]]:
        return await ss.table_summaries(self.site, q=q, db=self.db)

    async def find_tables(
        self, q: Optional[str] = None, names: Optional[Sequence[str]] = None
    ) -> List[Dict[str, Any]]:
        return await ss.table_summaries(self.site, q=q, names=names, db=self.db)

    async def describe_table(self, name: str, *, samples: int = SAMPLE_VALUES) -> Dict[str, Any]:
        return await ss.describe_entity(self.site, name, samples=samples, db=self.db)

    async def query(
        self, sql: str, params: Optional[Mapping[str, Any]] = None, *, max_rows: int = MAX_ROWS
    ) -> Dict[str, Any]:
        max_rows = _clamp_rows(max_rows)
        sql, args = bind_named(str(sql or ""), params, "postgres") if params else (sql, [])
        result = await ss.query(self.site, sql, args, max_rows=max_rows, db=self.db)
        return _byte_cap(result, max_rows)

    async def schema(self) -> Dict[str, Set[str]]:
        current = await ss.approved_design(self.site, db=self.db)
        if current is None:
            return {}
        _version, design, _recipe = current
        return {
            e["name"]: {c["name"] for c in e["columns"]}
            for e in ss.validate_design(design)["entities"]
        }


class AppAdapter(EngineAdapter):
    """Aquarium's own data: private per-person copies of each area."""

    engine = "postgres"

    def __init__(self, principal: Any, *, store: Any = None) -> None:
        self.principal = principal
        self.store = store

    async def list_tables(self, q: Optional[str] = None) -> List[Dict[str, Any]]:
        from hermes_cli import app_data

        words = (q or "").lower().split()
        areas = await app_data.describe(self.principal, store=self.store)
        return [
            a for a in areas
            if _matches(words, a.get("table"), a.get("label"), *(c["name"] for c in a.get("columns") or []))
        ]

    async def describe_table(self, name: str, *, samples: int = SAMPLE_VALUES) -> Dict[str, Any]:
        for area in await self.list_tables():
            if area.get("table") == name:
                return area
        raise EngineError(f"no table {name!r}")

    async def query(
        self,
        sql: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        max_rows: int = MAX_ROWS,
        areas: Optional[Sequence[str]] = None,
    ) -> Dict[str, Any]:
        from hermes_cli import app_data

        max_rows = _clamp_rows(max_rows)
        if not areas:
            code = " ".join(t for k, t in _segments(str(sql or ""), "postgres") if k != "comment")
            areas = [a for a in app_data.schema() if re.search(rf"\b{re.escape(a)}\b", code, re.I)]
        sql, args = bind_named(str(sql or ""), params, "postgres") if params else (sql, [])
        kwargs: Dict[str, Any] = {"max_rows": max_rows}
        if self.store is not None:
            kwargs["store"] = self.store
        extra = (args,) if args else ()
        result = await app_data.query(self.principal, areas, sql, *extra, **kwargs)
        return _byte_cap(result, max_rows)

    async def schema(self) -> Dict[str, Set[str]]:
        from hermes_cli import app_data

        return {name: set(cols) for name, cols in app_data.schema().items()}


# -- live engines: SQL Server, PostgreSQL, MySQL, SQLite -------------------------------


class _LiveAdapter(EngineAdapter):
    """Shared DB-API plumbing; engines supply the catalog SQL and quoting.

    Every call opens its own read-only connection in a worker thread and
    closes it; nothing is ever committed.
    """

    def __init__(self, payload: Mapping[str, Any], *, label: str = "") -> None:
        self.payload = payload
        self.label = label

    # engine hooks
    def _connect(self) -> Any:
        raise NotImplementedError

    def _tables(self, conn: Any) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def _all_columns(self, conn: Any) -> Dict[str, List[str]]:
        raise NotImplementedError

    def _columns(self, conn: Any, table: Mapping[str, Any]) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def _keys(self, conn: Any, table: Mapping[str, Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
        raise NotImplementedError

    def _ref(self, table: Mapping[str, Any]) -> str:
        raise NotImplementedError

    def _sample_from(self, ref: str) -> str:
        return f"(SELECT * FROM {ref} LIMIT {STATS_SAMPLE_ROWS}) s"

    def _top(self, select_rest: str, k: int) -> str:
        return f"SELECT {select_rest} LIMIT {k}"

    def _quote(self, name: str) -> str:
        return '"' + name.replace('"', '""') + '"'

    def _error(self, exc: BaseException) -> str:
        return f"{type(exc).__name__}: {exc}"

    # shared plumbing
    def _fetch(self, conn: Any, sql: str, params: Any = None) -> List[Tuple[Any, ...]]:
        cur = conn.cursor()
        try:
            if params is None:
                cur.execute(sql)
            else:
                cur.execute(sql, params)
            return [tuple(r) for r in cur.fetchall()]
        finally:
            with contextlib.suppress(Exception):
                cur.close()

    @contextlib.contextmanager
    def _open(self):
        try:
            conn = self._connect()
        except EngineError:
            raise
        except Exception as exc:
            raise EngineError(f"could not connect: {self._error(exc)}", 502) from None
        try:
            yield conn
        finally:
            with contextlib.suppress(Exception):
                conn.rollback()
            with contextlib.suppress(Exception):
                conn.close()

    async def _thread(self, fn: Any, *args: Any) -> Any:
        try:
            return await asyncio.to_thread(fn, *args)
        except EngineError:
            raise
        except Exception as exc:  # noqa: BLE001 - driver errors, scrubbed by the engine
            raise EngineError(f"query failed: {self._error(exc)}") from None

    def _find(self, conn: Any, name: str) -> Dict[str, Any]:
        tables = self._tables(conn)
        for table in tables:
            if table["name"] == name:
                return table
        lowered = [t for t in tables if t["name"].lower() == str(name).lower()]
        if len(lowered) == 1:
            return lowered[0]
        raise EngineError(f"no table {name!r}", 404)

    def _sync_list(self, q: Optional[str]) -> List[Dict[str, Any]]:
        words = (q or "").lower().split()
        with self._open() as conn:
            tables = self._tables(conn)
            columns = self._all_columns(conn) if words else {}
        out = []
        for t in tables:
            if words and not _matches(words, t["name"], t.get("comment"), *columns.get(t["name"], [])):
                continue
            out.append({k: t.get(k) for k in ("name", "schema", "type", "rows", "comment")
                        if k != "schema" or t.get(k)})
        return out[:MAX_TABLES]

    def _sync_schema(self) -> Dict[str, Set[str]]:
        with self._open() as conn:
            names = {t["name"] for t in self._tables(conn)}
            columns = self._all_columns(conn)
        return {name: set(columns.get(name, [])) for name in names}

    def _sync_describe(self, name: str, samples: int) -> Dict[str, Any]:
        samples = max(0, min(int(samples if samples is not None else SAMPLE_VALUES), 20))
        with self._open() as conn:
            table = self._find(conn, name)
            columns = self._columns(conn, table)
            primary, foreign = self._keys(conn, table)
            ref = self._ref(table)
            src = self._sample_from(ref)
            sampled = self._fetch(conn, f"SELECT COUNT(*) FROM {src}")[0][0]
            for i, col in enumerate(columns):
                col["key"] = col["name"] in primary
                col.setdefault("filled", None)
                col.setdefault("distinct", None)
                col.setdefault("common_values", [])
                if i >= STATS_MAX_COLUMNS:
                    continue
                c = self._quote(col["name"])
                try:
                    filled, distinct = self._fetch(conn, f"SELECT COUNT({c}), COUNT(DISTINCT {c}) FROM {src}")[0]
                    common = []
                    if samples:
                        common = self._fetch(conn, self._top(
                            f"{c} AS value, COUNT(*) AS n FROM {src} WHERE {c} IS NOT NULL "
                            f"GROUP BY {c} ORDER BY COUNT(*) DESC", samples))
                except Exception:  # noqa: BLE001 - e.g. text/blob types can't be grouped
                    with contextlib.suppress(Exception):
                        self._after_error(conn)
                    continue
                col.update(
                    filled=filled,
                    distinct=distinct,
                    common_values=[[_cell(v, 200), n] for v, n in common],
                )
        return {
            "name": table["name"],
            "type": table.get("type"),
            "comment": table.get("comment") or "",
            "rows": table.get("rows"),
            "key": primary,
            "foreign_keys": foreign,
            "sampled_rows": sampled,
            "columns": columns,
            "sql_hint": f"SELECT ... FROM {ref}",
        }

    def _after_error(self, conn: Any) -> None:
        """Reset the session after a failed stats query (Postgres-style aborts)."""

    def _sync_query(self, sql: str, params: Any, max_rows: int) -> Dict[str, Any]:
        with self._open() as conn:
            cur = conn.cursor()
            try:
                if params is None:
                    cur.execute(sql)
                else:
                    cur.execute(sql, params)
                columns = [str(d[0]) for d in (cur.description or [])]
                rows = list(cur.fetchmany(max_rows + 1)) if columns else []
            finally:
                with contextlib.suppress(Exception):
                    cur.close()
        return shape(columns, [tuple(r) for r in rows], max_rows=max_rows)

    # the interface
    async def list_tables(self, q: Optional[str] = None) -> List[Dict[str, Any]]:
        return await self._thread(self._sync_list, q)

    async def describe_table(self, name: str, *, samples: int = SAMPLE_VALUES) -> Dict[str, Any]:
        return await self._thread(self._sync_describe, str(name or ""), samples)

    async def query(
        self, sql: str, params: Optional[Mapping[str, Any]] = None, *, max_rows: int = MAX_ROWS
    ) -> Dict[str, Any]:
        max_rows = _clamp_rows(max_rows)
        text = check_read_only(sql, self.engine)
        text, args = bind_named(text, params, self.engine)
        return await self._thread(self._sync_query, text, args, max_rows)

    async def schema(self) -> Dict[str, Set[str]]:
        return await self._thread(self._sync_schema)


class MssqlAdapter(_LiveAdapter):
    """A SQL Server connection from Settings (python-tds, the ``mssql`` extra)."""

    engine = "mssql"

    def __init__(self, payload: Mapping[str, Any], *, ip: Optional[str] = None, label: str = "") -> None:
        super().__init__(payload, label=label)
        self.ip = ip

    def _connect(self) -> Any:
        from hermes_cli import mssql_connections as mssql

        conn = mssql.connect(self.payload, ip=self.ip, timeout=QUERY_TIMEOUT)
        cur = conn.cursor()
        cur.execute("SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED")
        cur.close()
        return conn

    def _error(self, exc: BaseException) -> str:
        from hermes_cli import mssql_connections as mssql

        return mssql.plain_error(exc, self.payload)

    def _quote(self, name: str) -> str:
        return "[" + name.replace("]", "]]") + "]"

    def _ref(self, table: Mapping[str, Any]) -> str:
        return f"{self._quote(table['schema'])}.{self._quote(table['table'])}"

    def _sample_from(self, ref: str) -> str:
        return f"(SELECT TOP {STATS_SAMPLE_ROWS} * FROM {ref}) s"

    def _top(self, select_rest: str, k: int) -> str:
        return f"SELECT TOP {k} {select_rest}"

    def _tables(self, conn: Any) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT s.name, o.name, o.type, "
            "(SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id "
            "AND p.index_id IN (0, 1)), CAST(ep.value AS nvarchar(2000)) "
            "FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id "
            "LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id "
            "AND ep.minor_id = 0 AND ep.name = 'MS_Description' "
            "WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name"
        ))
        return [
            {"name": f"{s}.{t}", "schema": s, "table": t,
             "type": "view" if str(kind).strip() == "V" else "table",
             "rows": int(n) if n is not None else None, "comment": c or ""}
            for s, t, kind, n, c in rows
        ]

    def _all_columns(self, conn: Any) -> Dict[str, List[str]]:
        out: Dict[str, List[str]] = {}
        for s, t, c in self._fetch(conn, (
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
            "ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION"
        )):
            out.setdefault(f"{s}.{t}", []).append(c)
        return out

    def _columns(self, conn: Any, table: Mapping[str, Any]) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length, c.is_nullable, "
            "CAST(ep.value AS nvarchar(2000)) FROM sys.columns c "
            "LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id "
            "AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' "
            "WHERE c.object_id = OBJECT_ID(%(obj)s) ORDER BY c.column_id"
        ), {"obj": self._ref(table)})
        return [
            {"name": n, "type": t, "max_length": m, "nullable": bool(nullable), "comment": c or ""}
            for n, t, m, nullable, c in rows
        ]

    def _keys(self, conn: Any, table: Mapping[str, Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
        obj = {"obj": self._ref(table)}
        primary = [r[0] for r in self._fetch(conn, (
            "SELECT c.name FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id "
            "AND ic.index_id = i.index_id JOIN sys.columns c ON c.object_id = ic.object_id "
            "AND c.column_id = ic.column_id WHERE i.is_primary_key = 1 "
            "AND i.object_id = OBJECT_ID(%(obj)s) ORDER BY ic.key_ordinal"
        ), obj)]
        foreign: Dict[str, Dict[str, Any]] = {}
        for fk, col, rs, rt, rc in self._fetch(conn, (
            "SELECT fk.name, pc.name, rs.name, rt.name, rc.name FROM sys.foreign_keys fk "
            "JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id "
            "JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id "
            "JOIN sys.objects rt ON rt.object_id = fkc.referenced_object_id "
            "JOIN sys.schemas rs ON rs.schema_id = rt.schema_id "
            "JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id "
            "AND rc.column_id = fkc.referenced_column_id "
            "WHERE fk.parent_object_id = OBJECT_ID(%(obj)s) ORDER BY fk.name, fkc.constraint_column_id"
        ), obj):
            item = foreign.setdefault(fk, {"columns": [], "to_table": f"{rs}.{rt}", "to_columns": []})
            item["columns"].append(col)
            item["to_columns"].append(rc)
        return primary, list(foreign.values())


class _PgCursor:
    """The DB-API cursor surface :class:`_LiveAdapter` uses, over pg8000's native API."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn
        self._rows: List[Any] = []
        self.description: Optional[List[Tuple[str]]] = None

    def execute(self, sql: str, params: Any = None) -> None:
        if params:
            ctx = self._conn.execute_unnamed(sql, vals=tuple(params))
        else:
            ctx = self._conn.execute_simple(sql)
        self._rows = list(ctx.rows or [])
        self.description = [(c["name"],) for c in ctx.columns] if ctx.columns else None

    def fetchall(self) -> List[Any]:
        return list(self._rows)

    def fetchmany(self, n: int) -> List[Any]:
        return self._rows[:n]

    def close(self) -> None:
        self._rows = []


class _PgConn:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    def cursor(self) -> _PgCursor:
        return _PgCursor(self._conn)

    def rollback(self) -> None:
        self._conn.run("ROLLBACK")

    def close(self) -> None:
        self._conn.close()


class PostgresAdapter(_LiveAdapter):
    """An external PostgreSQL connection from Settings (pg8000, the ``postgres`` extra).

    Every session is read-only (``default_transaction_read_only`` plus a
    read-only transaction) with a statement timeout; a query is wrapped in a
    ``LIMIT`` so the server never sends more than the row cap.
    """

    engine = "postgres"

    def __init__(self, payload: Mapping[str, Any], *, ip: Optional[str] = None, label: str = "") -> None:
        super().__init__(payload, label=label)
        self.ip = ip

    def _connect(self) -> Any:
        from hermes_cli import db_connections

        pg8000 = db_connections.postgres_driver()
        p = self.payload
        conn = pg8000.native.Connection(
            user=p["username"],
            password=p.get("password") or "",
            host=self.ip or p["host"],
            port=int(p.get("port") or db_connections.DEFAULT_PORTS["postgres"]),
            database=p["database"],
            ssl_context=db_connections.tls_context(p),
            timeout=QUERY_TIMEOUT + 5,
            application_name="Hermes",
        )
        try:
            for stmt in (
                "SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY",
                f"SET statement_timeout = {QUERY_TIMEOUT * 1000}",
                "SET idle_in_transaction_session_timeout = 60000",
                "START TRANSACTION READ ONLY",
            ):
                conn.run(stmt)
        except BaseException:
            with contextlib.suppress(Exception):
                conn.close()
            raise
        return _PgConn(conn)

    def _error(self, exc: BaseException) -> str:
        text = str(exc)
        secret = str(self.payload.get("password") or "")
        if secret:
            text = text.replace(secret, "***")
        return f"{type(exc).__name__}: {text}"[:500]

    def _ref(self, table: Mapping[str, Any]) -> str:
        return f"{self._quote(table['schema'])}.{self._quote(table['table'])}"

    def _sync_query(self, sql: str, params: Any, max_rows: int) -> Dict[str, Any]:
        return super()._sync_query(f"SELECT * FROM (\n{sql}\n) AS q LIMIT {max_rows + 1}",
                                   params, max_rows)

    _USER_FILTER = (
        "c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition "
        "AND n.nspname NOT IN ('pg_catalog', 'information_schema') "
        "AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%' "
        "AND has_table_privilege(c.oid, 'SELECT')"
    )
    _USER_RELATIONS = (
        "FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE " + _USER_FILTER
    )

    def _tables(self, conn: Any) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT n.nspname, c.relname, c.relkind, "
            "CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END, "
            f"obj_description(c.oid, 'pg_class') {self._USER_RELATIONS} ORDER BY 1, 2"
        ))
        return [
            {"name": f"{s}.{t}", "schema": s, "table": t,
             "type": "view" if kind in ("v", "m") else "table",
             "rows": int(n) if n is not None else None, "comment": c or ""}
            for s, t, kind, n, c in rows
        ]

    def _all_columns(self, conn: Any) -> Dict[str, List[str]]:
        out: Dict[str, List[str]] = {}
        for s, t, col in self._fetch(conn, (
            "SELECT n.nspname, c.relname, a.attname FROM pg_attribute a "
            "JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace "
            f"WHERE a.attnum > 0 AND NOT a.attisdropped AND {self._USER_FILTER} "
            "ORDER BY n.nspname, c.relname, a.attnum"
        )):
            out.setdefault(f"{s}.{t}", []).append(col)
        return out

    def _columns(self, conn: Any, table: Mapping[str, Any]) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, "
            "col_description(a.attrelid, a.attnum) FROM pg_attribute a "
            "WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped "
            "ORDER BY a.attnum"
        ), [self._ref(table)])
        return [
            {"name": n, "type": t, "nullable": bool(nullable), "comment": c or ""}
            for n, t, nullable, c in rows
        ]

    def _keys(self, conn: Any, table: Mapping[str, Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
        ref = [self._ref(table)]
        primary = [r[0] for r in self._fetch(conn, (
            "SELECT a.attname FROM pg_index i "
            "CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(col, ord) "
            "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.col "
            "WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY k.ord"
        ), ref)]
        foreign: Dict[str, Dict[str, Any]] = {}
        for fk, col, rs, rt, rc in self._fetch(conn, (
            "SELECT con.conname, a.attname, rn.nspname, rcl.relname, ra.attname "
            "FROM pg_constraint con "
            "CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(col, ref, ord) "
            "JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.col "
            "JOIN pg_class rcl ON rcl.oid = con.confrelid "
            "JOIN pg_namespace rn ON rn.oid = rcl.relnamespace "
            "JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.ref "
            "WHERE con.contype = 'f' AND con.conrelid = $1::regclass ORDER BY con.conname, k.ord"
        ), ref):
            item = foreign.setdefault(fk, {"columns": [], "to_table": f"{rs}.{rt}", "to_columns": []})
            item["columns"].append(col)
            item["to_columns"].append(rc)
        return primary, list(foreign.values())


class MysqlAdapter(_LiveAdapter):
    """A MySQL / MariaDB connection (PyMySQL, the ``mysql`` extra)."""

    engine = "mysql"

    def __init__(self, payload: Mapping[str, Any], *, ip: Optional[str] = None, label: str = "") -> None:
        super().__init__(payload, label=label)
        self.ip = ip

    def _connect(self) -> Any:
        from hermes_cli import db_connections

        pymysql = db_connections.mysql_driver()
        p = self.payload
        kwargs: Dict[str, Any] = {
            "host": self.ip or p["host"],
            "port": int(p.get("port") or db_connections.MYSQL_DEFAULT_PORT),
            "user": p["username"],
            "password": p.get("password") or "",
            "database": p["database"],
            "connect_timeout": 15,
            "read_timeout": QUERY_TIMEOUT + 5,
            "write_timeout": QUERY_TIMEOUT + 5,
            "charset": "utf8mb4",
            "autocommit": False,
            "program_name": "Hermes",
        }
        ssl = db_connections.mysql_ssl(p)
        if ssl is None:
            kwargs["ssl_disabled"] = True
        else:
            kwargs["ssl"] = ssl
        conn = pymysql.connect(**kwargs)
        try:
            cur = conn.cursor()
            cur.execute("SET SESSION TRANSACTION READ ONLY")
            for stmt in (f"SET SESSION MAX_EXECUTION_TIME = {QUERY_TIMEOUT * 1000}",
                         f"SET SESSION max_statement_time = {QUERY_TIMEOUT}"):
                try:
                    cur.execute(stmt)
                    break
                except pymysql.MySQLError:
                    continue
            cur.execute("START TRANSACTION READ ONLY")
            cur.close()
        except BaseException:
            conn.close()
            raise
        return conn

    def _error(self, exc: BaseException) -> str:
        text = str(exc)
        secret = str(self.payload.get("password") or "")
        if secret:
            text = text.replace(secret, "***")
        return f"{type(exc).__name__}: {text}"[:500]

    def _quote(self, name: str) -> str:
        return "`" + name.replace("`", "``") + "`"

    def _ref(self, table: Mapping[str, Any]) -> str:
        return self._quote(table["name"])

    def _tables(self, conn: Any) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES "
            "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME"
        ))
        return [
            {"name": t, "type": "view" if "VIEW" in str(kind).upper() else "table",
             "rows": int(n) if n is not None else None, "comment": c or ""}
            for t, kind, n, c in rows
        ]

    def _all_columns(self, conn: Any) -> Dict[str, List[str]]:
        out: Dict[str, List[str]] = {}
        for t, c in self._fetch(conn, (
            "SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION"
        )):
            out.setdefault(t, []).append(c)
        return out

    def _columns(self, conn: Any, table: Mapping[str, Any]) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT FROM information_schema.COLUMNS "
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = %s ORDER BY ORDINAL_POSITION"
        ), (table["name"],))
        return [
            {"name": n, "type": t.decode() if isinstance(t, bytes) else t,
             "nullable": str(nullable).upper() == "YES", "comment": c or ""}
            for n, t, nullable, c in rows
        ]

    def _keys(self, conn: Any, table: Mapping[str, Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
        primary: List[str] = []
        foreign: Dict[str, Dict[str, Any]] = {}
        for name, col, rt, rc in self._fetch(conn, (
            "SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME "
            "FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() "
            "AND TABLE_NAME = %s ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION"
        ), (table["name"],)):
            if name == "PRIMARY":
                primary.append(col)
            elif rt:
                item = foreign.setdefault(name, {"columns": [], "to_table": rt, "to_columns": []})
                item["columns"].append(col)
                item["to_columns"].append(rc)
        return primary, list(foreign.values())


class SqliteAdapter(_LiveAdapter):
    """A SQLite file on the box, opened read-only (stdlib ``sqlite3``)."""

    engine = "sqlite"

    def _connect(self) -> Any:
        from hermes_cli import db_connections

        path = db_connections.sqlite_path(self.payload.get("path"))
        conn = sqlite3.connect(
            f"file:{quote(str(path))}?mode=ro", uri=True, timeout=5, check_same_thread=False
        )
        deadline = time.monotonic() + QUERY_TIMEOUT
        conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 10_000)
        conn.execute("PRAGMA query_only = ON")
        return conn

    def _ref(self, table: Mapping[str, Any]) -> str:
        return self._quote(table["name"])

    def _tables(self, conn: Any) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, (
            "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
        ))
        stats: Dict[str, int] = {}
        with contextlib.suppress(sqlite3.Error):
            for tbl, stat in self._fetch(conn, "SELECT tbl, stat FROM sqlite_stat1 WHERE idx IS NULL OR idx = tbl"):
                with contextlib.suppress(ValueError, IndexError):
                    stats[tbl] = int(str(stat).split()[0])
        out = []
        for name, kind in rows[:MAX_TABLES]:
            count = stats.get(name)
            if count is None and kind == "table":
                count = self._fetch(conn, (
                    f"SELECT COUNT(*) FROM (SELECT 1 FROM {self._quote(name)} LIMIT {SQLITE_COUNT_CAP})"
                ))[0][0]
            out.append({"name": name, "type": kind, "rows": count, "comment": ""})
        return out

    def _all_columns(self, conn: Any) -> Dict[str, List[str]]:
        out: Dict[str, List[str]] = {}
        for (name,) in self._fetch(conn, (
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') "
            "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'"
        )):
            out[name] = [r[0] for r in self._fetch(conn, "SELECT name FROM pragma_table_info(?)", (name,))]
        return out

    def _columns(self, conn: Any, table: Mapping[str, Any]) -> List[Dict[str, Any]]:
        rows = self._fetch(conn, 'SELECT name, type, "notnull" FROM pragma_table_info(?) ORDER BY cid',
                           (table["name"],))
        return [{"name": n, "type": t or "", "nullable": not notnull, "comment": ""} for n, t, notnull in rows]

    def _keys(self, conn: Any, table: Mapping[str, Any]) -> Tuple[List[str], List[Dict[str, Any]]]:
        primary = [r[0] for r in self._fetch(
            conn, "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", (table["name"],))]
        foreign: Dict[int, Dict[str, Any]] = {}
        for fid, to_table, col, to_col in self._fetch(
            conn, 'SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq',
            (table["name"],),
        ):
            item = foreign.setdefault(fid, {"columns": [], "to_table": to_table, "to_columns": []})
            item["columns"].append(col)
            item["to_columns"].append(to_col)
        return primary, list(foreign.values())


# -- sources -> adapters ---------------------------------------------------------------


async def _owner_principal(user_id: str) -> Any:
    """The data source owner's own principal (their role decides which VPNs they may use)."""
    from hermes_cli.access import Principal, PrincipalStore
    from hermes_cli.config import load_config_readonly
    from hermes_cli.datastore import get_store

    try:
        owner = await PrincipalStore(
            get_store("supabase-app", "prod", config=load_config_readonly() or {})
        ).get(user_id)
    except Exception:  # noqa: BLE001 - no principal store (tests, CLI): their own rows still resolve
        logger.debug("could not load the data source owner's principal", exc_info=True)
        owner = None
    if owner is not None and not owner.active:
        raise EngineError("the person who added this data source is suspended", 403)
    return owner or Principal(user_id=user_id, display=user_id, role="member")


async def connection_refs(principal: Any) -> List[Dict[str, str]]:
    """The caller's OWN Settings connections, as ``{engine, name, label}`` (no secrets)."""
    from hermes_cli import db_connections
    from hermes_cli import mssql_connections as mssql

    refs: List[Dict[str, str]] = []
    for entry in await mssql.own_entries(principal):
        refs.append({"engine": "mssql", "name": entry.name, "label": entry.payload.get("label") or ""})
    for entry in await db_connections.own_entries(principal):
        refs.append({"engine": entry.provider, "name": entry.name,
                     "label": entry.payload.get("label") or ""})
    return refs


async def _connection_adapter(source: Any, principal: Any, *, agent: bool) -> EngineAdapter:
    from hermes_cli import db_connections
    from hermes_cli import mssql_connections as mssql

    name = source.connection_name or ""
    if source.engine == "mssql":
        entries = await mssql.own_entries(principal)
        entry = next((e for e in entries if e.name == name), None)
        if entry is None:
            raise EngineError(f"the SQL Server connection '{name}' is gone from Settings", 404)
        try:
            ip = await mssql.route_for(principal, entry, agent=agent)
        except mssql.MssqlError as exc:
            raise EngineError(str(exc), 502) from None
        return MssqlAdapter(entry.payload, ip=ip, label=name)
    entry = await db_connections.find_own(principal, source.engine, name)
    if entry is None:
        raise EngineError(f"the {source.engine} connection '{name}' is gone from Settings", 404)
    if source.engine == "mysql":
        ip = await db_connections.route_for(principal, entry, agent=agent)
        return MysqlAdapter(entry.payload, ip=ip, label=name)
    if source.engine == "postgres":
        ip = await db_connections.route_for(principal, entry, agent=agent)
        return PostgresAdapter(entry.payload, ip=ip, label=name)
    if source.engine == "sqlite":
        return SqliteAdapter(entry.payload, label=name)
    raise EngineError(f"unknown engine {source.engine!r}")


async def adapter_for(source: Any, principal: Any, *, agent: bool = True, db: Any = None) -> EngineAdapter:
    """The adapter that reads ``source`` for ``principal``.

    The caller has already checked the principal may read the source. A
    Settings data source is always opened with its owner's saved read-only
    login, also for admins and the people it is shared with, who never see
    that login; writes ("Allow changes") are never shared — every adapter
    query is one read-only statement.
    """
    if source.kind == "site":
        site = await ss.get_site(source.site_id, db=db) if source.site_id else None
        if site is None:
            raise EngineError("this source's site no longer exists", 404)
        return SiteAdapter(site, db=db)
    if source.kind == "app":
        return AppAdapter(principal)
    if source.kind == "connection":
        if not source.owner_user_id:
            raise EngineError("this data source has no owner", 404)
        if getattr(principal, "user_id", None) != source.owner_user_id:
            principal = await _owner_principal(source.owner_user_id)
        return await _connection_adapter(source, principal, agent=agent)
    raise EngineError(f"unknown source kind {source.kind!r}")


async def source_schema(source: Any, *, db: Any = None) -> Dict[str, Set[str]]:
    """The live schema of a connection source, read with its owner's login (drift checks)."""
    adapter = await adapter_for(source, await _owner_principal(source.owner_user_id), agent=False, db=db)
    return await adapter.schema()


async def run_query(
    source: Any,
    adapter: EngineAdapter,
    principal: Any,
    sql: str,
    params: Optional[Mapping[str, Any]] = None,
    *,
    max_rows: int = MAX_ROWS,
    dictionary_version: Optional[int] = None,
    **extra: Any,
) -> Dict[str, Any]:
    """Run one query through ``adapter`` and log who ran what against which source."""
    started = time.monotonic()
    status = "error"
    rows = 0
    try:
        result = await adapter.query(sql, params, max_rows=max_rows, **extra)
        status, rows = "ok", result.get("row_count", 0)
        return result
    finally:
        logger.info(
            "data query: person=%s source=%s kind=%s engine=%s dictionary=%s rows=%s status=%s ms=%d",
            getattr(principal, "user_id", None), getattr(source, "id", source),
            getattr(source, "kind", "site"), adapter.engine,
            f"v{dictionary_version}" if dictionary_version else "none", rows, status,
            int((time.monotonic() - started) * 1000),
        )


async def remember_connection(principal: Any) -> None:
    """Make sure the caller's Settings connections are data sources (best effort).

    Run after a save so admins see a new source before its owner opens Data.
    """
    from hermes_cli import data_dictionary as dd

    try:
        await dd.sync_connection_sources(principal, ss.current_profile())
    except Exception:  # noqa: BLE001 - saving the connection itself already succeeded
        logger.warning("could not record the data source for a saved connection", exc_info=True)


async def forget_connection(owner_user_id: str, engine: str, name: str) -> None:
    """Drop the data source of a connection its owner deleted (best effort)."""
    from hermes_cli import data_dictionary as dd

    try:
        await dd.delete_connection_source(ss.current_profile(), engine, owner_user_id, name)
    except Exception:  # noqa: BLE001 - deleting the connection itself already succeeded
        logger.warning("could not remove the data source for %s:%s", engine, name, exc_info=True)

