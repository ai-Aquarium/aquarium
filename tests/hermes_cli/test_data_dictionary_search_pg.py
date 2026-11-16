"""Dictionary search against real Postgres + pgvector: index lifecycle, semantic
ranking, keyword fallback and source access.

Needs ``HERMES_TEST_SITE_PG_DSN`` (a disposable superuser address with the
pgvector extension available); skipped otherwise.
"""

from __future__ import annotations

import asyncio
import uuid

import pytest

import hermes_cli.data_dictionary as dd
import hermes_cli.data_dictionary_search as dds
import hermes_cli.site_sources as ss
from plugins.memory.supabase_pgvector.embedding import HashingEmbedder
from tests.hermes_cli.test_data_dictionary_pg import ALICE, BOB, BOSS, DESIGN, DSN, env  # noqa: F401
from tests.hermes_cli.test_data_dictionary_search import big_dictionary

pytestmark = pytest.mark.skipif(not DSN, reason="HERMES_TEST_SITE_PG_DSN not set")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def search_env(env, monkeypatch):  # noqa: F811
    monkeypatch.setattr(dds, "_ready", set())
    embedder = HashingEmbedder(64)
    monkeypatch.setattr(dds, "get_embedder", lambda: embedder)

    async def vector():
        import asyncpg

        conn = await asyncpg.connect(DSN)
        try:
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
            await dds.migrate(conn)
        finally:
            await conn.close()

    run(vector())
    return env


def app_source(profile):
    return next(s for s in run(dd.sync_sources(profile)) if s.kind == "app")


def approve_big(source):
    entries = big_dictionary(40)
    draft = run(dd.propose(source, tables=entries["tables"], glossary=entries["glossary"], by="boss"))
    run(dd.approve(source, draft["version"], by="boss"))
    return draft["version"]


async def rows(source):
    async with dds._Conn() as conn:
        return {
            (r["kind"], r["key"]): r
            for r in await conn.fetch(
                "SELECT kind, key, embedding_model, embedding IS NOT NULL AS has_vec "
                "FROM public.data_dictionary_index WHERE source_id = $1::uuid",
                source.id,
            )
        }


def test_approve_indexes_and_search_is_semantic(search_env):
    profile, _site = search_env
    app = app_source(profile)
    version = approve_big(app)
    indexed = run(rows(app))
    assert len(indexed) == 43 and all(r["has_vec"] and r["embedding_model"] == "hashing:64"
                                      for r in indexed.values())
    assert run(dds.index_state(app))["version"] == version
    approved = run(dd.dictionary(app))["approved"]
    out = run(dds.lookup(app, approved, q="refund rate for cancelled orders", top_k=3))
    assert out["search"]["mode"] == "semantic" and "refunds" in out["entries"]["tables"]
    assert len(out["entries"]["tables"]) <= 3


def test_edits_reembed_only_changes_and_restore_reindexes(search_env):
    profile, _site = search_env
    app = app_source(profile)
    first = approve_big(app)
    draft = run(dd.propose(app, tables={"refunds": {"meaning": "Chargebacks from the bank"}},
                           remove=["table_000"], by="boss"))
    run(dd.approve(app, draft["version"], by="boss"))
    indexed = run(rows(app))
    assert ("table", "table_000") not in indexed and ("table", "refunds") in indexed
    redo = run(dds.reindex(app))
    assert redo["embedded"] == 0 and redo["version"] == draft["version"]
    restored = run(dd.restore(app, first, by="boss"))
    assert run(dds.index_state(app))["version"] == restored["version"]
    assert ("table", "table_000") in run(rows(app))


def test_stale_index_or_new_model_rebuilds_on_search(search_env, monkeypatch):
    profile, _site = search_env
    app = app_source(profile)
    approve_big(app)
    other = HashingEmbedder(32)
    monkeypatch.setattr(dds, "get_embedder", lambda: other)
    approved = run(dd.dictionary(app))["approved"]
    out = run(dds.lookup(app, approved, q="refund"))
    assert out["search"]["model"] == "hashing:32"
    assert {r["embedding_model"] for r in run(rows(app)).values()} == {"hashing:32"}


def test_no_embedder_means_keyword_search(search_env, monkeypatch):
    profile, _site = search_env
    app = app_source(profile)
    monkeypatch.setattr(dds, "get_embedder", lambda: None)
    approve_big(app)
    assert not any(r["has_vec"] for r in run(rows(app)).values())
    approved = run(dd.dictionary(app))["approved"]
    out = run(dds.lookup(app, approved, q="refund"))
    assert out["search"]["mode"] == "keyword" and "refunds" in out["entries"]["tables"]


def test_search_all_only_reads_shared_sources(search_env):
    profile, site = search_env
    run(ss.apply_design(site, run(ss.propose_design(site, DESIGN, None, by="alice"))["version"],
                        approved_by="alice"))
    approve_big(app_source(profile))
    boss = run(dds.search_all(BOSS, profile, "refund orders"))
    assert {m["source"]["kind"] for m in boss} == {"app", "site"}
    alice = run(dds.search_all(ALICE, profile, "refund orders"))
    assert {m["source"]["kind"] for m in alice} == {"site"}
    assert run(dds.search_all(BOB, profile, "refund orders")) == []


def test_text_changed_without_embedder_is_reembedded_later(search_env, monkeypatch):
    profile, _site = search_env
    app = app_source(profile)
    approve_big(app)
    before = run(rows(app))[("table", "refunds")]
    assert before["has_vec"]
    monkeypatch.setattr(dds, "get_embedder", lambda: None)
    draft = run(dd.propose(app, tables={"refunds": {"meaning": "Chargebacks from the bank"}}, by="boss"))
    run(dd.approve(app, draft["version"], by="boss"))
    after = run(rows(app))[("table", "refunds")]
    assert not after["has_vec"] and after["embedding_model"] == ""
    redo = run(dds.reindex(app, embedder=HashingEmbedder(64)))
    assert redo["embedded"] >= 1 and run(rows(app))[("table", "refunds")]["has_vec"]


def test_overlapping_reindexes_end_on_the_approved_version(search_env):
    import time

    profile, _site = search_env
    app = app_source(profile)
    first = approve_big(app)

    class Slow(HashingEmbedder):
        def embed_batch(self, texts):
            time.sleep(0.3)
            return super().embed_batch(texts)

    async def go():
        draft = await dd.propose(app, tables={"refunds": {"meaning": "Chargebacks"}}, by="boss")
        await dd.approve(app, draft["version"], by="boss")
        await asyncio.gather(
            dds.reindex(app, embedder=Slow(64)),
            dd.restore(app, first, by="boss"),
            dds.reindex(app, embedder=Slow(64)),
        )
        approved = (await dd.dictionary(app))["approved"]
        async with dds._Conn() as conn:
            body = await conn.fetchval(
                "SELECT body FROM public.data_dictionary_index "
                "WHERE source_id = $1::uuid AND kind = 'table' AND key = 'refunds'", app.id)
        return approved, body, await dds.index_state(app)

    approved, body, state = run(go())
    assert state["version"] == approved["version"]
    assert body == dds.table_text("refunds", approved["entries"]["tables"]["refunds"])[:dds.EMBED_CHARS]
