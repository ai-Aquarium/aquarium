"""Compression advisories — evidence-backed config proposals, never edits.

The agent corrects its own *facts* silently (the ``model@base_url`` context
length cache in ``agent.model_metadata``), but it never writes
``config.yaml``. When the per-turn compression ledger or the context-length
learning log shows the configured policy misbehaving, this module turns the
evidence into a Needs-You card with a concrete suggested value and its
expected effect. Applying it is always an owner action.

Inputs (both under ``HERMES_HOME``, bounded):

* ``compression_turns.jsonl`` — one row per agent turn, written by
  :func:`record_turn` from ``gateway.session_chat`` (the same fields the
  ``session-turn-timing`` / ``[agent-home] turn-timing`` lines carry).
* ``context_length_events.jsonl`` — up/down context-length learning events
  (``agent.model_metadata.record_context_length_event``).

Run by ``hermes compression advise`` (``deploy/hermes-compression-advise.timer``).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

#: §4 trigger 1 — a turn that spent longer than this compressing, or ran more
#: passes than this, is pathological.
SLOW_COMPRESS_MS = 60_000
MAX_HEALTHY_PASSES = 3

_TURNS_KEEP = 500
DEDUPE_PREFIX = "compression-advisory"


def _turns_path() -> Path:
    from hermes_constants import get_hermes_home

    return get_hermes_home() / "compression_turns.jsonl"


def record_turn(session_id: str, stats: Dict[str, Any], *, now: Optional[float] = None) -> None:
    """Append one turn's compression ledger row. Never raises.

    Only turns that compressed at all are kept — the scan has nothing to say
    about the rest, and the file stays small.
    """
    if not stats or not stats.get("compress_passes"):
        return
    row = {"ts": now if now is not None else time.time(), "session": session_id or "", **stats}
    path = _turns_path()
    try:
        lines: List[str] = []
        if path.exists():
            lines = path.read_text(encoding="utf-8").splitlines()
        lines.append(json.dumps(row, sort_keys=True))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(lines[-_TURNS_KEEP:]) + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001 - observability must not fail a turn
        logger.debug("compression ledger write failed: %s", exc)


def load_turns() -> List[Dict[str, Any]]:
    path = _turns_path()
    if not path.exists():
        return []
    out: List[Dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            out.append(item)
    return out


@dataclass
class Advisory:
    """One proposed config change with the evidence behind it."""

    kind: str  # "pathological" | "floor_dominates" | "flapping"
    key: str  # what the advisory is about (model@base_url or session)
    title: str
    body: str
    suggested: Dict[str, Any] = field(default_factory=dict)

    @property
    def dedupe_key(self) -> str:
        return f"{DEDUPE_PREFIX}:{self.kind}:{self.key}"


def suggest_threshold(context_length: int, floor: int) -> float:
    """A ``compression.threshold`` whose trigger is no longer pinned by the floor.

    Rounded up to a 0.05 step and kept within [0.5, 0.85] — the band where a
    percentage still leaves room for the summary and the response.
    """
    if context_length <= 0:
        return 0.5
    raw = max(0.5, floor / context_length)
    return min(0.85, math.ceil(raw * 20 - 1e-9) / 20)


def _fmt_k(tokens: int) -> str:
    return f"{int(round(tokens / 1000))}K"


def _effect(context_length: int, pct: float, floor: int) -> str:
    trigger = max(int(context_length * pct), floor)
    return f"compression.threshold: {pct:g} → trigger ≈{_fmt_k(trigger)} on the {_fmt_k(context_length)} window"


def scan(
    turns: Iterable[Dict[str, Any]],
    events: Iterable[Dict[str, Any]],
    *,
    threshold_percent: float,
    floor: Optional[int] = None,
) -> List[Advisory]:
    """Turn the ledgers into advisories. Pure: reads nothing, writes nothing."""
    if floor is None:
        from agent.model_metadata import MINIMUM_CONTEXT_LENGTH

        floor = MINIMUM_CONTEXT_LENGTH
    out: List[Advisory] = []

    # 1. Pathological compression — worst offending turn per session.
    worst: Dict[str, Dict[str, Any]] = {}
    for t in turns:
        ms = int(t.get("compress_ms") or 0)
        passes = int(t.get("compress_passes") or 0)
        if ms <= SLOW_COMPRESS_MS and passes <= MAX_HEALTHY_PASSES:
            continue
        sid = str(t.get("session") or "")
        prev = worst.get(sid)
        if prev is None or ms > int(prev.get("compress_ms") or 0):
            worst[sid] = t
    for sid, t in worst.items():
        ctx = int(t.get("ctx") or 0)
        trigger = int(t.get("trigger") or 0)
        ms = int(t.get("compress_ms") or 0)
        passes = int(t.get("compress_passes") or 0)
        lines = [
            f"One turn spent {ms / 1000:.0f}s compressing over {passes} pass(es) "
            f"({int(t.get('compress_ineffective') or 0)} ineffective) — "
            f"effective trigger {_fmt_k(trigger)} on a {_fmt_k(ctx)} window.",
        ]
        suggested: Dict[str, Any] = {}
        if ctx and trigger and trigger <= floor and ctx * threshold_percent < floor:
            pct = suggest_threshold(ctx, floor)
            suggested = {"compression.threshold": pct}
            lines.append(
                f"The {_fmt_k(floor)} floor dominates compression.threshold: "
                f"{threshold_percent:g} ({_fmt_k(int(ctx * threshold_percent))}). "
                f"Consider {_effect(ctx, pct, floor)}, or accept the policy as-is."
            )
        else:
            lines.append(
                "Consider raising compression.threshold so the trigger sits further "
                "from the conversation's steady-state size, or accept the policy as-is."
            )
        lines.append("Nothing was changed; config.yaml is yours to edit.")
        out.append(Advisory(
            kind="pathological",
            key=sid or "unknown",
            title="Compression is slowing turns down",
            body="\n".join(lines),
            suggested=suggested,
        ))

    # 2. Floor silently overrides intent, and 3. learned-window flapping.
    by_key: Dict[str, List[Dict[str, Any]]] = {}
    for e in events:
        by_key.setdefault(str(e.get("key") or ""), []).append(e)
    for key, evs in by_key.items():
        evs = sorted(evs, key=lambda e: float(e.get("ts") or 0))
        ups = [e for e in evs if e.get("direction") == "up"]
        if ups:
            learned = int(ups[-1].get("new") or 0)
            if learned and learned * threshold_percent < floor:
                pct = suggest_threshold(learned, floor)
                out.append(Advisory(
                    kind="floor_dominates",
                    key=key,
                    title="compression.threshold has no effect on this model",
                    body=(
                        f"{key} was learned to accept {_fmt_k(learned)} tokens, but "
                        f"compression.threshold: {threshold_percent:g} gives "
                        f"{_fmt_k(int(learned * threshold_percent))} — under the "
                        f"{_fmt_k(floor)} floor, so the floor sets the trigger and the "
                        f"percentage is ignored. Consider {_effect(learned, pct, floor)}.\n"
                        "Nothing was changed; config.yaml is yours to edit."
                    ),
                    suggested={"compression.threshold": pct},
                ))
        flap = None
        for i, up in enumerate(evs):
            if up.get("direction") != "up":
                continue
            down = next((d for d in evs[i + 1:] if d.get("direction") == "down"), None)
            if down is not None:
                flap = (up, down)
        if flap:
            up, down = flap
            pinned = int(down.get("new") or 0)
            model = key.split("@", 1)[0]
            out.append(Advisory(
                kind="flapping",
                key=key,
                title="This model's context window keeps changing",
                body=(
                    f"{key} was learned up to {_fmt_k(int(up.get('new') or 0))}, then "
                    f"a provider error learned it down to {_fmt_k(pinned)}. The serving "
                    "window is unstable or the probe tiers disagree with it. Consider "
                    f"pinning model.context_length: {pinned} for {model} — an explicit "
                    "value disables learning for it.\n"
                    "Nothing was changed; config.yaml is yours to edit."
                ),
                suggested={"model.context_length": pinned},
            ))
    return out


Notifier = Callable[[str, Advisory], Awaitable[Any]]


async def deliver(advisories: List[Advisory], user_id: str, notify: Notifier) -> int:
    """Raise each advisory as a Needs-You card and Web-Push the new ones.

    ``notify(user_id, advisory)`` creates the pending notification (deduped
    on :attr:`Advisory.dedupe_key`) and returns its ``CreateResult``.
    """
    from hermes_cli import needs_you

    created = []
    for adv in advisories:
        try:
            result = await notify(user_id, adv)
        except Exception as exc:  # noqa: BLE001 - one card is not the scan
            logger.warning("compression advisory %s not delivered: %s", adv.dedupe_key, exc)
            continue
        if getattr(result, "created", False) and getattr(result, "deliver_now", True):
            created.append(result.notification)
    if created:
        await needs_you.push_new(user_id, needs_you.notification_entries(created, user_id))
    return len(created)


def notification_notifier(config: Optional[dict] = None) -> Notifier:
    """Raise advisories as ``proactive_ask`` rows (the Needs-You notification path)."""

    async def _notify(user_id: str, adv: Advisory) -> Any:
        from hermes_cli.datastore import get_store
        from hermes_cli.human_comms import NotificationStore

        store = NotificationStore(get_store("supabase-app", "prod", config=config), config=config)
        await store.initialize()
        return await store.create(
            kind="proactive_ask",
            target_user_id=user_id,
            title=adv.title,
            body=adv.body,
            reversible=False,
            dedupe_key=adv.dedupe_key,
            context={"advisory": adv.kind, "suggested": adv.suggested} if adv.suggested else None,
        )

    return _notify


def _configured_threshold(config: dict) -> float:
    comp = config.get("compression") if isinstance(config, dict) else None
    try:
        return float((comp or {}).get("threshold", 0.50))
    except (TypeError, ValueError):
        return 0.50


async def _owner_id(config: dict) -> str:
    from hermes_cli.access import PrincipalStore
    from hermes_cli.datastore import get_store

    owner = await PrincipalStore(get_store("supabase-app", "prod", config=config)).get_owner()
    if owner is None:
        raise RuntimeError("no owner is enrolled yet")
    return owner.user_id


def advise_command(args: argparse.Namespace) -> int:
    from agent.model_metadata import load_context_length_events
    from hermes_cli.config import load_config

    config = load_config() or {}
    advisories = scan(
        load_turns(), load_context_length_events(),
        threshold_percent=_configured_threshold(config),
    )
    for adv in advisories:
        print(f"[{adv.kind}] {adv.title} ({adv.key})")
        for line in adv.body.splitlines():
            print(f"  {line}")
    if not advisories:
        print("No compression advisories.")
        return 0
    if args.no_deliver:
        return 0

    async def _run() -> int:
        return await deliver(advisories, await _owner_id(config), notification_notifier(config))

    try:
        sent = asyncio.run(_run())
    except RuntimeError as exc:
        print(f"{exc}")
        return 1
    print(f"Delivered {sent} new Needs-You card(s).")
    return 0


def register_compression_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes compression``."""
    parser = subparsers.add_parser(
        "compression",
        help="Context-compression diagnostics and advisories",
    )
    sub = parser.add_subparsers(dest="compression_command", required=True)
    advise = sub.add_parser(
        "advise",
        help=(
            "Scan the compression ledger and context-length learning log; raise "
            "evidence-backed config suggestions as Needs-You cards (never edits config)"
        ),
    )
    advise.add_argument(
        "--no-deliver", action="store_true",
        help="Print advisories without raising Needs-You cards",
    )
    advise.set_defaults(func=advise_command)
