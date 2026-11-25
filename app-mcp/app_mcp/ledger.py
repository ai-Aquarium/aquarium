"""Coverage ledger: which interactive elements the agent has seen, hinted or not.

Every app-mcp snapshot is folded into an append-only JSON-lines file,
``coverage-ledger.jsonl``, keyed by
``(page, role, name)``. A row is appended only when a key is new or its
``hinted`` state flips, so the file grows with the UI, not with traffic.
Reading it back (``load``) folds the rows into the current picture — the
input for the drift sweep that drafts missing ``data-appmcp-hint`` lines
(plans/2026-11-25-app-mcp-semantic-layer.md, Layer 3).

It lives in systemd's ``StateDirectory=app-mcp`` (``$STATE_DIRECTORY``, the one
folder ``ProtectSystem=strict`` leaves writable, same path on every box) and
otherwise under ``$HERMES_HOME/app-mcp/``.

Best-effort by design: no folder means no ledger, and an I/O error
never reaches the tool that took the snapshot.
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Iterable

from .pages import page_template

log = logging.getLogger("app-mcp")

LEDGER_NAME = "coverage-ledger.jsonl"
NAME_LIMIT = 80
MAX_KEYS = 5000

Key = tuple[str, str, str]


def ledger_path(hermes_home: str | None = None) -> Path | None:
    if hermes_home is None:
        state = os.environ.get("STATE_DIRECTORY", "").split(":")[0]
        if state:
            return Path(state) / LEDGER_NAME
        hermes_home = os.environ.get("HERMES_HOME", "")
    return Path(hermes_home) / "app-mcp" / LEDGER_NAME if hermes_home else None


def _clip(text: Any) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= NAME_LIMIT else flat[: NAME_LIMIT - 1] + "…"


def load(path: Path) -> dict[Key, dict[str, Any]]:
    """The latest row per ``(page, role, name)``; unreadable lines are skipped."""
    rows: dict[Key, dict[str, Any]] = {}
    try:
        with path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                    rows[(row["page"], row["role"], row["name"])] = row
                except (ValueError, KeyError, TypeError):
                    continue
    except FileNotFoundError:
        pass
    return rows


class CoverageLedger:
    def __init__(self, path: Path | None, max_keys: int = MAX_KEYS):
        self.path = path
        self.max_keys = max_keys
        self._rows: dict[Key, dict[str, Any]] | None = None

    def _state(self) -> dict[Key, dict[str, Any]]:
        if self._rows is None:
            self._rows = load(self.path) if self.path else {}
        return self._rows

    def observe(self, page: str | None, elements: Iterable[dict[str, Any]]) -> int:
        """Fold one snapshot in; returns how many rows were appended."""
        if self.path is None or not page:
            return 0
        try:
            return self._observe(page_template(page), elements)
        except (OSError, ValueError) as err:
            log.debug("app-mcp: coverage ledger write failed: %s", err)
            return 0

    def _observe(self, page: str, elements: Iterable[dict[str, Any]]) -> int:
        assert self.path is not None
        # Controls sharing (role, name) on a page are one key: hinted only if
        # every instance is, so a lone unhinted twin stays a gap without the
        # key flipping on every snapshot.
        seen: dict[Key, bool] = {}
        for entry in elements:
            role, name = _clip(entry.get("role")), _clip(entry.get("name"))
            if role and name:
                key = (page, role, name)
                seen[key] = seen.get(key, True) and bool(entry.get("hint"))
        state = self._state()
        fresh: list[dict[str, Any]] = []
        for (page_, role, name), hinted in seen.items():
            known = state.get((page_, role, name))
            if known is not None and known.get("hinted") == hinted:
                continue
            if known is None and len(state) + len(fresh) >= self.max_keys:
                continue
            fresh.append({"ts": int(time.time()), "page": page_, "role": role, "name": name,
                          "hinted": hinted})
        if fresh:
            text = "".join(json.dumps(r) + "\n" for r in fresh)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as fh:
                fh.write(text)
            for r in fresh:
                state[(r["page"], r["role"], r["name"])] = r
        return len(fresh)

    def gaps(self) -> list[dict[str, Any]]:
        """Elements last seen without a hint — what the sweep would draft."""
        return [row for row in self._state().values() if not row.get("hinted")]
