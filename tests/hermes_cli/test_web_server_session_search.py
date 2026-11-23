from hermes_cli import web_server


class _FakeSessionDB:
    """Fake backing the /api/sessions/search endpoint.

    The endpoint surfaces direct session-id matches first, then FTS message
    matches, deduping both by compression lineage root. This fake has no
    compression chains (get_session returns no parent), so each session is its
    own lineage root.
    """

    closed = False

    def search_sessions_by_id(self, query, limit=20, include_archived=True, user_id=None):
        assert query == "20260603"
        assert include_archived is True
        return [
            {
                "id": "20260603_090200_exact",
                "preview": "ID match preview",
                "source": "cli",
                "model": "claude",
                "started_at": 100,
            }
        ]

    def search_messages(self, query, limit=20):
        assert query == "20260603*"
        return [
            {
                "session_id": "20260603_090200_exact",
                "snippet": "duplicate content hit should not replace ID hit",
                "role": "user",
                "source": "cli",
                "model": "claude",
                "session_started": 100,
            },
            {
                "session_id": "content_session",
                "snippet": "content hit",
                "role": "assistant",
                "source": "desktop",
                "model": "gpt",
                "session_started": 200,
            },
        ]

    def get_session(self, session_id):
        # No compression chains in this fixture — every session is its own root.
        return {"id": session_id, "parent_session_id": None}

    def get_compression_tip(self, session_id):
        return session_id

    def get_session_title(self, session_id):
        return {"content_session": "Deploy notes"}.get(session_id)

    def close(self):
        self.closed = True


def test_desktop_session_search_merges_id_matches_before_content_matches(monkeypatch):
    monkeypatch.setattr("hermes_state.SessionDB", _FakeSessionDB)

    response = web_server.search_sessions(q="20260603", limit=2, scope=None)

    # ID match surfaces first; the content hit on the SAME session is deduped
    # by lineage root (not double-listed); the unrelated content hit follows.
    assert response == {
        "results": [
            {
                "session_id": "20260603_090200_exact",
                "lineage_root": "20260603_090200_exact",
                "title": None,
                "snippet": "ID match preview",
                "role": None,
                "source": "cli",
                "model": "claude",
                "session_started": 100,
            },
            {
                "session_id": "content_session",
                "lineage_root": "content_session",
                "title": "Deploy notes",
                "snippet": "content hit",
                "role": "assistant",
                "source": "desktop",
                "model": "gpt",
                "session_started": 200,
            },
        ]
    }


def test_chat_lists_open_on_just_me_for_the_owner():
    """"Whose data" (FG-38): the owner may read every chat, but lists open on their own."""
    import asyncio

    from fastapi import HTTPException
    from starlette.requests import Request

    from hermes_cli.web_server import _chat_list_owners, _chat_own_scope

    def req(query: str, caller=None):
        r = Request({"type": "http", "query_string": query.encode(), "headers": []})
        r.state.chat_caller = caller
        return r

    run = asyncio.run
    # None: chats with no recorded owner (pre-multi-user) are the owner's.
    assert run(_chat_list_owners(req("", "leo"), None)) == ["leo", None]
    assert run(_chat_list_owners(req("owners=leo,ada", "leo"), None)) == ["leo", "ada", None]
    assert run(_chat_list_owners(req("owners=ada", "leo"), None)) == ["ada"]
    # A login limited to its own chats cannot widen with owners=.
    assert run(_chat_list_owners(req("owners=ada", "eve"), "eve")) == ["eve"]
    # No interactive login: the full list, as before.
    assert run(_chat_list_owners(req(""), None)) is None
    assert run(_chat_own_scope(req("", "leo"), None)) == "leo"
    try:
        run(_chat_list_owners(req("owners=bad%20id", "leo"), None))
    except HTTPException as exc:
        assert exc.status_code == 400
    else:
        raise AssertionError("a malformed owners= must be a 400")
