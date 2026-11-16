"""Email sends carry MEDIA files (the invoice PDF) instead of dropping them.

Covers the one-shot email sender (``plugins/platforms/email/adapter.py``
``_standalone_send``), ``send_message_tool``'s email dispatch, and the
shared approve-to-send egress (``todo_outbound.deliver_message``) that both
the To-do and the project-card proposals use.
"""

from __future__ import annotations

import asyncio
import email
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from plugins.platforms.email import adapter as email_adapter

PDF = b"%PDF-1.4\n% INV-7\n%%EOF\n"
EXTRA = {"address": "billing@acme.example", "smtp_host": "smtp.acme.example"}


def _send(media_files, message="See attached."):
    pconfig = SimpleNamespace(token=None, api_key=None, extra=dict(EXTRA))
    with patch.dict("os.environ", {"EMAIL_PASSWORD": "pw"}), patch("smtplib.SMTP") as smtp:
        server = MagicMock()
        smtp.return_value = server
        result = asyncio.run(
            email_adapter._standalone_send(
                pconfig, "ap@client.example", message, media_files=media_files
            )
        )
    sent = server.send_message.call_args[0][0] if server.send_message.called else None
    return result, sent


def test_a_pdf_rides_in_the_mime_message(tmp_path):
    pdf = tmp_path / "INV-7.pdf"
    pdf.write_bytes(PDF)
    result, sent = _send([(str(pdf), False)])
    assert result["success"] and result["attachments"] == ["INV-7.pdf"]
    parsed = email.message_from_bytes(sent.as_bytes())
    assert parsed.is_multipart()
    [text] = [p for p in parsed.walk() if p.get_content_type() == "text/plain"]
    assert text.get_payload(decode=True).decode() == "See attached."
    [part] = [p for p in parsed.walk() if p.get_filename()]
    assert part.get_filename() == "INV-7.pdf"
    assert part.get_payload(decode=True) == PDF


def test_no_media_stays_a_plain_text_email():
    result, sent = _send(None)
    assert result["success"] and "attachments" not in result
    assert not sent.is_multipart()


def test_a_missing_file_refuses_the_whole_send(tmp_path):
    result, sent = _send([(str(tmp_path / "gone.pdf"), False)])
    assert "missing" in result["error"]
    assert sent is None


def test_attachments_over_the_cap_refuse_the_send(tmp_path, monkeypatch):
    monkeypatch.setattr(email_adapter, "STANDALONE_MAX_ATTACHMENT_BYTES", 8)
    pdf = tmp_path / "INV-7.pdf"
    pdf.write_bytes(PDF)
    result, sent = _send([(str(pdf), False)])
    assert "larger than" in result["error"]
    assert sent is None


def test_send_message_hands_email_its_media(tmp_path, monkeypatch):
    from gateway.config import Platform, PlatformConfig
    from tools import send_message_tool as smt

    calls = []

    async def _fake(platform_name, pconfig, chat_id, message, thread_id=None, media_files=None):
        calls.append((platform_name, chat_id, message, media_files))
        return {"success": True}

    monkeypatch.setattr(smt, "_registry_standalone_send", _fake)
    media = [(str(tmp_path / "INV-7.pdf"), False)]
    result = asyncio.run(
        smt._send_to_platform(
            Platform.EMAIL, PlatformConfig(enabled=True, extra=dict(EXTRA)),
            "ap@client.example", "See attached.", media_files=media,
        )
    )
    assert result == {"success": True}
    assert calls == [("email", "ap@client.example", "See attached.", media)]


@pytest.fixture
def captured(monkeypatch):
    calls = []

    def _fake(args, **kw):
        calls.append(args)
        return json.dumps({"success": True})

    monkeypatch.setattr("tools.send_message_tool.send_message_tool", _fake)
    monkeypatch.setattr("hermes_cli.send_cmd._load_hermes_env", lambda: None)
    return calls


def test_deliver_message_adds_allowed_attachments(tmp_path, monkeypatch, captured):
    from hermes_cli import todo_outbound

    monkeypatch.setenv("HERMES_MEDIA_ALLOW_DIRS", str(tmp_path))
    pdf = tmp_path / "INV-7.pdf"
    pdf.write_bytes(PDF)
    result = todo_outbound.deliver_message(
        channel="email", target="ap@client.example", body="Invoice attached.",
        account="acme", subject="INV-7", attachments=[str(pdf)],
    )
    assert result == {"success": True}
    [args] = captured
    assert args["message"].splitlines() == ["Invoice attached.", f"MEDIA:{pdf}"]
    assert args["account"] == "acme" and args["subject"] == "INV-7"


def test_deliver_message_refuses_a_path_the_media_check_rejects(captured, monkeypatch):
    from hermes_cli import todo_outbound

    monkeypatch.setenv("HERMES_MEDIA_TRUST_RECENT_FILES", "0")
    result = todo_outbound.deliver_message(
        channel="email", target="ap@client.example",
        body="Invoice\nMEDIA:/nonexistent/INV-7.pdf", account="acme",
    )
    assert "refused" in result["error"]
    assert captured == []
