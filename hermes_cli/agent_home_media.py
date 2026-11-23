"""Deliver files the agent names in an agent-home reply (``MEDIA:/abs/path``).

Gateway platforms turn a ``MEDIA:/abs/path`` tag into a native attachment.
agent-home has no attachment channel for assistant replies, so the agent used
to fall back to links the browser cannot open (the dashboard's
``/api/files/download``, behind a different login). Here each tag in the final
reply is uploaded into the turn principal's Files (``store_and_register``,
surface ``agent_home``) and replaced with the private-bucket reference
agent-home's chat renders: ``![name](/api/chat/media?path=<key>)`` for images,
``[name](/api/chat/media?path=<key>)`` for anything else — the exact shape of
``mediaRef()`` in ``agent-home/src/lib/chat/media-ref.ts``.

A tag that cannot be delivered becomes a short plain-text note (file name +
reason). Nothing here raises: a file is never a reason to fail the turn.
"""

from __future__ import annotations

import logging
import mimetypes
import os
import re
from dataclasses import dataclass, field
from typing import Any, Optional
from urllib.parse import quote

log = logging.getLogger(__name__)

#: agent-home's media read route (``MEDIA_ROUTE`` in media-ref.ts).
MEDIA_ROUTE = "/api/chat/media"

#: Shown inline; everything else is a link.
IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"})

#: Bound on uploads per reply, so one runaway answer can't fill a bucket.
MAX_FILES_PER_REPLY = 20

# Characters ``encodeURIComponent`` leaves alone.
_URI_COMPONENT_SAFE = "-_.!~*'()"


def media_ref(key: str) -> str:
    """``mediaRef(key)`` from media-ref.ts, byte for byte."""
    return f"{MEDIA_ROUTE}?path={quote(key, safe=_URI_COMPONENT_SAFE)}"


def _label(name: str) -> str:
    """A file name made safe for Markdown link/alt text."""
    flat = " ".join(name.split()) or "file"
    return flat.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _note(name: str, reason: str) -> str:
    return f"({' '.join(name.split()) or 'file'}: not attached, {reason})"


@dataclass
class _Uploader:
    principal: Any
    conversation: Optional[str]
    message_id: Optional[str]
    storage: Any = None
    registry: Any = None
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
        if self.registry is None:
            try:
                from hermes_cli.file_registry import default_registry

                self.registry = default_registry()
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

    async def _deliver(self, raw_path: str) -> str:
        from gateway.platforms.base import (
            MEDIA_DELIVERY_EXTS,
            validate_media_delivery_path,
        )
        from hermes_cli.file_registry import MAX_REGISTER_BYTES, store_and_register

        path = os.path.expanduser(raw_path)
        name = os.path.basename(path.rstrip("/")) or "file"
        ext = os.path.splitext(name)[1].lower()
        if ext not in MEDIA_DELIVERY_EXTS:
            return _note(name, "unsupported file type")
        if not os.path.isabs(path):
            return _note(name, "path is not absolute")
        if os.path.islink(path):
            return _note(name, "symbolic links are not shared")
        if not os.path.isfile(path):
            return _note(name, "file not found")
        safe = validate_media_delivery_path(path)
        if not safe:
            return _note(name, "file is outside the folders the app can share")
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
        if self.principal is None or not getattr(self.principal, "user_id", None):
            return _note(name, "no signed-in user to store it for")
        failure = await self._prepare()
        if failure:
            return _note(name, failure)
        try:
            fd = os.open(safe, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "rb") as handle:
                data = handle.read(MAX_REGISTER_BYTES + 1)
        except OSError:
            return _note(name, "file could not be read")
        if len(data) > MAX_REGISTER_BYTES:
            return _note(name, "file is too large")
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
) -> tuple[str, list[tuple[str, str]]]:
    """Upload every ``MEDIA:`` tag in *content* and replace it.

    Returns ``(rewritten, edits)`` where *edits* lists ``(tag_text,
    replacement)`` in order, so the same rewrite can be applied to the stored
    copy of the reply. Tags inside code spans/blocks and quotes are examples,
    not deliveries, and are left alone (the gateway's own masking).
    """
    if not content or "MEDIA:" not in content:
        return content, []
    from gateway.platforms.base import (
        MEDIA_TAG_CLEANUP_RE,
        BasePlatformAdapter,
        _MEDIA_EXT_ALTERNATION,
        _normalize_media_tag_path,
    )

    scan = BasePlatformAdapter._mask_protected_spans(content)
    scan = BasePlatformAdapter._mask_json_string_media(scan)
    # The shared tag regex lets an unquoted path contain spaces, so it can run
    # on past the file ("MEDIA:/a/c.png and MEDIA:/a/d.csv" is one match).
    # Cut such a match at the first extension that names an existing file.
    ext_end = re.compile(
        r"\.(?:" + _MEDIA_EXT_ALTERNATION + r")(?=[\s`\"',;:)\]}]|$)", re.IGNORECASE
    )
    uploader = _Uploader(
        principal, conversation, message_id, storage=storage, registry=registry
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
