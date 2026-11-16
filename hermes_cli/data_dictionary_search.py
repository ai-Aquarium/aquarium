"""Search over large data dictionaries (plan 2026-11-14-001, Phase 7).

A dictionary with hundreds of tables is too big to load whole into a chat, so
the agent asks for the entries that matter to the question instead. Each
approved table entry and glossary term becomes one row of
``data_dictionary_index`` with an embedding from the live-memory embedder
(``memory.embedding`` in config.yaml, FG-21), stored in a pgvector column.

Ranking fuses two arms by reciprocal rank, like the RAG tier: cosine
similarity (when pgvector and the embedder are available) and a keyword score
computed here (always available). When embeddings are unavailable the keyword
arm alone answers. Dictionaries that fit the size budget are returned whole,
exactly as before.

The index follows the approved version: :func:`reindex` runs after approve and
restore, and a search whose index is behind (or was built by another model)
rebuilds it first. Only changed entries are re-embedded. Callers resolve the
person's access to the source before calling any of this; :func:`search_all`
only ever looks at sources :func:`data_dictionary.list_sources` lets them read.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import math
import re
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from hermes_cli import data_dictionary as dd
from hermes_cli import site_sources as ss

logger = logging.getLogger(__name__)

#: Dictionaries whose approved entries serialise to at most this many
#: characters are returned whole; larger ones are searched.
FULL_BELOW_CHARS = 12_000
#: Most characters of entries one search returns.
BUDGET_CHARS = 12_000
TOP_K = 8
MAX_TOP_K = 20
#: Characters of one entry sent to the embedder (the local service caps texts).
EMBED_CHARS = 4_000
_EMBED_BATCH = 32
_ARM_DEPTH = 50
_RRF_K = 60
_MEANING_CHARS = 160

DDL = """
CREATE TABLE IF NOT EXISTS public.data_dictionary_index (
    source_id uuid NOT NULL REFERENCES public.data_sources (id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('table', 'term')),
    key text NOT NULL,
    body text NOT NULL,
    body_hash text NOT NULL,
    embedding_model text NOT NULL DEFAULT '',
    PRIMARY KEY (source_id, kind, key)
);
CREATE TABLE IF NOT EXISTS public.data_dictionary_index_state (
    source_id uuid PRIMARY KEY REFERENCES public.data_sources (id) ON DELETE CASCADE,
    version integer,
    embedding_model text NOT NULL DEFAULT '',
    indexed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.data_dictionary_index, public.data_dictionary_index_state FROM PUBLIC;
"""

_TABLES = ("data_dictionary_index", "data_dictionary_index_state")
_ready: set = set()


# -- text --------------------------------------------------------------------

_WORD_RE = re.compile(r"[a-z0-9]+")
_CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+")


def tokens(text: str) -> List[str]:
    """Lower-case words (``order_items`` also gives ``order``, ``items``), plain
    plurals folded, and CJK characters plus their bigrams."""
    text = str(text or "").lower()
    out: List[str] = []
    for word in _WORD_RE.findall(text):
        out.append(word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word)
    for run in _CJK_RE.findall(text):
        out.extend(run)
        out.extend(run[i:i + 2] for i in range(len(run) - 1))
    return out


def _name_tokens(name: str) -> List[str]:
    return tokens(name.replace("_", " ")) + tokens(name)


def table_text(name: str, entry: Mapping[str, Any]) -> str:
    """What one table entry says, as the text that gets embedded and searched."""
    lines = [f"Table {name}: {entry.get('meaning') or ''}".strip()]
    if entry.get("row") or entry.get("grain"):
        lines.append(f"One row: {entry.get('row') or ''}. Grain: {entry.get('grain') or ''}.")
    columns = entry.get("columns") or {}
    if columns:
        lines.append("Columns: " + "; ".join(
            f"{c} ({d})" if d else c for c, d in columns.items()))
    for join in entry.get("joins") or []:
        lines.append(f"Joins {join.get('to')} on {join.get('on')}. {join.get('note') or ''}".strip())
    for metric in entry.get("metrics") or []:
        lines.append(f"Metric {metric.get('name')}: {metric.get('definition') or ''}")
    for example in entry.get("examples") or []:
        lines.append(f"Example: {example.get('question')}")
    return "\n".join(lines)[:EMBED_CHARS]


def term_text(term: Mapping[str, Any]) -> str:
    return f"Term {term.get('term')}: {term.get('definition') or ''}"[:EMBED_CHARS]


def units(entries: Mapping[str, Any]) -> List[Tuple[str, str, str]]:
    """``(kind, key, text)`` for every table and glossary term."""
    out = [("table", name, table_text(name, entry))
           for name, entry in sorted((entries.get("tables") or {}).items())]
    seen = set()
    for term in entries.get("glossary") or []:
        key = str(term.get("term") or "")
        if key and key not in seen:
            seen.add(key)
            out.append(("term", key, term_text(term)))
    return out


def _size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, default=str))


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# -- keyword arm ---------------------------------------------------------------


def keyword_rank(entries: Mapping[str, Any], q: str) -> List[Tuple[str, str, float]]:
    """``(kind, key, score)`` best first; units sharing no word with ``q`` are left out.

    Each query word counts once, weighted by how rare it is across the units and
    by where it appears: the table name (3), a column name (2), any other text (1).
    """
    wanted = set(tokens(q))
    if not wanted:
        return []
    fields: List[Tuple[str, str, List[set]]] = []
    for name, entry in (entries.get("tables") or {}).items():
        fields.append(("table", name, [
            set(_name_tokens(name)),
            {t for c in (entry.get("columns") or {}) for t in _name_tokens(c)},
            set(tokens(table_text(name, entry))),
        ]))
    for term in entries.get("glossary") or []:
        key = str(term.get("term") or "")
        if key:
            fields.append(("term", key, [set(tokens(key)), set(), set(tokens(term_text(term)))]))
    count = len(fields) or 1
    df = {t: sum(1 for _k, _n, f in fields if t in f[0] or t in f[1] or t in f[2]) for t in wanted}
    scored = []
    for kind, key, (names, cols, text) in fields:
        score = 0.0
        for t in wanted:
            weight = 3 if t in names else 2 if t in cols else 1 if t in text else 0
            if weight:
                score += weight * math.log(1 + count / df[t])
        if score > 0:
            scored.append((kind, key, score))
    scored.sort(key=lambda s: (-s[2], s[0], s[1]))
    return scored[:_ARM_DEPTH]


def fuse(*arms: Sequence[Tuple[str, str]]) -> List[Tuple[str, str]]:
    """Reciprocal-rank fusion of ranked ``(kind, key)`` lists."""
    score: Dict[Tuple[str, str], float] = {}
    for arm in arms:
        for rank, item in enumerate(arm, start=1):
            score[item] = score.get(item, 0.0) + 1.0 / (_RRF_K + rank)
    return sorted(score, key=lambda item: (-score[item], item))


# -- storage -----------------------------------------------------------------


async def _vector_schema(conn: Any) -> Optional[str]:
    return await conn.fetchval(
        "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace "
        "WHERE e.extname = 'vector'"
    )


async def _has_embedding_column(conn: Any) -> bool:
    return bool(await conn.fetchval(
        "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' "
        "AND table_name = 'data_dictionary_index' AND column_name = 'embedding'"
    ))


def _quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


async def _add_embedding_column(conn: Any) -> None:
    schema = await _vector_schema(conn)
    if schema and not await _has_embedding_column(conn):
        # No fixed width: rows are compared only within one model (and width),
        # and a per-source dictionary is small enough to scan without an index.
        await conn.execute(
            "ALTER TABLE public.data_dictionary_index ADD COLUMN IF NOT EXISTS "
            f"embedding {_quote_ident(schema)}.vector"
        )


async def _ensure(conn: Any, db: Any) -> None:
    key = db.dsn
    if key in _ready:
        return
    names = ", ".join(f"to_regclass('public.{t}')" for t in _TABLES)
    present = await conn.fetchval(f"SELECT bool_and(r IS NOT NULL) FROM (VALUES ({names})) v(r)")
    may = await conn.fetchval("SELECT has_schema_privilege('public', 'CREATE')")
    if may and not getattr(conn, "_hermes_skip_setup", False):
        if not present:
            await conn.execute(DDL)
        await _add_embedding_column(conn)
    elif not present:
        raise ss.SiteError(
            "the dictionary search tables are missing and this database login cannot "
            "create them; run `hermes db migrate`",
            503,
        )
    _ready.add(key)


class _Conn(dd._Conn):
    async def __aenter__(self) -> Any:
        conn = await super().__aenter__()
        try:
            await _ensure(conn, self.db)
        except BaseException as exc:
            await self._cm.__aexit__(type(exc), exc, exc.__traceback__)
            raise
        return conn


async def migrate(conn: Any, *, app_role: Optional[str] = None) -> None:
    """``hermes db migrate`` step (schema owner): the search index and its grants.

    Without the pgvector extension the index still holds text, and search
    falls back to keywords.
    """
    from hermes_cli.access import APP_ROLE_NAME

    role = app_role or APP_ROLE_NAME
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", role):
        raise ValueError(f"invalid role name {role!r}")
    if not await _vector_schema(conn):
        try:
            async with conn.transaction():
                await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        except Exception as exc:  # noqa: BLE001 - keyword search still works
            logger.warning("pgvector unavailable; dictionary search will use keywords: %s", exc)
    await conn.execute(DDL)
    await _add_embedding_column(conn)
    if await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role):
        await conn.execute(
            f"GRANT USAGE ON SCHEMA public TO {role}; GRANT SELECT, INSERT, UPDATE, DELETE ON "
            + ", ".join(f"public.{t}" for t in _TABLES)
            + f" TO {role}"
        )


# -- embedder ----------------------------------------------------------------


def get_embedder() -> Any:
    """The live-memory embedder (``memory.embedding``), or None when misconfigured."""
    try:
        from hermes_cli.config import load_config_readonly
        from plugins.memory.supabase_pgvector.embedding import DEFAULT_DIM
        from plugins.memory.supabase_pgvector.embedding import get_embedder as memory_embedder

        return memory_embedder(DEFAULT_DIM, config=load_config_readonly() or {})
    except Exception:  # noqa: BLE001 - search falls back to keywords
        logger.warning("no embedder for dictionary search", exc_info=True)
        return None


def _model_key(embedder: Any) -> str:
    return f"{embedder.model_id}:{embedder.dim}" if embedder is not None else ""


def _literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(repr(float(v)) for v in vector) + "]"


async def _embed(embedder: Any, texts: List[str]) -> Optional[List[List[float]]]:
    """Vectors for ``texts``, or None as soon as the embedder fails."""
    out: List[List[float]] = []
    try:
        for start in range(0, len(texts), _EMBED_BATCH):
            out.extend(await asyncio.to_thread(embedder.embed_batch, texts[start:start + _EMBED_BATCH]))
    except Exception as exc:  # noqa: BLE001 - keyword search still works
        logger.warning("dictionary embedding failed; keyword search only: %s", exc)
        return None
    return out


# -- index -------------------------------------------------------------------


async def _approved(source: dd.Source, conn: Any) -> Optional[Mapping[str, Any]]:
    return await conn.fetchrow(
        "SELECT version, entries FROM public.data_dictionary_versions "
        "WHERE source_id = $1::uuid AND status = 'approved'",
        source.id,
    )


async def index_state(source: dd.Source, *, db: Any = None) -> Optional[Dict[str, Any]]:
    """The indexed version and model, and whether the index can hold vectors."""
    async with _Conn(db) as conn:
        row = await conn.fetchrow(
            "SELECT version, embedding_model FROM public.data_dictionary_index_state "
            "WHERE source_id = $1::uuid",
            source.id,
        )
        vectors = await _has_embedding_column(conn)
    return {**(dict(row) if row else {"version": None, "embedding_model": None}), "vectors": vectors}


async def reindex(source: dd.Source, *, db: Any = None, embedder: Any = "config") -> Dict[str, Any]:
    """Make the index match the approved version; embeds only what changed."""
    if embedder == "config":
        embedder = get_embedder()
    async with _Conn(db) as conn:
        approved = await _approved(source, conn)
        vectors_ok = await _has_embedding_column(conn) and embedder is not None
        existing = {
            (r["kind"], r["key"]): r
            for r in await conn.fetch(
                "SELECT kind, key, body_hash, embedding_model, "
                + ("embedding IS NOT NULL" if vectors_ok else "false")
                + " AS embedded FROM public.data_dictionary_index WHERE source_id = $1::uuid",
                source.id,
            )
        }
    version = approved["version"] if approved else None
    wanted = units(dd._json(approved["entries"]) or {}) if approved else []
    model = _model_key(embedder) if vectors_ok else ""
    todo = [
        u for u in wanted
        if (old := existing.get((u[0], u[1]))) is None
        or old["body_hash"] != _hash(u[2])
        or (model and (old["embedding_model"] != model or not old["embedded"]))
    ]
    vectors = await _embed(embedder, [u[2] for u in todo]) if model and todo else None
    if model and todo and vectors is None:
        model = ""
    keep = {(u[0], u[1]) for u in wanted}
    async with _Conn(db) as conn:
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", f"dd-index:{source.id}")
            gone = [k for k in existing if k not in keep]
            if gone:
                await conn.executemany(
                    "DELETE FROM public.data_dictionary_index "
                    "WHERE source_id = $1::uuid AND kind = $2 AND key = $3",
                    [(source.id, kind, key) for kind, key in gone],
                )
            if not model and vectors_ok:
                # One model per source: a failed embed leaves no mixed column.
                await conn.execute(
                    "UPDATE public.data_dictionary_index SET embedding = NULL, embedding_model = '' "
                    "WHERE source_id = $1::uuid",
                    source.id,
                )
            if todo:
                if vectors is not None:
                    schema = _quote_ident(await _vector_schema(conn))
                    await conn.executemany(
                        "INSERT INTO public.data_dictionary_index (source_id, kind, key, body, body_hash, "
                        f"embedding_model, embedding) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::{schema}.vector) "
                        "ON CONFLICT (source_id, kind, key) DO UPDATE SET body = EXCLUDED.body, "
                        "body_hash = EXCLUDED.body_hash, embedding_model = EXCLUDED.embedding_model, "
                        "embedding = EXCLUDED.embedding",
                        [(source.id, k, key, text, _hash(text), model, _literal(v))
                         for (k, key, text), v in zip(todo, vectors)],
                    )
                else:
                    await conn.executemany(
                        "INSERT INTO public.data_dictionary_index (source_id, kind, key, body, body_hash) "
                        "VALUES ($1::uuid, $2, $3, $4, $5) ON CONFLICT (source_id, kind, key) DO UPDATE "
                        "SET body = EXCLUDED.body, body_hash = EXCLUDED.body_hash",
                        [(source.id, k, key, text, _hash(text)) for k, key, text in todo],
                    )
            await conn.execute(
                "INSERT INTO public.data_dictionary_index_state (source_id, version, embedding_model, indexed_at) "
                "VALUES ($1::uuid, $2, $3, now()) ON CONFLICT (source_id) DO UPDATE SET "
                "version = EXCLUDED.version, embedding_model = EXCLUDED.embedding_model, indexed_at = now()",
                source.id, version, model,
            )
    return {"version": version, "embedding_model": model, "embedded": len(todo) if vectors else 0,
            "entries": len(wanted)}


async def reindex_quiet(source: dd.Source, *, db: Any = None) -> None:
    """Best-effort :func:`reindex` after a write — never fails the write itself."""
    try:
        await reindex(source, db=db)
    except Exception:  # noqa: BLE001
        logger.warning("dictionary re-index failed for source %s", source.id, exc_info=True)


async def _vector_rank(
    source: dd.Source, vector: Sequence[float], model: str, *, db: Any = None
) -> List[Tuple[str, str]]:
    async with _Conn(db) as conn:
        schema = _quote_ident(await _vector_schema(conn))
        rows = await conn.fetch(
            "SELECT kind, key FROM public.data_dictionary_index "
            "WHERE source_id = $1::uuid AND embedding_model = $2 AND embedding IS NOT NULL "
            f"ORDER BY embedding OPERATOR({schema}.<=>) $3::{schema}.vector, kind, key LIMIT {_ARM_DEPTH}",
            source.id, model, _literal(vector),
        )
    return [(r["kind"], r["key"]) for r in rows]


async def _semantic(
    source: dd.Source, version: int, q: str, *, db: Any, embedder: Any, vector: Any = None
) -> Tuple[List[Tuple[str, str]], str]:
    """Vector-arm ranking and the model used; ``([], "")`` when unavailable."""
    if embedder is None:
        return [], ""
    model = _model_key(embedder)
    state = await index_state(source, db=db)
    if not state["vectors"]:
        return [], ""
    if state["version"] != version or state["embedding_model"] != model:
        state = await reindex(source, db=db, embedder=embedder)
    if state.get("embedding_model") != model:
        return [], ""
    if vector is None:
        vectors = await _embed(embedder, [q])
        if not vectors:
            return [], ""
        vector = vectors[0]
    return await _vector_rank(source, vector, model, db=db), model


# -- search ------------------------------------------------------------------


def _short(text: Any) -> str:
    text = str(text or "")
    return text if len(text) <= _MEANING_CHARS else text[:_MEANING_CHARS - 1] + "…"


def _trim(entry: Mapping[str, Any], budget: int) -> Dict[str, Any]:
    """``entry`` with examples, then metrics and joins, dropped until it fits."""
    out = dict(entry)
    for key in ("examples", "metrics", "joins"):
        while out.get(key) and _size(out) > budget:
            out[key] = out[key][:-1]
    out["trimmed"] = True
    return out


def is_large(entries: Mapping[str, Any]) -> bool:
    return _size(entries) > FULL_BELOW_CHARS


def table_index(entries: Mapping[str, Any], budget: int = BUDGET_CHARS) -> Dict[str, Any]:
    """Every table's name and a short meaning (as many as fit), and the glossary terms."""
    tables, used = [], 0
    names = sorted(entries.get("tables") or {})
    for name in names:
        item = {"name": name, "meaning": _short((entries["tables"][name] or {}).get("meaning"))}
        used += _size(item)
        if used > budget:
            break
        tables.append(item)
    return {
        "tables": tables,
        "omitted": len(names) - len(tables),
        "glossary_terms": [t.get("term") for t in entries.get("glossary") or []][:200],
    }


async def search(
    source: dd.Source,
    entries: Mapping[str, Any],
    version: int,
    q: str,
    *,
    top_k: int = TOP_K,
    budget: int = BUDGET_CHARS,
    db: Any = None,
    embedder: Any = "config",
    vector: Any = None,
) -> Dict[str, Any]:
    """The approved entries most relevant to ``q``, within ``budget`` characters.

    Returns ``entries`` (``tables`` subset + matching ``glossary`` terms) and
    ``search`` (mode ``semantic`` or ``keyword``, the ranking, what was left out).
    """
    if embedder == "config":
        embedder = get_embedder()
    top_k = max(1, min(int(top_k or TOP_K), MAX_TOP_K))
    lexical = [(k, key) for k, key, _s in keyword_rank(entries, q)]
    try:
        semantic, model = await _semantic(source, version, q, db=db, embedder=embedder, vector=vector)
    except Exception:  # noqa: BLE001 - keyword search still answers
        logger.warning("semantic dictionary search failed for source %s", source.id, exc_info=True)
        semantic, model = [], ""
    ranked = fuse(semantic, lexical) if semantic else lexical
    tables = entries.get("tables") or {}
    glossary = {str(t.get("term")): t for t in entries.get("glossary") or []}
    picked: Dict[str, Any] = {}
    terms: List[Dict[str, Any]] = []
    more: List[str] = []
    used = 0
    for kind, key in ranked:
        if kind == "term":
            if key in glossary and len(terms) < top_k:
                terms.append(glossary[key])
                used += _size(glossary[key])
            continue
        if key not in tables:
            continue
        if len(picked) >= top_k:
            more.append(key)
            continue
        entry = tables[key]
        size = _size(entry)
        if used + size > budget:
            if picked:
                more.append(key)
                continue
            entry = _trim(entry, budget)
            size = _size(entry)
        picked[key] = entry
        used += size
    return {
        "entries": {"tables": picked, "glossary": terms},
        "search": {
            "q": q,
            "mode": "semantic" if semantic else "keyword",
            "model": model or None,
            "total_tables": len(tables),
            "returned": list(picked),
            "more": more[:MAX_TOP_K],
        },
    }


def full_or_index(entries: Mapping[str, Any]) -> Dict[str, Any]:
    """No question: small dictionaries whole, large ones as a table index."""
    if not is_large(entries):
        return {"entries": entries, "search": {"mode": "all", "total_tables": len(entries.get("tables") or {})}}
    return {"index": table_index(entries), "search": {
        "mode": "index", "total_tables": len(entries.get("tables") or {}), "large": True}}


async def lookup(
    source: dd.Source,
    approved: Optional[Mapping[str, Any]],
    *,
    q: Optional[str] = None,
    entity: Optional[str] = None,
    top_k: int = TOP_K,
    db: Any = None,
) -> Dict[str, Any]:
    """What the ``dictionary`` tool action returns for an approved version."""
    if approved is None:
        return {}
    entries = approved.get("entries") or {}
    if entity:
        entry = (entries.get("tables") or {}).get(str(entity))
        if entry is None:
            raise ss.SiteError(f"the dictionary has no entry for {entity!r}")
        return {"entries": {"tables": {str(entity): entry}, "glossary": []},
                "search": {"mode": "entity", "total_tables": len(entries.get("tables") or {})}}
    q = (q or "").strip()
    if not q or not is_large(entries):
        return full_or_index(entries)
    found = await search(source, entries, approved["version"], q, top_k=top_k, db=db)
    found["search"]["large"] = True
    if not found["entries"]["tables"]:
        found["index"] = table_index(entries)
    return found


async def search_all(
    principal: Any, profile: str, q: str, *, per_source: int = 3, db: Any = None
) -> List[Dict[str, Any]]:
    """Best matching tables in every source ``principal`` may read (names and meanings)."""
    q = (q or "").strip()
    if not q:
        raise ss.SiteError("give q= to search every source")
    readable = await dd.list_sources(principal, profile, db=db)
    embedder = get_embedder()
    vector = None
    if embedder is not None:
        vectors = await _embed(embedder, [q])
        vector = vectors[0] if vectors else None
        if vector is None:
            embedder = None
    out = []
    for item in readable:
        if not item.get("approved_version"):
            continue
        source = await dd.get_source(item["id"], db=db)
        if source is None:
            continue
        approved = (await dd.dictionary(source, db=db))["approved"]
        if approved is None:
            continue
        found = await search(source, approved["entries"], approved["version"], q, top_k=per_source,
                             db=db, embedder=embedder, vector=vector)
        hits = [{"name": n, "meaning": _short(approved["entries"]["tables"][n].get("meaning"))}
                for n in found["search"]["returned"]]
        if hits:
            out.append({"source": source.view(item["access"]), "version": approved["version"],
                        "mode": found["search"]["mode"], "tables": hits})
    return out


async def rank_tables(source: dd.Source, q: str, *, top_k: int = TOP_K, db: Any = None) -> List[str]:
    """Table names in ``source``'s approved dictionary ranked for ``q`` (``describe q=``)."""
    approved = (await dd.dictionary(source, db=db))["approved"]
    if approved is None or not (q or "").strip():
        return []
    found = await search(source, approved["entries"], approved["version"], q, top_k=top_k,
                         budget=10 ** 9, db=db)
    return found["search"]["returned"]
