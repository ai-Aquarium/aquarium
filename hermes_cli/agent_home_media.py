"""Deliver files the agent names in an agent-home reply (``MEDIA:/abs/path``).

Gateway platforms turn a ``MEDIA:/abs/path`` tag into a native attachment.
agent-home has no attachment channel for assistant replies, so the agent used
to fall back to links the browser cannot open (the dashboard's
``/api/files/download``, behind a different login). Here each tag in the final
reply is uploaded into the turn principal's Files (``store_and_register``,
surface ``agent_home``) and replaced with the private-bucket reference
agent-home's chat renders: ``![name](/api/chat/media?path=<key>)`` for images,
``[name](/view/<file id>)`` for HTML pages (an interactive chart opens in the
app's isolated viewer, the same one Files uses), and
``[name](/api/chat/media?path=<key>)`` for anything else — the exact shape of
``mediaRef()`` in ``agent-home/src/lib/chat/media-ref.ts``.

A tag that cannot be delivered becomes a short plain-text note (file name +
reason). Nothing here raises: a file is never a reason to fail the turn.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import mimetypes
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, ContextManager, Optional, Union
from urllib.parse import quote

log = logging.getLogger(__name__)

#: agent-home's media read route (``MEDIA_ROUTE`` in media-ref.ts).
MEDIA_ROUTE = "/api/chat/media"

#: Shown inline; everything else is a link.
IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"})

#: Opened in agent-home's isolated HTML viewer (``viewerHref()`` in
#: agent-home/src/lib/nav/viewer-back.ts), where its script may run.
HTML_EXTS = frozenset({".html", ".htm"})
VIEW_ROUTE = "/view"

#: Bound on uploads per reply, so one runaway answer can't fill a bucket.
MAX_FILES_PER_REPLY = 20

# Characters ``encodeURIComponent`` leaves alone.
_URI_COMPONENT_SAFE = "-_.!~*'()"


def media_ref(key: str) -> str:
    """``mediaRef(key)`` from media-ref.ts, byte for byte."""
    return f"{MEDIA_ROUTE}?path={quote(key, safe=_URI_COMPONENT_SAFE)}"


def viewer_ref(file_id: str) -> str:
    """``viewerHref(id)`` from viewer-back.ts, byte for byte."""
    return f"{VIEW_ROUTE}/{quote(str(file_id), safe=_URI_COMPONENT_SAFE)}"


_FENCE_OPEN = re.compile(r"^ {0,3}(`{3,}|~{3,})[^\n]*$", re.MULTILINE)


def _mask_fences(content: str) -> str:
    """Blank fenced code blocks the CommonMark way, keeping offsets.

    A fence closes only at a line of the same character at least as long as
    its opener, so a ``````skill-draft`````` block holding a nested ```` ``` ````
    example stays one block (the gateway's masker pairs any two ```` ``` ````).
    Used together with the gateway's masker (:func:`_protected_scan`), which
    covers same-length nesting that CommonMark would close early.
    """
    chars = list(content)
    pos = 0
    while True:
        opener = _FENCE_OPEN.search(content, pos)
        if opener is None:
            break
        fence = opener.group(1)
        if fence[0] == "`" and "`" in content[opener.end(1):opener.end()]:
            pos = opener.end()  # backticks in the info string: not a fence
            continue
        closer = re.compile(
            r"^ {0,3}" + re.escape(fence[0]) + "{%d,}[ \t]*\r?$" % len(fence), re.MULTILINE
        ).search(content, opener.end())
        if closer is None:
            pos = opener.end()  # unclosed: leave it to the gateway's masker
            continue
        end = closer.end()
        for i in range(opener.start(), end):
            if chars[i] != "\n":
                chars[i] = " "
        pos = end
    return "".join(chars)


def _protected_scan(content: str) -> str:
    """*content* with every span either masker treats as code blanked."""
    from gateway.platforms.base import BasePlatformAdapter

    gateway = BasePlatformAdapter._mask_protected_spans(content)
    fences = _mask_fences(content)
    scan = "".join(
        " " if (g == " " or f == " ") and c != "\n" else c
        for c, g, f in zip(content, gateway, fences)
    )
    return BasePlatformAdapter._mask_json_string_media(scan)


def _in_managed_root(path: str) -> bool:
    """True for Hermes caches and operator allow dirs (screenshots, exports ...).

    The gateway trusts these unconditionally; tools such as browser_vision
    write there on a member's behalf, outside the member's own folder.
    """
    from gateway.platforms.base import _media_delivery_allowed_roots, _path_is_within

    for root in _media_delivery_allowed_roots():
        try:
            if _path_is_within(Path(path), root.expanduser().resolve(strict=False)):
                return True
        except (OSError, RuntimeError, ValueError):
            continue
    return False


def _label(name: str) -> str:
    """A file name made safe for Markdown link/alt text."""
    flat = " ".join(name.split()) or "file"
    return re.sub(r"([\\\[\]()])", r"\\\1", flat)


def _note(name: str, reason: str) -> str:
    return f"({' '.join(name.split()) or 'file'}: not attached, {reason})"


@dataclass
class _Uploader:
    principal: Any
    conversation: Optional[str]
    message_id: Optional[str]
    storage: Any = None
    registry: Any = None
    file_scope: Optional[Callable[[], ContextManager[Any]]] = None
    _ready: Optional[str] = None  # None = not tried, "" = ok, else the failure note
    _done: dict = field(default_factory=dict)

    async def _prepare(self) -> str:
        if self._ready is not None:
            return self._ready
        if self.storage is None:
            from hermes_cli.filestore import SupabaseStorage, StorageNotConfigured

            try:
                self.storage = SupabaseStorage.from_env()
            except StorageNotConfigured:
                self._ready = "file storage is not configured"
                return self._ready
        try:
            if self.registry is None:
                from hermes_cli.file_registry import default_registry

                self.registry = default_registry()
            if hasattr(self.registry, "initialize"):
                # Same once-per-schema setup as a browser upload, so the first
                # file on a fresh install isn't uploaded and then unregistrable.
                from hermes_cli.files_api import _initialize_once

                await _initialize_once(self.registry)
        except Exception as exc:  # noqa: BLE001 - reported as a note
            log.warning("agent-home media: file registry unavailable (%s)", exc)
            self._ready = "the file registry is unavailable"
            return self._ready
        self._ready = ""
        return self._ready

    async def deliver(self, raw_path: str) -> str:
        if raw_path in self._done:
            return self._done[raw_path]
        out = await self._deliver(raw_path)
        self._done[raw_path] = out
        return out

    def _read(self, raw_path: str) -> Union[str, bytes]:
        """The file's bytes, or the note saying why it can't be shared.

        Checked as the turn's person in the turn's profile — the same folder
        rules their own file tools get — so a reply can't attach a file that
        person couldn't open.
        """
        from tools.access_policy import acting_as, check_file_access

        role = getattr(self.principal, "role", None)
        with contextlib.ExitStack() as stack:
            if self.file_scope is not None:
                stack.enter_context(self.file_scope())
            stack.enter_context(acting_as(self.principal.user_id, str(role) if role else None))
            return self._check_and_read(raw_path, check_file_access)

    @staticmethod
    def _check_and_read(raw_path: str, check_file_access) -> Union[str, bytes]:
        from gateway.platforms.base import validate_media_delivery_path
        from hermes_cli.file_registry import MAX_REGISTER_BYTES

        path = os.path.expanduser(raw_path)
        name = os.path.basename(path.rstrip("/")) or "file"
        if not os.path.isabs(path):
            return _note(name, "path is not absolute")
        if os.path.islink(path):
            return _note(name, "symbolic links are not shared")
        if not os.path.isfile(path):
            return _note(name, "file not found")
        safe = validate_media_delivery_path(path)
        if not safe:
            return _note(name, "file is outside the folders the app can share")
        if not _in_managed_root(safe) and check_file_access(Path(safe)):
            return _note(name, "file is outside your own folder")
        try:
            size = os.stat(safe).st_size
        except OSError:
            return _note(name, "file not found")
        if size <= 0:
            return _note(name, "file is empty")
        if size > MAX_REGISTER_BYTES:
            return _note(
                name,
                f"file is too large ({size / (1024 * 1024):.1f} MB, "
                f"limit {MAX_REGISTER_BYTES // (1024 * 1024)} MB)",
            )
        try:
            fd = os.open(safe, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as handle:
                data = handle.read(MAX_REGISTER_BYTES + 1)
        except OSError:
            return _note(name, "file could not be read")
        if len(data) > MAX_REGISTER_BYTES:
            return _note(name, "file is too large")
        return data

    async def _deliver(self, raw_path: str) -> str:
        from gateway.platforms.base import MEDIA_DELIVERY_EXTS
        from hermes_cli.file_registry import store_and_register

        name = os.path.basename(os.path.expanduser(raw_path).rstrip("/")) or "file"
        ext = os.path.splitext(name)[1].lower()
        if ext not in MEDIA_DELIVERY_EXTS:
            return _note(name, "unsupported file type")
        if self.principal is None or not getattr(self.principal, "user_id", None):
            return _note(name, "no signed-in user to store it for")
        data = await asyncio.to_thread(self._read, raw_path)
        if isinstance(data, str):
            return data
        failure = await self._prepare()
        if failure:
            return _note(name, failure)
        content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
        asset = await store_and_register(
            self.principal,
            data,
            surface="agent_home",
            filename=name,
            content_type=content_type,
            conversation=self.conversation,
            sender_id=self.principal.user_id,
            sender_name=getattr(self.principal, "display", None) or self.principal.user_id,
            message_id=self.message_id,
            registry=self.registry,
            storage=self.storage,
        )
        if asset is None:
            return _note(name, "upload failed")
        file_id = getattr(asset, "id", None)
        if ext in HTML_EXTS and file_id:
            return f"[{_label(name)}]({viewer_ref(file_id)})"
        ref = media_ref(asset.storage_path)
        if ext in IMAGE_EXTS:
            return f"![{_label(name)}]({ref})"
        return f"[{_label(name)}]({ref})"


async def rewrite_media_tags(
    content: str,
    principal: Any,
    *,
    conversation: Optional[str] = None,
    message_id: Optional[str] = None,
    storage: Any = None,
    registry: Any = None,
    file_scope: Optional[Callable[[], ContextManager[Any]]] = None,
) -> tuple[str, list[tuple[str, str]]]:
    """Upload every ``MEDIA:`` tag in *content* and replace it.

    Returns ``(rewritten, edits)`` where *edits* lists ``(tag_text,
    replacement)`` in order, so the same rewrite can be applied to the stored
    copy of the reply. Tags inside code spans/blocks and quotes are examples,
    not deliveries, and are left alone. *file_scope* (e.g. the turn's
    profile scope) is entered around every file check and read.
    """
    if not content or "MEDIA:" not in content:
        return content, []
    from gateway.platforms.base import (
        MEDIA_TAG_CLEANUP_RE,
        BasePlatformAdapter,
        _MEDIA_EXT_ALTERNATION,
        _normalize_media_tag_path,
    )

    scan = _protected_scan(content)
    # The shared tag regex lets an unquoted path contain spaces, so it can run
    # on past the file ("MEDIA:/a/c.png and MEDIA:/a/d.csv" is one match).
    # Cut such a match at the first extension that names an existing file.
    ext_end = re.compile(
        r"\.(?:" + _MEDIA_EXT_ALTERNATION + r")(?=[\s`\"',;:)\]}]|$)", re.IGNORECASE
    )
    uploader = _Uploader(
        principal,
        conversation,
        message_id,
        storage=storage,
        registry=registry,
        file_scope=file_scope,
    )
    pieces: list[str] = []
    edits: list[tuple[str, str]] = []
    cursor = 0
    while True:
        match = MEDIA_TAG_CLEANUP_RE.search(scan, cursor)
        if match is None:
            break
        start, end = match.start(), match.end()
        path_start, path_end = match.start("path"), match.end("path")
        span = content[path_start:path_end]
        if span[:1] not in "`\"'" and any(ch.isspace() for ch in span):
            cuts = [m.end() for m in ext_end.finditer(scan, path_start, path_end)]
            pick = next(
                (c for c in cuts if os.path.lexists(os.path.expanduser(content[path_start:c]))),
                cuts[0] if cuts else path_end,
            )
            if pick != path_end:
                path_end = end = pick
        tag = content[start:end]
        raw = _normalize_media_tag_path(content[path_start:path_end])
        name = os.path.basename(raw.rstrip("/")) or "file"
        try:
            if len(edits) >= MAX_FILES_PER_REPLY:
                replacement = _note(name, "too many files in one reply")
            else:
                replacement = await uploader.deliver(raw)
        except Exception as exc:  # noqa: BLE001 - never fail the turn
            log.warning("agent-home media: could not deliver %r (%s)", name, exc)
            replacement = _note(name, "upload failed")
        pieces.append(content[cursor:start])
        pieces.append(replacement)
        edits.append((tag, replacement))
        cursor = end
    if not edits:
        return content, []
    pieces.append(content[cursor:])
    return "".join(pieces), edits


def persist_rewrite(
    db: Any, session_id: str, original: str, rewritten: str, edits: list[tuple[str, str]]
) -> bool:
    """Store *rewritten* over the persisted final assistant reply.

    The final reply is the last assistant row with text. It normally equals
    *original*; when the stored copy differs slightly the per-tag *edits* are
    applied to it instead. Returns whether a row was updated.
    """
    if not edits or rewritten == original:
        return False
    for message in reversed(db.get_messages(session_id)):
        if message.get("role") != "assistant":
            continue
        stored = message.get("content")
        if not isinstance(stored, str) or not stored.strip():
            continue
        if stored == original:
            return db.update_message_content(message["id"], rewritten)
        if all(tag in stored for tag, _ in edits):
            for tag, replacement in edits:
                stored = stored.replace(tag, replacement, 1)
            return db.update_message_content(message["id"], stored)
        return False
    return False


def read_shareable_file(raw_path: str) -> Union[str, bytes]:
    """The bytes of a file the bound person may share, or a note saying why not.

    The same checks as a ``MEDIA:`` tag in a reply (absolute, no symlink, a
    folder the app shares, the person's own folder, size cap), for tools that
    send a file somewhere else, such as an email attachment.
    """
    from tools.access_policy import check_file_access

    return _Uploader._check_and_read(raw_path, check_file_access)
