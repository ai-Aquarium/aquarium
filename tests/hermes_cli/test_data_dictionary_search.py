"""Dictionary search without a database: text, keyword ranking, budgets, small vs large."""

from __future__ import annotations

import asyncio

import pytest

import hermes_cli.data_dictionary as dd
import hermes_cli.data_dictionary_search as dds

SOURCE = dd.Source(id="s1", kind="app", profile="default", name="Aquarium data")


def big_dictionary(n: int = 80) -> dict:
    tables = {
        f"table_{i:03d}": {
            "meaning": f"Filler records number {i} about warehouse logistics and pallets",
            "columns": {f"col_{j}": "an internal code kept for audits" for j in range(6)},
        }
        for i in range(n)
    }
    tables["refunds"] = {
        "meaning": "Money returned to a customer after a cancelled order",
        "row": "One refund", "grain": "refund",
        "columns": {"refund_amount": "HKD returned", "order_no": "the order refunded"},
        "joins": [{"to": "orders", "on": "refunds.order_no = orders.order_no"}],
        "metrics": [{"name": "refund rate", "definition": "refunds / orders"}],
        "examples": [{"question": "How much did we refund last month?", "sql": "SELECT 1"}],
    }
    tables["orders"] = {"meaning": "Orders placed in the shop", "columns": {"order_no": "id", "amount": "HKD"}}
    return {"tables": tables, "glossary": [{"term": "GMV", "definition": "gross merchandise value of orders"}]}


def run(coro):
    return asyncio.run(coro)


def test_table_text_covers_every_part_of_an_entry():
    text = dds.table_text("refunds", big_dictionary()["tables"]["refunds"])
    for part in ("Money returned", "refund_amount", "orders.order_no", "refund rate", "refund last month"):
        assert part in text
    kinds = {(k, key) for k, key, _t in dds.units(big_dictionary())}
    assert ("term", "GMV") in kinds and ("table", "refunds") in kinds


def test_keyword_rank_prefers_names_and_skips_unrelated():
    ranked = dds.keyword_rank(big_dictionary(), "refunds per order")
    assert ranked[0][:2] == ("table", "refunds")
    assert ("table", "orders") in [r[:2] for r in ranked]
    assert all(not key.startswith("table_") for _k, key, _s in ranked)
    assert dds.keyword_rank(big_dictionary(), "  ") == []
    assert dds.tokens("退款金額")[:2] == ["退", "款"] and "退款" in dds.tokens("退款金額")


def test_fuse_rewards_agreement():
    assert dds.fuse([("table", "a"), ("table", "b")], [("table", "b"), ("table", "c")])[0] == ("table", "b")


def test_small_dictionary_returns_everything():
    small = {"tables": {"todos": {"meaning": "m"}}, "glossary": []}
    for q in (None, "anything"):
        out = run(dds.lookup(SOURCE, {"version": 1, "entries": small}, q=q))
        assert out["entries"] == small and out["search"]["mode"] == "all"


def test_large_dictionary_without_q_returns_an_index():
    out = run(dds.lookup(SOURCE, {"version": 1, "entries": big_dictionary()}))
    assert "entries" not in out and out["search"]["mode"] == "index"
    names = [t["name"] for t in out["index"]["tables"]]
    assert "refunds" in names and out["index"]["glossary_terms"] == ["GMV"]
    assert dds._size(out) <= dds.BUDGET_CHARS + 2_000


def test_large_dictionary_search_keyword_fallback(monkeypatch):
    monkeypatch.setattr(dds, "get_embedder", lambda: None)
    out = run(dds.lookup(SOURCE, {"version": 1, "entries": big_dictionary()}, q="refund rate", top_k=2))
    assert out["search"]["mode"] == "keyword" and out["search"]["large"] is True
    assert list(out["entries"]["tables"])[0] == "refunds" and len(out["entries"]["tables"]) <= 2
    nothing = run(dds.lookup(SOURCE, {"version": 1, "entries": big_dictionary()}, q="zebra"))
    assert nothing["entries"]["tables"] == {} and nothing["index"]["tables"]


def test_entity_returns_one_entry_and_unknown_fails():
    out = run(dds.lookup(SOURCE, {"version": 1, "entries": big_dictionary()}, entity="orders"))
    assert list(out["entries"]["tables"]) == ["orders"]
    with pytest.raises(Exception, match="no entry"):
        run(dds.lookup(SOURCE, {"version": 1, "entries": big_dictionary()}, entity="nope"))


def test_search_respects_budget_and_top_k():
    entries = big_dictionary()
    out = run(dds.search(SOURCE, entries, 1, "warehouse pallets audits", top_k=50, budget=3_000, embedder=None))
    assert len(out["entries"]["tables"]) <= dds.MAX_TOP_K
    assert dds._size(out["entries"]["tables"]) <= 3_000 and out["search"]["more"]
    huge = {"meaning": "refunds " + "x" * 500, "examples": [{"question": "q" * 900, "sql": "s"}] * 20}
    out = run(dds.search(SOURCE, {"tables": {"refunds": huge}}, 1, "refunds", budget=2_000, embedder=None))
    assert out["entries"]["tables"]["refunds"]["trimmed"] is True
    assert dds._size(out["entries"]["tables"]["refunds"]) <= 2_000


def test_failing_embedder_falls_back_to_keywords(monkeypatch):
    class Broken:
        dim, model_id = 8, "broken"

        def embed_batch(self, texts):
            raise ConnectionError("embedding service down")

    async def state(*_a, **_kw):
        return {"version": 1, "embedding_model": "broken:8", "vectors": True}

    monkeypatch.setattr(dds, "index_state", state)
    out = run(dds.search(SOURCE, big_dictionary(), 1, "refund", embedder=Broken()))
    assert out["search"]["mode"] == "keyword" and "refunds" in out["entries"]["tables"]


def test_oversized_entries_and_glossary_stay_within_budget():
    wide = {"meaning": "refunds " + "m" * 400,
            "columns": {f"c{i}": "d" * 345 for i in range(300)}}
    out = run(dds.search(SOURCE, {"tables": {"refunds": wide}}, 1, "refunds", embedder=None))
    entry = out["entries"]["tables"]["refunds"]
    assert entry["trimmed"] is True and dds._size(entry) <= dds.BUDGET_CHARS
    terms = [{"term": f"refund {i}", "definition": "refund " + "x" * 990} for i in range(20)]
    out = run(dds.search(SOURCE, {"tables": {}, "glossary": terms}, 1, "refund", top_k=20, embedder=None))
    assert out["entries"]["glossary"] and dds._size(out["entries"]) <= dds.BUDGET_CHARS + 100


def test_keyword_search_reads_past_the_embedding_cut():
    entry = {"meaning": "Orders", "columns": {f"c{i}": "z" * 345 for i in range(40)},
             "metrics": [{"name": "chargeback", "definition": "disputed orders"}]}
    assert len(dds.table_text("orders", entry)) > dds.EMBED_CHARS
    assert dds.keyword_rank({"tables": {"orders": entry}}, "chargeback")[0][1] == "orders"
    assert all(len(text) <= dds.EMBED_CHARS for _k, _key, text in dds.units({"tables": {"orders": entry}}))
