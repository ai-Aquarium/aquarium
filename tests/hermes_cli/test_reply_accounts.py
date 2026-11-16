"""FG-03 P6 (C) unit tests: reply-account guards and resolution (no database).

The real-Postgres path is ``test_fg03_reply_accounts_e2e``.
"""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from hermes_cli import reply_accounts as ra
from hermes_cli.source_registry import Source

JOHNS_BOT = Source(source_id="s1", channel="telegram", address="12345", owner_user_id="john")
TG_ARRIVAL = {"surface": "telegram", "account_id": "tgbot:12345", "conversation": "555"}


def _check(user, channel, account, *, target=None, arrival=None, source=JOHNS_BOT):
    with patch.object(ra, "find_source", AsyncMock(return_value=source)):
        return asyncio.run(ra.check_reply(user, channel, account, target=target, arrival=arrival))


@pytest.mark.parametrize("channel, account, key", [
    ("telegram", "tgbot:12345", ("telegram", "12345")),
    ("telegram", "install-bot", None),
    ("email", "John@Example.com", ("email", "john@example.com")),
    ("whatsapp", "+852 9111 2222", ("whatsapp", "85291112222")),
    ("sms", "+85291112222", None),
    ("email", "", None),
])
def test_registry_key(channel, account, key, tmp_path, monkeypatch):
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(tmp_path / "missing.json"))
    monkeypatch.setenv("WHATSAPP_CONFIG_PATH", str(tmp_path / "missing.json"))
    assert ra.registry_key(channel, account) == key


def test_pipeline_account_ids_map_to_their_address(tmp_path, monkeypatch):
    config = tmp_path / "email.json"
    config.write_text('{"accounts": [{"id": "ops", "address": "Ops@Example.com"}]}')
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(config))
    assert ra.registry_key("email", "ops") == ("email", "ops@example.com")


def test_owner_may_reply_from_the_arrival_account():
    assert _check("john", "telegram", "tgbot:12345", target="555", arrival=TG_ARRIVAL) is JOHNS_BOT


def test_another_user_may_not_send_from_the_source():
    with pytest.raises(ra.ReplyRefused) as refused:
        _check("mary", "telegram", "tgbot:12345", target="555", arrival=TG_ARRIVAL)
    assert refused.value.code == "not_source_owner"


@pytest.mark.parametrize("channel, account, target, code", [
    ("telegram", "tgbot:999", "555", "wrong_account"),
    ("telegram", None, "555", "wrong_account"),
    ("email", "john@example.com", "555", "wrong_account"),
    ("telegram", "tgbot:12345", "666", "wrong_chat"),
])
def test_a_reply_must_use_the_arrival_account_and_chat(channel, account, target, code):
    with pytest.raises(ra.ReplyRefused) as refused:
        _check("john", channel, account, target=target, arrival=TG_ARRIVAL)
    assert refused.value.code == code


def test_unregistered_account_falls_back_without_an_owner_check():
    assert _check("anyone", "email", "ops@example.com", source=None) is None


def test_send_tool_refuses_a_bound_principal_who_is_not_the_owner():
    from tools.access_policy import acting_as
    from tools.send_message_tool import _account_pconfig

    with patch.object(ra, "find_source", AsyncMock(return_value=JOHNS_BOT)), \
            acting_as("mary", "member"), pytest.raises(ra.ReplyRefused):
        _account_pconfig("telegram", "tgbot:12345")


def test_send_tool_uses_the_owners_bot_token():
    from tools.access_policy import acting_as
    from tools.send_message_tool import _account_pconfig

    cred = SimpleNamespace(owner_user_id="john", name="bot", payload={"token": "12345:secret"})
    with patch.object(ra, "find_source", AsyncMock(return_value=JOHNS_BOT)), \
            patch.object(ra, "_owner_credential", AsyncMock(return_value=cred)), \
            acting_as("john", "member"):
        pconfig = _account_pconfig("telegram", "tgbot:12345")
    assert pconfig.token == "12345:secret"


def test_registered_source_without_a_credential_is_refused_not_rerouted():
    from tools.send_message_tool import _account_pconfig

    with patch.object(ra, "find_source", AsyncMock(return_value=JOHNS_BOT)), \
            patch.object(ra, "_owner_credential", AsyncMock(return_value=None)):
        assert _account_pconfig("telegram", "tgbot:12345") is None


def test_email_sender_uses_an_in_memory_password_over_ssl(monkeypatch):
    import smtplib

    from plugins.platforms.email.adapter import _standalone_send

    calls = []

    class FakeSSL:
        def __init__(self, host, port, **_kw):
            calls.append(("ssl", host, port))

        def login(self, user, password):
            calls.append(("login", user, password))

        def send_message(self, msg):
            calls.append(("from", msg["From"]))

        def quit(self):
            pass

    monkeypatch.setattr(smtplib, "SMTP_SSL", FakeSSL)
    monkeypatch.delenv("EMAIL_PASSWORD", raising=False)
    pconfig = SimpleNamespace(extra={
        "address": "john@example.com", "username": "john", "password": "pw",
        "smtp_host": "smtp.example.com", "smtp_port": 465, "smtp_security": "ssl",
    })
    result = asyncio.run(_standalone_send(pconfig, "ann@example.com", "hi"))
    assert result["success"] is True
    assert calls == [("ssl", "smtp.example.com", 465), ("login", "john", "pw"),
                     ("from", "john@example.com")]
