"""Real-path: an agent-home turn that names a file hands it to the user.

The real ``AIAgent`` loop (scripted model client) runs behind the real
``/api/sessions/{id}/chat`` and ``/chat/stream`` endpoints against a temp
``HERMES_HOME`` SessionDB; only the Supabase bucket and the file registry are
fakes. The reply's ``MEDIA:/abs/path`` tag must come back — to the client AND
in the persisted transcript — as agent-home's private media ref, with the file
uploaded under the caller's prefix and registered on their ``/files``.
"""

from __future__ import annotations

import json
import re
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from urllib.parse import parse_qs, urlsplit

import pytest

OWNER = SimpleNamespace(user_id="root", display="Root Owner", role="owner", is_owner=True)
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
REF = re.compile(r"(!?)\[([^\]]+)\]\((/api/chat/media\?path=[^)]+)\)")


@pytest.fixture(autouse=True)
def _isolate_hermes_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    try:
        import hermes_constants

        monkeypatch.setattr(hermes_constants, "get_hermes_home", lambda: tmp_path)
    except (ImportError, AttributeError):
        pass
    import hermes_state

    monkeypatch.setattr(hermes_state, "DEFAULT_DB_PATH", tmp_path / "state.db")
    return tmp_path


@pytest.fixture
def client(monkeypatch):
    from starlette.testclient import TestClient

    from hermes_cli import web_server
    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    async def _fake_principal(request, *, allow_as=False):
        return OWNER

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake_principal)
    c = TestClient(app)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def bucket(monkeypatch):
    """Fake Supabase bucket + file registry behind the real store_and_register."""
    import hermes_cli.file_registry as file_registry
    from hermes_cli.filestore import SupabaseStorage

    state = SimpleNamespace(uploads=[], registered=[], fail=False)

    class _Storage:
        bucket = "agent-home-media"

        async def upload(self, path, data, *, content_type="application/octet-stream"):
            if state.fail:
                raise RuntimeError("bucket unavailable")
            state.uploads.append((path, data, content_type))
            return path

    class _Registry:
        async def register(self, principal, **kwargs):
            state.registered.append({"owner": principal.user_id, **kwargs})
            return SimpleNamespace(**kwargs)

    monkeypatch.setattr(SupabaseStorage, "from_env", classmethod(lambda cls: _Storage()))
    monkeypatch.setattr(file_registry, "default_registry", lambda mode=None: _Registry())
    return state


@pytest.fixture
def model(monkeypatch):
    """Turns run the real AIAgent loop; ``model.replies`` scripts the model."""
    import gateway.session_chat as session_chat
    from run_agent import AIAgent

    state = SimpleNamespace(replies=[], agents=[])

    def _create(**kwargs):
        content = state.replies.pop(0)
        msg = SimpleNamespace(content=content, tool_calls=None)
        choice = SimpleNamespace(message=msg, finish_reason="stop")
        return SimpleNamespace(choices=[choice], model="test/model", usage=None)

    def _build(*, session_db, session_id=None, prompt_platform=None, **kwargs):
        with (
            patch("run_agent.get_tool_definitions", return_value=[]),
            patch("run_agent.check_toolset_requirements", return_value={}),
            patch("run_agent.OpenAI"),
            patch("agent.model_metadata.fetch_model_metadata", return_value={}),
        ):
            agent = AIAgent(
                api_key="test-key",
                base_url="https://openrouter.ai/api/v1",
                quiet_mode=True,
                skip_context_files=True,
                skip_memory=True,
                platform="api_server",
                session_db=session_db,
                session_id=session_id,
                stream_delta_callback=kwargs.get("stream_delta_callback"),
            )
        agent._platform_hint_key = prompt_platform
        agent.client = MagicMock()
        agent.client.chat.completions.create.side_effect = _create
        agent._cached_system_prompt = "You are helpful."
        agent._use_prompt_caching = False
        agent._disable_streaming = True
        agent.compression_enabled = False
        agent.save_trajectories = False
        state.agents.append(agent)
        return agent

    monkeypatch.setattr(session_chat, "build_session_agent", _build)
    monkeypatch.setattr(session_chat, "schedule_auto_title", lambda **kwargs: None)
    return state


def _session(sid: str, title: str | None = None) -> None:
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        db.ensure_session(sid, source="agent_home", user_id=OWNER.user_id)
        if title:
            db.set_session_title(sid, title)
    finally:
        db.close()


def _stored_assistant(sid: str) -> list[str]:
    import hermes_state

    db = hermes_state.SessionDB()
    try:
        return [
            m["content"] for m in db.get_messages(sid) if m["role"] == "assistant" and m["content"]
        ]
    finally:
        db.close()


def _completed(body: str) -> str:
    for frame in body.split("\n\n"):
        lines = frame.splitlines()
        if "event: assistant.completed" in lines:
            data = next(l for l in lines if l.startswith("data: "))
            return json.loads(data[len("data: "):])["content"]
    raise AssertionError(f"no assistant.completed in {body!r}")


def _assert_delivered(content: str, bucket, filename: str, *, image: bool, title: str):
    refs = REF.findall(content)
    assert refs, content
    bang, label, ref = refs[-1]
    assert (bang == "!") is image and label == filename
    key = parse_qs(urlsplit(ref).query)["path"][0]
    assert key.startswith(f"{OWNER.user_id}/files/")
    assert [u[0] for u in bucket.uploads][-1] == key
    reg = bucket.registered[-1]
    assert reg["surface"] == "agent_home"
    assert reg["owner"] == OWNER.user_id
    assert reg["conversation"] == title
    assert reg["filename"] == filename
    assert reg["storage_path"] == key
    assert "MEDIA:" not in content


def test_non_streaming_turn_uploads_registers_rewrites_and_persists(
    client, bucket, model, tmp_path
):
    chart = tmp_path / "workspaces" / "revenue.png"
    chart.parent.mkdir()
    chart.write_bytes(PNG)
    _session("s-media", title="Revenue charts")
    model.replies[:] = [f"Here is the chart:\n\nMEDIA:{chart}\n"]

    resp = client.post("/api/sessions/s-media/chat", json={"message": "chart it"})

    assert resp.status_code == 200, resp.text
    content = resp.json()["message"]["content"]
    _assert_delivered(content, bucket, "revenue.png", image=True, title="Revenue charts")
    assert content.startswith("Here is the chart:")
    assert bucket.uploads[-1][1] == PNG
    # A reload shows exactly what the client was sent.
    assert _stored_assistant("s-media")[-1] == content


def test_streaming_turn_completes_with_the_rewritten_reply(client, bucket, model, tmp_path):
    report = tmp_path / "q3 report.pdf"
    report.write_bytes(b"%PDF-1.4 numbers")
    _session("s-stream")
    model.replies[:] = [f"Done — MEDIA:{report}"]

    resp = client.post("/api/sessions/s-stream/chat/stream", json={"message": "report"})

    assert resp.status_code == 200
    content = _completed(resp.text)
    # Untitled conversations are filed under their id.
    _assert_delivered(content, bucket, "q3 report.pdf", image=False, title="s-stream")
    assert _stored_assistant("s-stream")[-1] == content


def test_failed_upload_leaves_a_note_and_the_turn_succeeds(client, bucket, model, tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    _session("s-fail")
    bucket.fail = True
    model.replies[:] = [f"Chart: MEDIA:{chart} and MEDIA:{tmp_path}/missing.csv"]

    resp = client.post("/api/sessions/s-fail/chat/stream", json={"message": "go"})

    assert resp.status_code == 200
    content = _completed(resp.text)
    assert "event: run.completed" in resp.text and "event: error" not in resp.text
    assert "(c.png: not attached, upload failed)" in content
    assert "(missing.csv: not attached, file not found)" in content
    assert "MEDIA:" not in content and bucket.registered == []
    assert _stored_assistant("s-fail")[-1] == content


def test_agent_home_turns_get_the_agent_home_prompt_hint(client, bucket, model):
    _session("s-hint")
    model.replies[:] = ["hi", "hi"]
    client.post("/api/sessions/s-hint/chat", json={"message": "a"})
    client.post("/api/sessions/s-hint/chat/stream", json={"message": "b"})
    assert [a._platform_hint_key for a in model.agents] == ["agent_home", "agent_home"]
    # Toolsets/delivery are still the api_server platform's.
    assert {a.platform for a in model.agents} == {"api_server"}
