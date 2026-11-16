"""FG-03 P6 (B): Telegram as a triage kind, and the Telegram triage script.

Router, profile agents and handlers are stubbed at their interfaces here; the
real-path version is ``test_fg03_telegram_triage_e2e``.
"""

import json
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

from hermes_cli import needs_you, telegram_triage, todo_outbound  # noqa: E402
from hermes_cli import triage_agent, triage_skills  # noqa: E402
from hermes_cli.triage_batch_text import batch_text  # noqa: E402
from shared import triage_handlers as handlers  # noqa: E402
from tests.custom.test_fg03_batch_routing import _decision, _exec, credit, router  # noqa: E402,F401
from tests.custom.test_fg03_profile_triage import agents  # noqa: E402,F401

TG_TRIAGE = ROOT / "custom" / "telegram" / "triage_agent.py"
AGENT_ON = {"triage": {"agent": {"telegram": "agent"}}}


def _batch(chat_type="group", **extra):
    batch = {
        "batch_id": telegram_triage.batch_id_for("42", "-100", "7"),
        "channel": "telegram", "source_id": "src-1", "owner_user_id": "u-john",
        "account_id": "tgbot:42", "chat_id": "-100", "chat_type": chat_type,
        "chat_title": "Suppliers", "created_at": "2026-11-16T08:00:00Z",
        "messages": [
            {"message_id": "7", "sender_id": "9", "sender_name": "Ann",
             "sender_username": "@ann", "text": "Invoice due", "timestamp": "t1", "media": []},
            {"message_id": "8", "sender_id": "10", "sender_name": "", "sender_username": "",
             "text": "", "timestamp": "t2", "media": [{"type": "photo"}]},
        ],
    }
    batch.update(extra)
    return batch


# -- the telegram kind -------------------------------------------------------------

def test_batch_text_group_names_each_sender():
    text = batch_text("telegram", _batch())
    assert text.splitlines() == ["Telegram group batch: 2 message(s) in Suppliers",
                                 "- Ann <@ann>: Invoice due", "- 10: [photo]"]
    assert batch_text("telegram", _batch()) == text


def test_batch_text_dm_names_the_sender_once():
    text = batch_text("telegram", _batch("dm"))
    assert text.splitlines()[0] == "Telegram batch: 2 message(s) from Ann <@ann>"
    assert "- Invoice due" in text.splitlines()


def test_telegram_is_a_skills_kind_with_builtin_files_and_care():
    assert triage_skills.CHANNEL_KINDS["telegram"] == "telegram"
    assert triage_skills.validate_kind("telegram") == "telegram"
    keys = {key for key, _ in triage_skills.builtin_files("telegram")}
    assert {"telegram-triage/SKILL.md", "telegram-triage/response-schema.md"} <= keys
    assert triage_skills._builtin_care("telegram").startswith("Telegram messages")


def test_agent_prompt_renders_the_batch_last(tmp_path):
    prompt = triage_agent.build_triage_prompt("telegram", _batch(), home=tmp_path, owner_user_id="u-john")
    assert "You are a Telegram message triage agent" in prompt
    tail = prompt[prompt.index("Triage this message batch:"):]
    assert "Chat: Suppliers (group)" in tail and "Receiving Bot: tgbot:42" in tail
    assert "Ann (@ann): Invoice due" in tail and "10: [media]" in tail
    assert triage_agent.session_id_for("telegram", "tg_1", "cfo") == "triage_telegram_tg_1_cfo"


# -- arrivals carry the reply route -------------------------------------------------

def test_arrivals_carry_bot_chat_and_message():
    batch = {**_batch(), "_channel": "telegram"}
    arrivals = handlers._triaged_arrivals(batch)
    assert arrivals == [("telegram", "tgbot:42", "-100:7"), ("telegram", "tgbot:42", "-100:8")]
    fields = handlers._arrival_fields(batch, arrivals[1])
    assert fields["conversation"] == "-100" and fields["has_attachments"] is True
    item = {"surface": "telegram", "account_id": "tgbot:42", **fields}
    assert todo_outbound.target_from_arrival(item) == {
        "channel": "telegram", "target": "-100", "account_id": "tgbot:42"}


def test_telegram_never_writes_box_channel_rows(monkeypatch):
    calls = []
    monkeypatch.setattr(handlers, "_dispatch",
                        lambda result, batch, db, box_writes: calls.append(box_writes))
    monkeypatch.setattr(handlers, "stamp_inbox_importance", lambda *a, **k: None)
    handlers.process_result({"tasks": []}, {**_batch(), "_channel": "telegram"}, None)
    assert calls == [False]


def test_failed_notice_is_a_review_entry(monkeypatch):
    note = types.SimpleNamespace(status="pending", dedupe_key="triage-failed:telegram:tg_1",
                                 kind="proactive_ask", reversible=False, id="n1",
                                 title="t", body="b", created_at=None, owner_user_id="u-john",
                                 target_user_id="u-john", command=None, visibility="private")
    monkeypatch.setattr("hermes_cli.human_comms.notification_target_user", lambda n: "u-john")
    [entry] = needs_you.notification_entries([note], "u-john")
    assert entry["severity"] == "review" and entry["href"] == "/inbox"


# -- the script ---------------------------------------------------------------------

@pytest.fixture
def telegram(tmp_path, monkeypatch, router, agents):  # noqa: F811
    module = _exec(TG_TRIAGE, {}, "_fg03p6_tg_unit")
    batch_dir, processed = tmp_path / "batches", tmp_path / "processed"
    batch_dir.mkdir()
    module.BATCH_DIR, module.PROCESSED_DIR = str(batch_dir), str(processed)
    notices = []
    monkeypatch.setattr("shared.profile_triage._notify_untriaged",
                        lambda kind, batch, profiles, owner, log:
                        notices.append((kind, batch["batch_id"], list(profiles), owner)) or True)
    state = types.SimpleNamespace(module=module, processed=processed, notices=notices,
                                  router=router, agents=agents)

    def write(**extra):
        return telegram_triage.write_batch(_batch(**extra), batch_dir=batch_dir)

    def done(path):
        return (processed / path.name).exists() and not path.exists()

    state.write, state.done = write, done
    return state


@pytest.mark.parametrize("config", [{}, {"triage": {"agent": {"telegram": "off"}}},
                                    {"triage": {"agent": {"telegram": "legacy"}}}])
def test_off_leaves_files_untouched(telegram, config):
    path = telegram.write()
    before = path.read_bytes()
    assert telegram.module.run_pass(config) == 0
    assert telegram.module.process_batch_file(str(path), config) is False
    assert path.read_bytes() == before and telegram.router.calls == []


def test_routes_once_and_acts_per_picked_profile(telegram):
    telegram.router.mode, telegram.router.decision = "enforce", _decision("cfo", "cmo")
    path = telegram.write()
    assert telegram.module.run_pass(AGENT_ON) == 1
    assert telegram.done(path) and len(telegram.router.calls) == 1
    assert telegram.router.calls[0]["batch_text"].startswith("Telegram group batch")
    assert telegram.agents.runs == [["cfo", "cmo"]]
    assert [(home, owner, box, ch) for home, owner, box, ch in telegram.agents.acted] == [
        ("/homes/cfo", "u-john", True, "telegram"), ("/homes/cmo", "u-john", False, "telegram")]
    assert telegram.notices == []


def test_no_pick_is_stored_only(telegram):
    telegram.router.mode, telegram.router.decision = "enforce", _decision()
    path = telegram.write()
    telegram.module.run_pass(AGENT_ON)
    assert telegram.done(path) and telegram.agents.runs == [] and telegram.notices == []


@pytest.mark.parametrize("mode", ["off", "enforce"])
def test_no_decision_waits_then_stores_and_notifies(telegram, mode):
    telegram.router.mode, telegram.router.decision = mode, None
    path = telegram.write()
    for attempt in (1, 2):
        telegram.module.run_pass(AGENT_ON)
        assert not telegram.done(path)
        assert json.loads(path.read_text())["_agent_attempts"] == attempt
    telegram.module.run_pass(AGENT_ON)
    assert telegram.done(path) and telegram.agents.runs == []
    assert telegram.notices == [("telegram", _batch()["batch_id"], [], "u-john")]


def test_failed_profile_retries_then_cap_stores_and_notifies_once(telegram):
    telegram.router.mode, telegram.router.decision = "enforce", _decision("cfo", "cmo")
    telegram.agents.failing = {"cmo"}
    path = telegram.write()
    for _ in range(3):
        telegram.module.run_pass(AGENT_ON)
    assert telegram.done(path)
    assert telegram.agents.runs == [["cfo", "cmo"], ["cmo"], ["cmo"]]
    assert telegram.notices == [("telegram", _batch()["batch_id"], ["cmo"], "u-john")]
    assert telegram.module.run_pass(AGENT_ON) == 0 and len(telegram.notices) == 1
