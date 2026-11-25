"""Nightly drift sweep over the coverage ledger (semantic-layer plan, Layer 3).

The ledger (``ledger.py``) knows every control the agent has seen and whether
it carried a hint. This sweep turns its current picture into one owner-facing
Needs-You card listing what is still unexplained:

* **controls without a hint** — the ``data-appmcp-hint`` lines to draft, per page;
* **pages without a guide** — routes seen in snapshots that ``help_for`` cannot
  answer, i.e. the ``HELP`` entries to draft.

The card dedupes on the gap set itself, so a night with nothing new collapses
onto the pending card, and fixing (or adding) a gap raises a fresh one.

Run by ``deploy/hermes-appmcp-hint-sweep.timer``:
``python -m app_mcp.sweep --deliver``. Without ``--deliver`` it only prints.
Delivery imports ``hermes_cli`` lazily — present in the hermes-agent venv the
service runs from, absent from app-mcp's own test env, which never delivers.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from .help import help_for
from .ledger import ledger_path, load

MAX_LINES = 40
DEDUPE_PREFIX = "app-mcp-hint-gaps:"


@dataclass
class SweepReport:
    #: page → sorted ``(role, name)`` pairs last seen without a hint.
    unhinted: dict[str, list[tuple[str, str]]] = field(default_factory=dict)
    #: pages observed in snapshots that have no page guide.
    unguided: list[str] = field(default_factory=list)

    @property
    def gap_count(self) -> int:
        return sum(len(v) for v in self.unhinted.values()) + len(self.unguided)

    @property
    def dedupe_key(self) -> str:
        payload = json.dumps(
            {"unhinted": sorted(self.unhinted.items()), "unguided": self.unguided},
            sort_keys=True,
        )
        return DEDUPE_PREFIX + hashlib.sha256(payload.encode()).hexdigest()[:16]


def sweep(rows: Iterable[dict[str, Any]]) -> SweepReport:
    """Fold the ledger's latest rows into the gaps a human should close."""
    report = SweepReport()
    pages: set[str] = set()
    for row in rows:
        page, role, name = row.get("page"), row.get("role"), row.get("name")
        if not (page and role and name):
            continue
        pages.add(page)
        if not row.get("hinted"):
            report.unhinted.setdefault(page, []).append((role, name))
    for gaps in report.unhinted.values():
        gaps.sort()
    report.unhinted = dict(sorted(report.unhinted.items()))
    report.unguided = sorted(p for p in pages if help_for(p) is None)
    return report


def render(report: SweepReport) -> tuple[str, list[str]]:
    """Card title and body lines; the body is capped at ``MAX_LINES``."""
    controls = sum(len(v) for v in report.unhinted.values())
    title = f"app-mcp: {controls} control(s) without a hint"
    if report.unguided:
        title += f", {len(report.unguided)} page(s) without a guide"
    lines: list[str] = []
    for page in report.unguided:
        lines.append(f"{page}: no page guide — add a HELP entry in app-mcp/app_mcp/help.py")
    for page, gaps in report.unhinted.items():
        for role, name in gaps:
            lines.append(f'{page}: {role} "{name}" — add data-appmcp-hint="<what it does>"')
    if len(lines) > MAX_LINES:
        rest = len(lines) - MAX_LINES + 1
        lines = lines[: MAX_LINES - 1] + [f"…and {rest} more (python -m app_mcp.sweep)"]
    lines.append(
        "Hints are English agent metadata on the control itself; lower "
        "hint-ratchet.baseline.json in the same PR."
    )
    return title, lines


async def deliver(report: SweepReport, config: dict | None = None) -> Any:
    """Raise the report as a deduped ``proactive_ask`` for the box owner."""
    from hermes_cli.access import PrincipalStore
    from hermes_cli.datastore import get_store
    from hermes_cli.human_comms import NotificationStore

    app_store = get_store("supabase-app", "prod", config=config)
    owner = await PrincipalStore(app_store).get_owner()
    if owner is None:
        raise RuntimeError("no owner is enrolled yet")
    notifications = NotificationStore(app_store, config=config)
    await notifications.initialize()
    title, lines = render(report)
    return await notifications.create(
        kind="proactive_ask",
        target_user_id=owner.user_id,
        title=title,
        body="\n".join(lines),
        reversible=False,
        dedupe_key=report.dedupe_key,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app_mcp.sweep", description=__doc__.splitlines()[0])
    parser.add_argument("--ledger", type=Path, help="ledger file (default: $HERMES_HOME/app-mcp/…)")
    parser.add_argument("--deliver", action="store_true", help="raise a Needs-You card for the owner")
    args = parser.parse_args(argv)
    path = args.ledger or ledger_path()
    if path is None:
        print("app-mcp sweep: HERMES_HOME is not set and no --ledger given", file=sys.stderr)
        return 2
    report = sweep(load(path).values())
    title, lines = render(report)
    print(title)
    for line in lines[:-1]:
        print(f"  {line}")
    if not (args.deliver and report.gap_count):
        return 0
    from hermes_cli.config import load_config
    from hermes_cli.env_loader import load_hermes_dotenv

    # config.yaml names the app datastore as ${DATABASE_URL}; like every hermes
    # entry point, read it from $HERMES_HOME/.env, whatever the box's unit env holds.
    load_hermes_dotenv()
    try:
        result = asyncio.run(deliver(report, load_config() or {}))
    except RuntimeError as exc:
        print(f"app-mcp sweep: not delivered: {exc}", file=sys.stderr)
        return 1
    print("Raised a Needs-You card." if getattr(result, "created", True) else "Card already pending.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
