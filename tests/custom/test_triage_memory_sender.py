"""memory_facts records who said it, on every channel (Telegram included)."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "custom"))

from shared import memory_bridge, triage_handlers  # noqa: E402

FACTS = [{"fact": "Ann bills on the 1st", "category": "vendor"}]


@pytest.fixture
def remembered(monkeypatch):
    calls = []
    monkeypatch.setattr(memory_bridge, "remember_facts",
                        lambda facts, *, source, sender, memory_dir=None: calls.append((source, sender)) or 1)
    return calls


@pytest.mark.parametrize("first, sender", [
    ({"sender_username": "ann", "sender_name": "Ann", "sender_id": "9001"}, "@ann"),
    ({"sender_username": "", "sender_name": "Ann", "sender_id": "9001"}, "Ann"),
    ({"sender_id": 9001}, "9001"),
])
def test_telegram_facts_name_the_first_sender(remembered, first, sender):
    batch = {"_channel": "telegram", "messages": [first, {"sender_username": "bob"}]}
    triage_handlers._handle_memory_facts(FACTS, batch, None)
    assert remembered == [("telegram", sender)]


@pytest.mark.parametrize("batch, sender", [
    ({"_channel": "whatsapp", "sender_phone": "85290000000"}, "85290000000"),
    ({"_channel": "email", "sender": "ann@example.com"}, "ann@example.com"),
    ({"_channel": "calendar", "organizer_email": "ann@example.com"}, "ann@example.com"),
    ({"_channel": "email", "messages": [{"sender_username": "ann"}]}, ""),
])
def test_other_channels_are_unchanged(remembered, batch, sender):
    triage_handlers._handle_memory_facts(FACTS, batch, None)
    assert remembered == [(batch["_channel"], sender)]
