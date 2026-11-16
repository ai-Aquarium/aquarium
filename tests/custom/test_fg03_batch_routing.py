"""FG-03 P4: batches carry their source and are routed once before triage.

The batchers stamp each batch file with the registry ``source_id`` and
``owner_user_id`` and never put two sources in one batch. The email and
WhatsApp triage scripts then make one routing call per batch from a registry
source: ``shadow`` only logs, ``enforce`` stores (without the LLM triage) a
batch that no user-profile picked, and no decision at all means triage as
usual. These tests exec the real scripts with their deployment roots pointed
at a temp dir and stub the router at its interface.
"""

import importlib.util
import json
import sqlite3
import sys
import types
from pathlib import Path

import pytest

from hermes_cli import triage_router
from hermes_cli.triage_batch_text import MAX_BYTES, batch_text
from hermes_cli.triage_router import RouteChoice, RoutingDecision
from tests.custom.test_wa_batcher_timestamp import (  # noqa: F401
    _bridge_message,
    batcher,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
EMAIL_BATCHER = REPO_ROOT / "custom" / "email" / "email_batcher.py"
EMAIL_TRIAGE = REPO_ROOT / "custom" / "email" / "email_triage_agent.py"
WA_TRIAGE = REPO_ROOT / "custom" / "whatsapp" / "triage_agent.py"
SOURCE = "11111111-1111-1111-1111-111111111111"
OTHER_SOURCE = "22222222-2222-2222-2222-222222222222"


def _exec(path, replace, name):
    source = path.read_text()
    for old, new in replace.items():
        source = source.replace(old, new)
    spec = importlib.util.spec_from_loader(name, loader=None)
    module = importlib.util.module_from_spec(spec)
    module.__file__ = str(path)
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


# --- batchers ---------------------------------------------------------------

@pytest.fixture
def email_batcher(tmp_path):
    spec = importlib.util.spec_from_file_location("_fg03_email_batcher", EMAIL_BATCHER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.BATCH_DIR = str(tmp_path)
    return module


def _email(id_, sender="ann@example.com", source=SOURCE, owner="u-john", thread=None):
    return {
        "id": id_, "account_id": "john@example.com", "from_addr": sender,
        "from_name": "Ann", "subject": f"s{id_}", "body_text": "hello",
        "thread_id": thread, "received_at": "2026-11-16T00:00:00+00:00",
        "source_id": source, "owner_user_id": owner,
    }


def test_email_batch_file_carries_its_source(email_batcher, tmp_path):
    path = email_batcher.write_batch("k", [_email("1")], "b1")
    batch = json.loads(Path(path).read_text())
    assert batch["source_id"] == SOURCE
    assert batch["owner_user_id"] == "u-john"


def test_email_batches_never_mix_sources(email_batcher):
    groups = email_batcher.group_emails([
        _email("1", thread="t1"),
        _email("2", source=OTHER_SOURCE, owner="u-mary", thread="t1"),
        _email("3", thread="t1", sender="bob@example.com"),
        _email("4", source=None, owner=None),
    ])
    for emails in groups.values():
        assert len({(e["source_id"], e["owner_user_id"]) for e in emails}) == 1
    by_id = {e["id"]: key for key, emails in groups.items() for e in emails}
    assert by_id["1"] == by_id["3"]  # same thread, same source: one batch
    assert len({by_id["1"], by_id["2"], by_id["4"]}) == 3


def test_whatsapp_batch_file_carries_its_source(batcher):  # noqa: F811
    module, _ = batcher
    module.process_message(_bridge_message("M1", "111", 1790766220), "phone2",
                           owner_user_id="u-john", source_id=SOURCE)
    [key] = list(module._pending_batches)
    batch_id = module._pending_batches[key]["batch_id"]
    module._pending_batches[key]["timer"].cancel()
    module.flush_batch(key)
    batch = json.loads(Path(module.BATCH_OUTPUT_DIR, f"{batch_id}.json").read_text())
    assert batch["source_id"] == SOURCE
    assert batch["owner_user_id"] == "u-john"
    assert [m["msg_id"] for m in batch["messages"]] == ["M1"]


def test_whatsapp_batches_never_mix_sources(batcher):  # noqa: F811
    module, _ = batcher
    module.process_message(_bridge_message("M1", "111", 1790766220), "phone2",
                           owner_user_id="u-john", source_id=SOURCE)
    module.process_message(_bridge_message("M2", "111", 1790766221), "phone2",
                           owner_user_id="u-mary", source_id=OTHER_SOURCE)
    module.process_message(_bridge_message("M3", "111", 1790766222), "phone2",
                           owner_user_id="u-john", source_id=SOURCE)
    pending = {b["source_id"]: [m["msg_id"] for m in b["messages"]]
               for b in module._pending_batches.values()}
    assert pending == {SOURCE: ["M1", "M3"], OTHER_SOURCE: ["M2"]}


# --- batch_text ---------------------------------------------------------------

def test_batch_text_is_compact_and_deterministic():
    email = {"sender": "ann@example.com", "sender_name": "Ann",
             "emails": [{"from_addr": "ann@example.com", "from_name": "Ann",
                         "subject": "Q3   budget", "has_attachments": 1,
                         "body_text": "Please\n\nreview " + "x" * 2000}]}
    text = batch_text("email", email)
    assert text == batch_text("email", json.loads(json.dumps(email)))
    assert "Ann <ann@example.com>" in text
    assert "Subject: Q3 budget [attachments]" in text
    assert "Please review" in text and "x" * 2000 not in text

    wa = {"sender_phone": "+85211112222",
          "messages": [{"text": "Are we on for Friday?", "sender_name": "Bob"},
                       {"text": "", "media_type": "image"}]}
    text = batch_text("whatsapp", wa)
    assert "Bob <+85211112222>" in text
    assert "- Are we on for Friday?" in text and "- [image]" in text


def test_batch_text_is_capped():
    wa = {"sender_phone": "+1", "messages": [{"text": "汉字 " * 200}] * 50}
    text = batch_text("whatsapp", wa)
    assert len(text.encode("utf-8")) <= MAX_BYTES
    assert text.endswith("[truncated]")
    with pytest.raises(ValueError):
        batch_text("calendar", {})


# --- routing before triage ------------------------------------------------------

@pytest.fixture
def credit(monkeypatch):
    stub = types.ModuleType("track_credit_helper")
    stub.__dict__["track_inference"] = lambda *args, **kwargs: None
    monkeypatch.setitem(sys.modules, "track_credit_helper", stub)


@pytest.fixture
def email_triage(tmp_path, monkeypatch, credit):
    root = tmp_path / "email-messages"
    root.mkdir()
    (root / "config.json").write_text("{}")
    monkeypatch.setenv("MESSAGING_DB_PATH", str(tmp_path / "none" / "messaging.db"))
    module = _exec(EMAIL_TRIAGE, {"/opt/data/email-messages": str(root)}, "_fg03_email_triage")
    monkeypatch.setitem(sys.modules, "contact_manager", None)  # skip contact upkeep
    return module


@pytest.fixture
def wa_triage(tmp_path, credit):
    root = tmp_path / "whatsapp-messages"
    root.mkdir()
    (root / "config.json").write_text("{}")
    return _exec(WA_TRIAGE, {"/opt/data/whatsapp-messages": str(root)}, "_fg03_wa_triage")


class Pipeline:
    """One triage script behind a common face, with LLM triage recorded."""

    def __init__(self, kind, module, monkeypatch):
        self.kind, self.module = kind, module
        self.triaged, self.stored = [], []
        result = {"classification": "informational", "tasks": [], "notes": []}
        if kind == "email":
            self.batch_dir, self.processed = module.EMAIL_BATCH_DIR, module.EMAIL_PROCESSED_DIR
            monkeypatch.setattr(module, "triage_email_batch",
                                lambda b: self.triaged.append(b["batch_id"]) or result)
            monkeypatch.setattr(module, "process_email_triage_result",
                                lambda b, r: self.stored.append(b["batch_id"]))
        else:
            self.batch_dir, self.processed = module.BATCH_DIR, module.PROCESSED_DIR
            monkeypatch.setattr(module, "triage_batch",
                                lambda b: self.triaged.append(b["batch_id"]) or result)
            monkeypatch.setattr(module, "process_triage_result",
                                lambda b, r: self.stored.append(b["batch_id"]))

    def write(self, batch_id, source_id=SOURCE, sender=None):
        if self.kind == "email":
            batch = {"batch_id": batch_id, "channel": "email", "account_id": "john@example.com",
                     "source_id": source_id, "owner_user_id": "u-john",
                     "sender": sender or "ann@example.com", "sender_name": "Ann",
                     "email_count": 1,
                     "emails": [{"id": "e1", "from_addr": sender or "ann@example.com",
                                 "subject": "Budget", "body_text": "Please review"}]}
        else:
            batch = {"batch_id": batch_id, "sender_phone": "+85211112222",
                     "source_phone": "phone2", "source_id": source_id,
                     "owner_user_id": "u-john", "message_count": 1,
                     "messages": [{"msg_id": "m1", "text": "Are we on for Friday?",
                                   "chat_id": "111@lid", "is_group": False}]}
        path = Path(self.batch_dir) / f"{batch_id}.json"
        path.write_text(json.dumps(batch))
        return path

    def run(self, path):
        if self.kind == "email":
            self.module.process_email_batch_file(str(path))
        else:
            self.module.process_batch_file(str(path))

    def done(self, path):
        return Path(self.processed, path.name).exists() and not path.exists()


@pytest.fixture(params=["email", "whatsapp"])
def pipeline(request, monkeypatch):
    module = request.getfixturevalue("email_triage" if request.param == "email" else "wa_triage")
    return Pipeline(request.param, module, monkeypatch)


@pytest.fixture
def router(monkeypatch):
    """Stub the router interface; ``state.decision`` is what the next call returns."""
    state = types.SimpleNamespace(mode="shadow", decision=None, calls=[])

    def route_batch_sync(**kwargs):
        state.calls.append(kwargs)
        return state.decision

    monkeypatch.setattr(triage_router, "router_settings", lambda config=None: {"mode": state.mode})
    monkeypatch.setattr(triage_router, "route_batch_sync", route_batch_sync)
    monkeypatch.setattr("shared.batch_routing._hermes_config", lambda: {})
    return state


def _decision(*picked, fallback=False):
    choices = tuple(RouteChoice(profile=p, selected=p in picked, reason=f"{p} reason")
                    for p in ("cfo", "cmo"))
    return RoutingDecision(batch_id="b", source_id=SOURCE, channel="email",
                           owner_user_id="u-john", choices=choices, fallback=fallback)


def test_shadow_routes_once_and_triages_as_before(pipeline, router, capsys):
    router.decision = _decision()
    path = pipeline.write("b1")
    pipeline.run(path)
    assert len(router.calls) == 1
    call = router.calls[0]
    assert (call["source_id"], call["batch_id"]) == (SOURCE, "b1")
    assert call["batch_text"] == batch_text(pipeline.kind, json.loads(
        Path(pipeline.processed, path.name).read_text()))
    assert pipeline.triaged == ["b1"] and pipeline.stored == ["b1"]
    assert pipeline.done(path)
    assert "router (shadow)" in capsys.readouterr().out


def test_enforce_with_no_pick_stores_without_llm_triage(pipeline, router):
    router.mode, router.decision = "enforce", _decision()
    path = pipeline.write("b2")
    pipeline.run(path)
    assert len(router.calls) == 1
    assert pipeline.triaged == [] and pipeline.stored == []
    assert pipeline.done(path)
    assert json.loads(Path(pipeline.processed, path.name).read_text())["batch_id"] == "b2"


@pytest.mark.parametrize("decision", [_decision("cfo"), _decision("cfo", "cmo", fallback=True)])
def test_enforce_with_a_pick_triages(pipeline, router, decision):
    router.mode, router.decision = "enforce", decision
    path = pipeline.write("b3")
    pipeline.run(path)
    assert len(router.calls) == 1
    assert pipeline.triaged == ["b3"] and pipeline.done(path)


@pytest.mark.parametrize("mode", ["shadow", "enforce"])
def test_no_decision_falls_through_to_triage(pipeline, router, mode):
    router.mode, router.decision = mode, None
    path = pipeline.write("b4")
    pipeline.run(path)
    assert len(router.calls) == 1
    assert pipeline.triaged == ["b4"] and pipeline.done(path)


def test_router_errors_fall_through_to_triage(pipeline, router, monkeypatch):
    router.mode = "enforce"
    monkeypatch.setattr(triage_router, "router_settings",
                        lambda config=None: (_ for _ in ()).throw(RuntimeError("db down")))
    path = pipeline.write("b5")
    pipeline.run(path)
    assert pipeline.triaged == ["b5"] and pipeline.done(path)


def test_off_or_unsourced_batches_skip_the_router(pipeline, router):
    router.mode, router.decision = "off", _decision()
    pipeline.run(pipeline.write("b6"))
    router.mode = "enforce"
    pipeline.run(pipeline.write("b7", source_id=None))
    assert router.calls == []
    assert pipeline.triaged == ["b6", "b7"]


def test_retried_batch_routes_once_per_attempt(pipeline, router, monkeypatch):
    router.decision = _decision("cfo")
    path = pipeline.write("b8")
    name = "triage_email_batch" if pipeline.kind == "email" else "triage_batch"
    monkeypatch.setattr(pipeline.module, name, lambda b: None)  # LLM down: retried later
    pipeline.run(path)
    assert path.exists() and len(router.calls) == 1


def test_email_newsletter_shortcut_makes_no_router_call(email_triage, router, monkeypatch):
    pipe = Pipeline("email", email_triage, monkeypatch)
    router.mode = "enforce"
    path = pipe.write("b9", sender="noreply@shop.example")
    batch = json.loads(path.read_text())
    batch["emails"][0]["body_text"] = "Sale! unsubscribe here"
    path.write_text(json.dumps(batch))
    pipe.run(path)
    assert router.calls == [] and pipe.triaged == [] and pipe.stored == ["b9"]
    assert pipe.done(path)


def test_whatsapp_media_only_batch_makes_no_router_call(wa_triage, router, monkeypatch):
    pipe = Pipeline("whatsapp", wa_triage, monkeypatch)
    path = pipe.write("b10")
    batch = json.loads(path.read_text())
    batch["messages"][0]["text"] = ""
    path.write_text(json.dumps(batch))
    pipe.run(path)
    assert router.calls == [] and pipe.triaged == [] and pipe.stored == ["b10"]
