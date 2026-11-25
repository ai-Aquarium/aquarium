"""Coverage ledger: which interactive elements the agent has seen, hinted or not.

Every app-mcp snapshot is folded into an append-only JSON-lines file under
``$HERMES_HOME/app-mcp/coverage-ledger.jsonl``, keyed by
``(page, role, name)``. A row is appended only when a key is new or its
``hinted`` state flips, so the file grows with the UI, not with traffic.
Reading it back (``load``) folds the rows into the current picture — the
input for the drift sweep that drafts missing ``data-appmcp-hint`` lines
(plans/2026-11-25-app-mcp-semantic-layer.md, Layer 3).

Best-effort by design: no ``HERMES_HOME`` means no ledger, and an I/O error
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
    home = hermes_home if hermes_home is not None else os.environ.get("HERMES_HOME", "")
    return Path(home) / "app-mcp" / LEDGER_NAME if home else None


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
        except OSError as err:
            log.debug("app-mcp: coverage ledger write failed: %s", err)
            return 0

    def _observe(self, page: str, elements: Iterable[dict[str, Any]]) -> int:
        assert self.path is not None
        state = self._state()
        fresh: list[dict[str, Any]] = []
        for entry in elements:
            role, name = _clip(entry.get("role")), _clip(entry.get("name"))
            if not role or not name:
                continue
            key = (page, role, name)
            hinted = bool(entry.get("hint"))
            known = state.get(key)
            if known is not None and known.get("hinted") == hinted:
                continue
            if known is None and len(state) >= self.max_keys:
                continue
            row = {"ts": int(time.time()), "page": page, "role": role, "name": name,
                   "hinted": hinted, "section": _clip(entry.get("section")) or None}
            state[key] = row
            fresh.append(row)
        if fresh:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            with os.fdopen(fd, "a", encoding="utf-8") as fh:
                fh.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in fresh)
        return len(fresh)

    def gaps(self) -> list[dict[str, Any]]:
        """Elements last seen without a hint — what the sweep would draft."""
        return [row for row in self._state().values() if not row.get("hinted")]
