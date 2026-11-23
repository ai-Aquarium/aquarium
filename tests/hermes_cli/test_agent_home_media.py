"""``MEDIA:`` tags in an agent-home reply become private-bucket media refs.

Contract (hermes_cli.agent_home_media): every deliverable ``MEDIA:/abs/path``
tag in the final reply is uploaded into the turn principal's Files
(``store_and_register``, surface ``agent_home``) and replaced with
``![name](/api/chat/media?path=<key>)`` (images) or ``[name](...)`` (other
files) — the shape agent-home's ``mediaRef()`` builds and its read route
(``canReadMediaPath``) accepts for that owner. A tag that cannot be delivered
becomes a plain-text note; nothing raises.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from hermes_cli import agent_home_media as ahm
from hermes_cli.file_registry import agent_home_slug, slug, storage_key

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "agent-home/src/lib/supabase/slug-vectors.json"
    ).read_text(encoding="utf-8")
)

# Admins' file tools may use any file; members are confined to their folder.
ADA = SimpleNamespace(user_id="Ada Lovelace", display="Ada", role="admin", is_owner=False)
MIA = SimpleNamespace(user_id="mia", display="Mia", role="member", is_owner=False)
PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def _can_read_media_path(user_id: str, path: str) -> bool:
    """agent-home ``canReadMediaPath`` (storage.ts), ported line for line."""
    if not path or len(path) > 512:
        return False
    if "\\" in path or "\0" in path or "%" in path:
        return False
    if path.startswith("/") or "//" in path:
        return False
    segments = path.split("/")
    if len(segments) < 2:
        return False
    for segment in segments:
        if not segment or segment in (".", "..") or ".." in segment:
            return False
        if segment != agent_home_slug(segment):
            return False
    return segments[0] == agent_home_slug(user_id)


class _Storage:
    bucket = "agent-home-media"

    def __init__(self, fail: bool = False) -> None:
        self.uploads: list[tuple[str, bytes, str]] = []
        self.fail = fail

    async def upload(self, path, data, *, content_type="application/octet-stream"):
        if self.fail:
            raise RuntimeError("bucket is on fire")
        self.uploads.append((path, data, content_type))
        return path


class _Registry:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def register(self, principal, **kwargs):
        self.calls.append({"owner": principal.user_id, **kwargs})
        return SimpleNamespace(id=f"file {len(self.calls)}", **kwargs)


def _rewrite(content, **kw):
    kw.setdefault("storage", _Storage())
    kw.setdefault("registry", _Registry())
    out, edits = asyncio.run(ahm.rewrite_media_tags(content, ADA, **kw))
    return out, edits, kw["storage"], kw["registry"]


def _ref_key(ref: str) -> str:
    query = parse_qs(urlsplit(ref).query)
    return query["path"][0]


# ---------------------------------------------------------------------------
# Key / ref parity with agent-home
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS["slug"], ids=lambda v: repr(v["input"]))
def test_owner_slug_matches_agent_home(vector):
    assert agent_home_slug(vector["input"]) == vector["slug"]


@pytest.mark.parametrize("vector", VECTORS["keys"], ids=lambda v: v["filename"][:20])
def test_shared_key_vectors_are_what_python_uploads(vector):
    # agent-home's storage test asserts canReadMediaPath accepts these keys.
    key = storage_key(vector["user_id"], "agent_home", vector["digest"], vector["filename"])
    assert key == vector["key"]
    assert _can_read_media_path(vector["user_id"], key)


@pytest.mark.parametrize(
    "user_id,filename",
    [
        ("leo", "a..b.png"),
        ("Leo Lau", "..chart.png"),
        ("_root_", "report_.pdf"),
        ("user@example.com", "x...y...z.csv"),
        ("mia", "._weird_.svg"),
        ("u", "n" * 300 + ".png"),
    ],
)
def test_every_uploaded_key_is_readable_by_its_owner(user_id, filename):
    key = storage_key(user_id, "agent_home", "ab" * 32, filename)
    assert _can_read_media_path(user_id, key), key
    assert not _can_read_media_path(user_id + "-other", key)


def test_long_names_keep_their_extension():
    assert slug("n" * 300 + ".png").endswith(".png")
    assert len(slug("n" * 300 + ".png")) <= 120


def test_media_ref_is_encode_uri_component():
    key = "Ada_Lovelace/files/ab/abcd-my chart(1)!.png"
    ref = ahm.media_ref(key)
    assert ref.startswith("/api/chat/media?path=")
    # encodeURIComponent: "/" and " " are escaped, its unreserved marks are not.
    assert ref == "/api/chat/media?path=Ada_Lovelace%2Ffiles%2Fab%2Fabcd-my%20chart(1)!.png"
    assert _ref_key(ref) == key


# ---------------------------------------------------------------------------
# Rewrite
# ---------------------------------------------------------------------------


def test_image_and_document_tags_become_media_refs(tmp_path):
    chart = tmp_path / "sales chart.png"
    chart.write_bytes(PNG)
    report = tmp_path / "a..b.pdf"
    report.write_bytes(b"%PDF-1.4 hello")
    content = f"Here you go:\nMEDIA:{chart}\n\nAnd the report MEDIA:{report}\nDone."

    out, edits, storage, registry = _rewrite(content, conversation="Q3 charts", message_id="7")

    image = re.search(r"!\[sales chart\.png\]\((/api/chat/media\?path=[^)]+)\)", out)
    link = re.search(r"(?<!!)\[a\.\.b\.pdf\]\((/api/chat/media\?path=[^)]+)\)", out)
    assert image and link, out
    assert "MEDIA:" not in out
    assert out.startswith("Here you go:\n") and out.endswith("\nDone.")
    assert len(edits) == 2

    keys = [_ref_key(image.group(1)), _ref_key(link.group(1))]
    assert [u[0] for u in storage.uploads] == keys
    assert storage.uploads[0][1] == PNG and storage.uploads[0][2] == "image/png"
    assert storage.uploads[1][2] == "application/pdf"
    for key in keys:
        assert _can_read_media_path(ADA.user_id, key), key
    assert [c["surface"] for c in registry.calls] == ["agent_home", "agent_home"]
    assert [c["filename"] for c in registry.calls] == ["sales chart.png", "a..b.pdf"]
    assert {c["conversation"] for c in registry.calls} == {"Q3 charts"}
    assert {c["owner"] for c in registry.calls} == {ADA.user_id}


def test_html_page_opens_in_the_viewer(tmp_path):
    page = tmp_path / "sales.html"
    page.write_text("<html><body><script>plot()</script></body></html>")
    out, _, storage, registry = _rewrite(f"Interactive:\nMEDIA:{page}")

    assert out == "Interactive:\n[sales.html](/view/file%201)", out
    assert registry.calls[0]["filename"] == "sales.html"
    assert storage.uploads[0][2] == "text/html"


def test_same_file_twice_uploads_once(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    out, _, storage, _ = _rewrite(f"MEDIA:{chart}\nagain MEDIA:{chart}")
    assert len(storage.uploads) == 1
    assert out.count("![c.png](/api/chat/media?path=") == 2


def test_tags_in_code_are_examples_not_deliveries(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    content = f"Write `MEDIA:{chart}` to share.\n```\nMEDIA:{chart}\n```"
    out, edits, storage, _ = _rewrite(content)
    assert out == content and edits == [] and storage.uploads == []


def test_reply_without_tags_is_returned_unchanged():
    out, edits, storage, _ = _rewrite("no files here, see /tmp/x.png")
    assert out == "no files here, see /tmp/x.png" and edits == []
    assert storage.uploads == []


def _note_for(out: str, name: str) -> str:
    match = re.search(r"\(" + re.escape(name) + r": not attached, ([^)]*)\)", out)
    assert match, out
    return match.group(1)


def test_missing_file_leaves_a_note(tmp_path):
    out, _, storage, _ = _rewrite(f"See MEDIA:{tmp_path}/gone.png now")
    assert _note_for(out, "gone.png") == "file not found"
    assert out.startswith("See (") and out.endswith(") now")
    assert "MEDIA:" not in out and storage.uploads == []


def test_too_large_file_leaves_a_note(tmp_path, monkeypatch):
    import hermes_cli.file_registry as fr

    monkeypatch.setattr(fr, "MAX_REGISTER_BYTES", 16)
    big = tmp_path / "big.png"
    big.write_bytes(PNG)
    out, _, storage, _ = _rewrite(f"MEDIA:{big}")
    assert "too large" in _note_for(out, "big.png")
    assert storage.uploads == []


def test_upload_error_leaves_a_note(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    out, edits, _, registry = _rewrite(f"MEDIA:{chart}", storage=_Storage(fail=True))
    assert _note_for(out, "c.png") == "upload failed"
    assert registry.calls == [] and len(edits) == 1


def test_unconfigured_storage_leaves_a_note(tmp_path, monkeypatch):
    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"):
        monkeypatch.delenv(var, raising=False)
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    out, _ = asyncio.run(ahm.rewrite_media_tags(f"MEDIA:{chart}", ADA))
    assert _note_for(out, "c.png") == "file storage is not configured"


def test_symlink_is_not_followed(tmp_path):
    secret = tmp_path / "outside" / "secret.png"
    secret.parent.mkdir()
    secret.write_bytes(PNG)
    link = tmp_path / "link.png"
    os.symlink(secret, link)
    out, _, storage, _ = _rewrite(f"MEDIA:{link}")
    assert "symbolic link" in _note_for(out, "link.png")
    assert storage.uploads == []


def test_denied_location_is_not_shared(tmp_path):
    out, _, storage, _ = _rewrite("MEDIA:/etc/hostname.txt and MEDIA:/proc/self/environ.txt")
    assert "MEDIA:" not in out
    assert storage.uploads == []


def test_no_principal_leaves_a_note(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    out, _ = asyncio.run(
        ahm.rewrite_media_tags(f"MEDIA:{chart}", None, storage=_Storage(), registry=_Registry())
    )
    assert "no signed-in user" in _note_for(out, "c.png")


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------


def test_persist_rewrite_updates_the_final_assistant_row(tmp_path):
    from hermes_state import SessionDB

    db = SessionDB(db_path=tmp_path / "state.db")
    try:
        db.ensure_session("s1", source="agent_home")
        db.append_message("s1", "user", "chart please")
        db.append_message("s1", "assistant", "earlier MEDIA:/x/old.png")
        db.append_message("s1", "user", "again")
        db.append_message("s1", "assistant", "here MEDIA:/x/c.png")
        edits = [("MEDIA:/x/c.png", "![c.png](/api/chat/media?path=k)")]
        assert ahm.persist_rewrite(
            db, "s1", "here MEDIA:/x/c.png", "here ![c.png](/api/chat/media?path=k)", edits
        )
        contents = [m["content"] for m in db.get_messages("s1")]
    finally:
        db.close()
    assert contents == [
        "chart please",
        "earlier MEDIA:/x/old.png",
        "again",
        "here ![c.png](/api/chat/media?path=k)",
    ]


def test_tags_sharing_a_line_are_delivered_separately(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    sheet = tmp_path / "my data.csv"
    sheet.write_text("a,b\n1,2\n")
    content = f"Chart MEDIA:{chart} and sheet MEDIA:{sheet} and notes.txt end"
    out, edits, storage, _ = _rewrite(content)
    assert len(storage.uploads) == 2 and len(edits) == 2
    assert out.startswith("Chart ![c.png](/api/chat/media?path=")
    assert " and sheet [my data.csv](/api/chat/media?path=" in out
    assert out.endswith(") and notes.txt end")



def _old_file(path: Path, data: bytes = b"%PDF-1.4 old") -> Path:
    """A file past the gateway's recency window, so only folder rules admit it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    os.utime(path, (1_000_000_000, 1_000_000_000))
    return path


def _rewrite_as(principal, content, **kw):
    kw.setdefault("storage", _Storage())
    kw.setdefault("registry", _Registry())
    out, edits = asyncio.run(ahm.rewrite_media_tags(content, principal, **kw))
    return out, kw["storage"]


def test_member_cannot_attach_a_file_outside_their_folder(tmp_path):
    from hermes_constants import get_hermes_home

    recent = tmp_path / "elsewhere.pdf"
    recent.write_bytes(b"%PDF-1.4 recent")
    others = _old_file(Path(get_hermes_home()) / "workspaces" / "zoe" / "z.pdf")
    out, storage = _rewrite_as(MIA, f"A MEDIA:{recent}\nB MEDIA:{others}")
    assert storage.uploads == []
    assert "(elsewhere.pdf: not attached, file is outside your own folder)" in out
    assert "(z.pdf: not attached, " in out


def test_member_attaches_an_older_file_from_their_own_folder():
    from tools.access_policy import files_root

    mine = _old_file(files_root(MIA.user_id, MIA.role) / "plan.pdf")
    out, storage = _rewrite_as(MIA, f"MEDIA:{mine}")
    assert out.startswith("[plan.pdf](/api/chat/media?path=mia%2Ffiles%2F")
    assert len(storage.uploads) == 1


@pytest.mark.parametrize("who,folder", [(MIA, "mia"), (ADA, "someone")])
def test_files_are_checked_in_the_turns_profile(tmp_path, who, folder):
    from agent.profile_runtime import profile_runtime_scope

    home = tmp_path / "profiles" / "sales"
    report = _old_file(home / "workspaces" / folder / "report.pdf")
    content = f"MEDIA:{report}"
    out, storage = _rewrite_as(
        who, content, file_scope=lambda: profile_runtime_scope(home)
    )
    assert out.startswith("[report.pdf](/api/chat/media?path=")
    assert len(storage.uploads) == 1

    out, storage = _rewrite_as(who, content)
    assert storage.uploads == [] and out.startswith("(report.pdf: not attached, ")


class _InitRegistry(_Registry):
    def __init__(self, fail: bool = False) -> None:
        super().__init__()
        self.fail = fail
        self.initialized = 0
        self._store = SimpleNamespace(dsn=f"fake-{id(self)}", schema="app_test")
        self.role_reads = False

    async def initialize(self):
        self.initialized += 1
        if self.fail:
            raise RuntimeError("no database")


def test_registry_is_initialized_before_the_first_upload(tmp_path):
    a, b = tmp_path / "a.png", tmp_path / "b.png"
    a.write_bytes(PNG)
    b.write_bytes(PNG + b"b")
    registry = _InitRegistry()
    out, edits, storage, _ = _rewrite(f"MEDIA:{a}\nMEDIA:{b}", registry=registry)
    assert registry.initialized == 1
    assert len(registry.calls) == 2 and len(storage.uploads) == 2


def test_registry_that_cannot_initialize_uploads_nothing(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    out, _, storage, _ = _rewrite(f"MEDIA:{chart}", registry=_InitRegistry(fail=True))
    assert storage.uploads == []
    assert out == "(c.png: not attached, the file registry is unavailable)"


def test_nested_fence_examples_in_a_longer_fence_are_left_alone(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    example = f"MEDIA:{tmp_path}/report.pdf"
    draft = (
        "````skill-draft\n# Skill\n```bash\nmake\n```\n"
        f"Then reply with {example}\n```sh\necho {example}\n```\n````\n"
    )
    out, edits, storage, _ = _rewrite(f"{draft}Here: MEDIA:{chart}")
    assert out.startswith(draft)
    assert len(edits) == 1 and len(storage.uploads) == 1
    assert out.endswith(")") and "![c.png](" in out


def test_same_length_nested_fences_in_a_draft_are_left_alone(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    example = f"MEDIA:{tmp_path}/report.pdf"
    draft = (
        "```skill-draft\n# Skill\n```bash\nmake\n```\n"
        f"Then reply with {example}\n```sh\necho {example}\n```\n```\n"
    )
    out, edits, storage, _ = _rewrite(f"{draft}Here: MEDIA:{chart}")
    assert out.startswith(draft)
    assert len(edits) == 1 and "![c.png](" in out


def test_crlf_fences_do_not_hide_later_attachments(tmp_path):
    chart = tmp_path / "c.png"
    chart.write_bytes(PNG)
    block = "````\r\nMEDIA:/tmp/example.png\r\n````\r\n"
    out, edits, _, _ = _rewrite(f"{block}Chart: MEDIA:{chart}\r\n")
    assert out.startswith(block)
    assert len(edits) == 1 and "![c.png](" in out


def test_member_attaches_a_screenshot_from_the_hermes_cache():
    from gateway.platforms import base

    shot = _old_file(base._HERMES_HOME / "cache" / "screenshots" / "shot.png", PNG)
    out, storage = _rewrite_as(MIA, f"MEDIA:{shot}")
    assert out.startswith("![shot.png](/api/chat/media?path=mia%2Ffiles%2F")
    assert len(storage.uploads) == 1


def test_a_link_label_escapes_what_would_end_it():
    from hermes_cli.agent_home_media import _label

    assert _label("[Q4](final copy).pdf") == "\\[Q4\\]\\(final copy\\).pdf"
    assert _label("a\\b.txt") == "a\\\\b.txt"
