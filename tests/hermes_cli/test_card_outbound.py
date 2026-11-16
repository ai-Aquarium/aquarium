"""A project card's outgoing message: the worker proposes, a person sends.

End to end on a real temp HERMES_HOME: the proposal is written by the
``hermes projects propose-send`` handler on the worker's own card, read back
through the board API, and answered through
``POST /{slug}/cards/{id}/approvals``. Approve sends through the real
``send_message_tool`` → email plugin path with only ``smtplib.SMTP`` faked,
so the PDF must actually be in the MIME message that goes out.
"""

from __future__ import annotations

import argparse
import email
import json
import os

import pytest

from hermes_cli import card_outbound, kanban_db
from hermes_cli.projects_cli import _cmd_propose_send

from tests.hermes_cli.test_projects_board_api import (  # noqa: F401 - fixture
    PREFIX,
    _card,
    _project,
    _set_status,
    env,
)

PDF = b"%PDF-1.4\n% invoice INV-0042\n%%EOF\n"


@pytest.fixture
def card(env, tmp_path, monkeypatch):  # noqa: F811 - pytest fixture
    project = _project(env)
    task_id = _card(env, project["slug"], "Draft the November invoice")
    ws = tmp_path / "ws" / task_id
    ws.mkdir(parents=True)
    (ws / "INV-0042.pdf").write_bytes(PDF)
    with kanban_db.connect_closing() as conn:
        with kanban_db.write_txn(conn):
            conn.execute(
                "UPDATE tasks SET workspace_path = ? WHERE id = ?", (str(ws), task_id)
            )
    monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    cfg = tmp_path / "email-config.json"
    cfg.write_text(json.dumps({"accounts": [{
        "id": "acme",
        "address": "billing@acme.example",
        "smtp": {"host": "smtp.acme.example", "port": 587},
        "credentials_env": "ACME_SMTP_PASSWORD",
    }]}))
    monkeypatch.setenv("EMAIL_CONFIG_PATH", str(cfg))
    monkeypatch.setenv("ACME_SMTP_PASSWORD", "pw")
    return {"slug": project["slug"], "task_id": task_id, "ws": ws}


class _FakeSMTP:
    sent: list = []
    fail = False

    def __init__(self, host, port, timeout=None):
        self.host = host

    def starttls(self, context=None):
        pass

    def login(self, user, password):
        self.user = user

    def send_message(self, msg):
        if _FakeSMTP.fail:
            raise OSError("SMTP down")
        _FakeSMTP.sent.append(msg)

    def quit(self):
        pass

    def close(self):
        pass


@pytest.fixture
def smtp(monkeypatch):
    _FakeSMTP.sent = []
    _FakeSMTP.fail = False
    monkeypatch.setattr("smtplib.SMTP", _FakeSMTP)
    return _FakeSMTP


def _args(**over):
    base = dict(
        channel="email", to="ap@client.example", account="acme",
        subject="Invoice INV-0042", body="Please find November's invoice attached.",
        body_file=None, attach="INV-0042.pdf", task=None, json=True,
    )
    base.update(over)
    return argparse.Namespace(**base)


def _propose(capsys, **over) -> dict:
    assert _cmd_propose_send(_args(**over)) == 0
    return json.loads(capsys.readouterr().out)


def _pending(env, card):  # noqa: F811
    client, _state = env
    resp = client.get(f"{PREFIX}/{card['slug']}/cards/{card['task_id']}")
    return resp.json()["pending_approvals"]


def _answer(env, card, key, decision, **extra):  # noqa: F811
    client, _state = env
    return client.post(
        f"{PREFIX}/{card['slug']}/cards/{card['task_id']}/approvals",
        json={"key": key, "decision": decision, **extra},
    )


def _events(task_id) -> list[str]:
    with kanban_db.connect_closing() as conn:
        return [e.kind for e in kanban_db.list_events(conn, task_id)]


def test_a_proposal_waits_on_the_card_with_the_whole_message(env, card, capsys, smtp):  # noqa: F811
    proposal = _propose(capsys)
    assert proposal["key"].startswith("send:")
    assert proposal["status"] == "pending"
    _set_status(card["task_id"], "blocked")
    [pending] = _pending(env, card)
    detail = json.loads(pending["detail"])
    assert detail["target"] == "ap@client.example"
    assert detail["account"] == "acme"
    assert detail["subject"] == "Invoice INV-0042"
    assert detail["body"].startswith("Please find")
    assert detail["attachment"]["name"] == "INV-0042.pdf"
    assert detail["attachment"]["size"] == len(PDF)
    assert pending["label"] == "Send email to ap@client.example from acme"
    assert "outbound_proposed" in _events(card["task_id"])
    assert smtp.sent == []  # proposing never sends


def test_approve_sends_the_pdf_from_the_named_account_once(env, card, capsys, smtp):  # noqa: F811
    key = _propose(capsys)["key"]
    _set_status(card["task_id"], "blocked")
    resp = _answer(env, card, key, "approve")
    assert resp.status_code == 200, resp.text
    assert resp.json()["outbound"] == {"event": "sent"}
    assert resp.json()["status"] != "blocked"  # released for the next run

    [msg] = smtp.sent
    assert msg["From"] == "billing@acme.example"
    assert msg["To"] == "ap@client.example"
    assert msg["Subject"] == "Invoice INV-0042"
    parsed = email.message_from_bytes(msg.as_bytes())
    parts = [p for p in parsed.walk() if p.get_filename()]
    assert [p.get_filename() for p in parts] == ["INV-0042.pdf"]
    assert parts[0].get_payload(decode=True) == PDF

    # Single use: the approval is spent and the card refuses a replay.
    assert _answer(env, card, key, "approve").status_code == 409
    with kanban_db.connect_closing() as conn:
        assert card_outbound.deliver(conn, card["task_id"], key, actor="user:x")[
            "error"] == "already_sent"
    assert len(smtp.sent) == 1
    kinds = _events(card["task_id"])
    assert kinds.index("outbound_proposed") < kinds.index("approval_approved") < kinds.index("outbound_sent")
    with kanban_db.connect_closing() as conn:
        comments = [c.body for c in kanban_db.list_comments(conn, card["task_id"])]
    assert any(c.startswith("Sent: Send email to ap@client.example") for c in comments)


def test_deny_sends_nothing(env, card, capsys, smtp):  # noqa: F811
    key = _propose(capsys)["key"]
    _set_status(card["task_id"], "blocked")
    resp = _answer(env, card, key, "deny")
    assert resp.status_code == 200
    assert "outbound" not in resp.json()
    assert smtp.sent == []
    assert "approval_denied" in _events(card["task_id"])
    with kanban_db.connect_closing() as conn:
        assert card_outbound.deliver(conn, card["task_id"], key, actor="u")["error"] == "denied"


def test_revise_sends_the_note_back_to_the_next_run(env, card, capsys, smtp):  # noqa: F811
    key = _propose(capsys)["key"]
    _set_status(card["task_id"], "blocked")
    assert _answer(env, card, key, "revise").status_code == 422  # needs a note
    resp = _answer(env, card, key, "revise", note="Use the PO number 7781")
    assert resp.status_code == 200
    assert resp.json()["status"] != "blocked"
    assert smtp.sent == []
    assert "outbound_revise" in _events(card["task_id"])
    with kanban_db.connect_closing() as conn:
        comments = [c.body for c in kanban_db.list_comments(conn, card["task_id"])]
    assert any("Use the PO number 7781" in c and "propose-send" in c for c in comments)


def test_revise_is_only_for_a_proposed_message(env, card):  # noqa: F811
    resp = _answer(env, card, "terminal", "revise", note="x")
    assert resp.status_code == 422


def test_a_failed_send_waits_for_approval_again(env, card, capsys, smtp):  # noqa: F811
    key = _propose(capsys)["key"]
    _set_status(card["task_id"], "blocked")
    smtp.fail = True
    resp = _answer(env, card, key, "approve")
    assert resp.status_code == 200
    assert resp.json()["outbound"]["event"] == "failed"
    assert resp.json()["status"] == "blocked"
    assert [p["key"] for p in _pending(env, card)] == [key]
    smtp.fail = False
    assert _answer(env, card, key, "approve").json()["outbound"] == {"event": "sent"}
    assert len(smtp.sent) == 1


def test_an_attachment_changed_after_proposing_is_not_sent(env, card, capsys, smtp):  # noqa: F811
    key = _propose(capsys)["key"]
    snap = next(kanban_db.outbound_root().rglob("INV-0042.pdf"))
    snap.write_bytes(b"%PDF-1.4 tampered")
    _set_status(card["task_id"], "blocked")
    resp = _answer(env, card, key, "approve")
    assert resp.json()["outbound"]["event"] == "failed"
    assert "changed" in resp.json()["outbound"]["error"]
    assert smtp.sent == []


def test_the_workspace_file_is_snapshotted_when_proposed(env, card, capsys, smtp):  # noqa: F811
    key = _propose(capsys)["key"]
    (card["ws"] / "INV-0042.pdf").write_bytes(b"edited later")
    _set_status(card["task_id"], "blocked")
    _answer(env, card, key, "approve")
    parsed = email.message_from_bytes(smtp.sent[0].as_bytes())
    [part] = [p for p in parsed.walk() if p.get_filename()]
    assert part.get_payload(decode=True) == PDF


@pytest.mark.parametrize(
    "over, needle",
    [
        ({"attach": "../escape.pdf"}, "workspace"),
        ({"attach": "missing.pdf"}, "does not exist"),
        ({"attach": ".env"}, "cannot be attached"),
        ({"account": ""}, "account is required"),
        ({"subject": ""}, "subject"),
        ({"channel": "sms"}, "channel"),
        ({"to": ""}, "somewhere to go"),
        ({"body": "hi\nMEDIA:/etc/passwd"}, "--attach"),
        ({"body": "x" * 4001}, "4000"),
    ],
)
def test_a_bad_proposal_is_refused_and_records_nothing(env, card, capsys, over, needle):  # noqa: F811
    (card["ws"].parent / "escape.pdf").write_bytes(PDF)
    (card["ws"] / ".env").write_text("SECRET=1")
    assert _cmd_propose_send(_args(**over)) == 1
    assert needle in capsys.readouterr().err
    with kanban_db.connect_closing() as conn:
        assert kanban_db.list_task_approvals(conn, [card["task_id"]]) == {}


def test_a_symlink_out_of_the_workspace_is_refused(env, card, capsys, tmp_path):  # noqa: F811
    secret = tmp_path / "secret.pdf"
    secret.write_bytes(PDF)
    os.symlink(secret, card["ws"] / "link.pdf")
    assert _cmd_propose_send(_args(attach="link.pdf")) == 1
    assert "inside the card's workspace" in capsys.readouterr().err


def test_an_oversized_attachment_is_refused(env, card, capsys, monkeypatch):  # noqa: F811
    monkeypatch.setattr(card_outbound, "MAX_ATTACHMENT_BYTES", 10)
    assert _cmd_propose_send(_args()) == 1
    assert "limit" in capsys.readouterr().err


def test_a_card_off_any_project_cannot_propose(env, capsys, monkeypatch):  # noqa: F811
    with kanban_db.connect_closing() as conn:
        task_id = kanban_db.create_task(conn, title="loose card")
    monkeypatch.setenv("HERMES_KANBAN_TASK", task_id)
    assert _cmd_propose_send(_args(attach=None)) == 1
    assert "not on a project" in capsys.readouterr().err


def test_whatsapp_leaves_by_the_named_bridge_with_the_file(env, card, capsys, monkeypatch):  # noqa: F811
    calls = []

    def _fake_send(args, **kw):
        calls.append(args)
        return json.dumps({"success": True})

    monkeypatch.setattr("tools.send_message_tool.send_message_tool", _fake_send)
    key = _propose(
        capsys, channel="whatsapp", to="+85291234567", account="connectar", subject=None
    )["key"]
    _set_status(card["task_id"], "blocked")
    assert _answer(env, card, key, "approve").json()["outbound"] == {"event": "sent"}
    [args] = calls
    assert args["target"] == "whatsapp:+85291234567"
    assert args["account"] == "connectar"
    assert "subject" not in args
    media = [ln for ln in args["message"].splitlines() if ln.startswith("MEDIA:")]
    assert len(media) == 1 and media[0].endswith("/INV-0042.pdf")
    assert str(kanban_db.outbound_root()) in media[0]


def test_the_cli_tells_the_worker_to_block_and_not_send(env, card, capsys):  # noqa: F811
    assert _cmd_propose_send(_args(json=False)) == 0
    out = capsys.readouterr().out
    assert "Nothing was sent" in out and "kanban_block" in out
