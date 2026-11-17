"""``POST /api/comms/notifications/{id}/answer`` with ``feedback: true``.

"Ask for changes" on a reply to send answers the proposal with the person's
note, which the route treats as revision feedback. A note that reads as a
verdict ("approved", "denied", "rejected") is refused before anything
settles, so typing "approved" as a note can never send the reply.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hermes_cli import human_comms, web_server

COMMAND = "hermes todos send td1 --channel email --to ann@example.com"


@pytest.fixture
def route(monkeypatch, _isolate_hermes_home):
    from starlette.testclient import TestClient

    answered: list[str] = []
    settled: list[tuple[str, str]] = []

    class FakeStore:
        def __init__(self, *a, **k):
            pass

        async def answer(self, notification_id, principal, *, answer, via):
            answered.append(answer)
            item = SimpleNamespace(
                command=COMMAND,
                dedupe_key="todo-action:td1",
                as_dict=lambda: {"id": notification_id, "answer": answer},
            )
            return SimpleNamespace(newly_answered=True, notification=item)

    async def principal(request, **_):
        return SimpleNamespace(user_id="leo")

    async def settle(_principal, todo_id, answer):
        settled.append((todo_id, answer))
        return {"type": "revision", "session_id": "s1"}

    monkeypatch.setattr(human_comms, "NotificationStore", FakeStore)
    monkeypatch.setattr(web_server, "_comms_resolve_principal", principal)
    monkeypatch.setattr(web_server, "_comms_app_store", lambda: object())
    monkeypatch.setattr(web_server, "_settle_todo_proposal", settle)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    return SimpleNamespace(client=client, answered=answered, settled=settled)


def test_feedback_reaches_the_revision_path_as_typed(route):
    r = route.client.post(
        "/api/comms/notifications/n1/answer",
        json={"answer": "  Warmer tone, and ask how many staff will join ", "feedback": True},
    )
    assert r.status_code == 200, r.text
    assert r.json()["action"] == {"type": "revision", "session_id": "s1"}
    assert route.answered == ["Warmer tone, and ask how many staff will join"]
    assert route.settled == [("td1", "Warmer tone, and ask how many staff will join")]


@pytest.mark.parametrize("verdict", ["approved", "Approved", " DENIED ", "rejected"])
def test_feedback_that_reads_as_a_verdict_settles_nothing(route, verdict):
    r = route.client.post(
        "/api/comms/notifications/n1/answer", json={"answer": verdict, "feedback": True}
    )
    assert r.status_code == 400
    assert route.answered == [] and route.settled == []


def test_a_plain_answer_still_settles_as_a_verdict(route):
    r = route.client.post("/api/comms/notifications/n1/answer", json={"answer": "approved"})
    assert r.status_code == 200, r.text
    assert route.settled == [("td1", "approved")]
