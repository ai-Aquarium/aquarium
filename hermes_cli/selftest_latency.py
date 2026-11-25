"""Latency canary — ``hermes selftest latency``.

Sends one trivial prompt (fresh request: no history, tools or system prompt)
to the main provider and to every ``fallback_providers`` entry, and measures
time-to-first-token. A provider that misses ``selftest.latency.ttft_slo_ms``
or fails outright is raised as a Needs-You card through the same channel as
the compression advisories (``hermes_cli.compression_advisor.deliver``).
Like them, it never writes ``config.yaml``: a suggested switch is evidence
for the owner, not an action.

Gated on ``selftest.latency.enabled`` (default false), so its timer
(``deploy/hermes-selftest-latency.timer``) is a no-op until opted in.
Plan: ``plans/2026-11-25-context-length-learning-and-compression-loop.md`` §3c.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

from hermes_cli.compression_advisor import Advisory

logger = logging.getLogger(__name__)

PROMPT = "Reply with the single word: OK"
DEDUPE_PREFIX = "selftest-latency"
DEFAULTS: Dict[str, Any] = {"enabled": False, "ttft_slo_ms": 10_000, "timeout_s": 60}


@dataclass(frozen=True)
class Target:
    label: str  # "main" | "fallback_providers[i]"
    provider: str
    model: str
    base_url: str = ""
    api_key: Optional[str] = None
    api_mode: Optional[str] = None

    @property
    def key(self) -> str:
        return f"{self.provider}:{self.model}@{self.base_url}"


@dataclass
class Result:
    target: Target
    ttft_ms: Optional[int] = None
    total_ms: Optional[int] = None
    streamed: bool = True
    error: str = ""

    @property
    def ok(self) -> bool:
        return not self.error and self.ttft_ms is not None


@dataclass
class LatencyAdvisory(Advisory):
    @property
    def dedupe_key(self) -> str:
        return f"{DEDUPE_PREFIX}:{self.kind}:{self.key}"


def latency_settings(config: Optional[dict]) -> Dict[str, Any]:
    raw = ((config or {}).get("selftest") or {}).get("latency") or {}
    out = dict(DEFAULTS)
    if isinstance(raw, dict):
        out.update({k: v for k, v in raw.items() if v is not None})
    out["enabled"] = bool(out["enabled"])
    for k in ("ttft_slo_ms", "timeout_s"):
        try:
            out[k] = max(1, int(out[k]))
        except (TypeError, ValueError):
            out[k] = DEFAULTS[k]
    return out


def _s(value: Any) -> str:
    return str(value or "").strip()


def targets(config: Optional[dict]) -> List[Target]:
    """Main provider first, then the effective fallback chain; one per route."""
    from agent.auxiliary_client import _fallback_entry_api_key
    from hermes_cli.fallback_config import get_fallback_chain

    config = config or {}
    out: List[Target] = []
    model_cfg = config.get("model")
    if isinstance(model_cfg, str) and model_cfg.strip():
        out.append(Target("main", "auto", model_cfg.strip()))
    elif isinstance(model_cfg, dict):
        model = _s(model_cfg.get("default") or model_cfg.get("model"))
        if model:
            out.append(Target(
                "main",
                _s(model_cfg.get("provider")).lower() or "auto",
                model,
                _s(model_cfg.get("base_url")).rstrip("/"),
                _s(model_cfg.get("api_key")) or None,
                _s(model_cfg.get("api_mode")) or None,
            ))
    for i, entry in enumerate(get_fallback_chain(config)):
        provider, model = _s(entry.get("provider")).lower(), _s(entry.get("model"))
        if not provider or not model:
            continue
        out.append(Target(
            f"fallback_providers[{i}]",
            provider,
            model,
            _s(entry.get("base_url")).rstrip("/"),
            _fallback_entry_api_key(entry),
            _s(entry.get("api_mode") or entry.get("transport")) or None,
        ))
    seen, unique = set(), []
    for t in out:
        route = (t.provider, t.model, t.base_url)
        if route not in seen:
            seen.add(route)
            unique.append(t)
    return unique


def resolve_client(target: Target) -> Tuple[Optional[Any], Optional[str]]:
    from agent.auxiliary_client import resolve_provider_client

    return resolve_provider_client(
        target.provider,
        model=target.model,
        explicit_base_url=target.base_url or None,
        explicit_api_key=target.api_key,
        api_mode=target.api_mode,
    )


def _delta_text(chunk: Any) -> str:
    try:
        choice = chunk.choices[0]
    except (AttributeError, IndexError, TypeError):
        return ""
    delta = getattr(choice, "delta", None)
    return getattr(delta, "content", None) or ""


def measure(
    target: Target,
    *,
    timeout_s: int,
    resolve: Callable[[Target], Tuple[Optional[Any], Optional[str]]] = resolve_client,
    clock: Callable[[], float] = time.monotonic,
) -> Result:
    """One trivial request; TTFT is the first chunk carrying content."""
    try:
        client, model = resolve(target)
    except Exception as exc:  # noqa: BLE001 - a broken route is the finding
        return Result(target, error=f"resolve failed: {type(exc).__name__}: {exc}"[:300])
    if client is None:
        return Result(target, error="no client (missing credentials or unknown provider)")
    kwargs = dict(
        model=model or target.model,
        messages=[{"role": "user", "content": PROMPT}],
        max_tokens=16,
        stream=True,
        timeout=timeout_s,
    )
    started = clock()
    try:
        try:
            resp = client.chat.completions.create(**kwargs)
        except TypeError as exc:
            if "timeout" not in str(exc):
                raise
            kwargs.pop("timeout")
            resp = client.chat.completions.create(**kwargs)
        if hasattr(resp, "choices"):  # adapter ignored stream=True
            total = round((clock() - started) * 1000)
            return Result(target, ttft_ms=total, total_ms=total, streamed=False)
        first_any = first_content = None
        for chunk in resp:
            now = clock()
            if first_any is None:
                first_any = now
            if first_content is None and _delta_text(chunk):
                first_content = now
        total = round((clock() - started) * 1000)
        first = first_content if first_content is not None else first_any
        if first is None:
            return Result(target, total_ms=total, error="stream returned no chunks")
        return Result(target, ttft_ms=round((first - started) * 1000), total_ms=total)
    except Exception as exc:  # noqa: BLE001
        return Result(
            target,
            total_ms=round((clock() - started) * 1000),
            error=f"{type(exc).__name__}: {exc}"[:300],
        )


def _describe(r: Result) -> str:
    t = r.target
    where = f"{t.provider}/{t.model}" + (f" at {t.base_url}" if t.base_url else "")
    return f"{t.label} ({where})"


def evaluate(results: List[Result], slo_ms: int) -> List[LatencyAdvisory]:
    """SLO breaches and failures → advisories; a healthy run raises nothing."""
    healthy = [r for r in results if r.ok and r.ttft_ms <= slo_ms]
    out: List[LatencyAdvisory] = []
    for r in results:
        if r.ok and r.ttft_ms <= slo_ms:
            continue
        if r.ok:
            kind = "slow"
            title = f"{r.target.label} is slow to respond"
            evidence = (
                f"{_describe(r)} took {r.ttft_ms / 1000:.1f}s to its first token on a "
                f"one-line prompt (SLO {slo_ms / 1000:.1f}s"
                + ("" if r.streamed else "; provider does not stream, so this is the full reply time")
                + ")."
            )
        else:
            kind = "unreachable"
            title = f"{r.target.label} failed the latency self-test"
            evidence = f"{_describe(r)} failed a one-line prompt: {r.error}"
        suggested: Dict[str, Any] = {}
        hint = (
            "If it persists, check the provider's status or credentials, move it "
            "later in fallback_providers, or raise selftest.latency.ttft_slo_ms if "
            "the SLO is too strict."
        )
        if r.target.label == "main":
            alt = min((h for h in healthy if h.target.label != "main"),
                      key=lambda h: h.ttft_ms, default=None)
            if alt is not None:
                suggested = {"model.provider": alt.target.provider, "model.default": alt.target.model}
                hint = (
                    f"{_describe(alt)} answered in {alt.ttft_ms / 1000:.1f}s. If this "
                    f"persists, consider model.provider: {alt.target.provider} / "
                    f"model.default: {alt.target.model}."
                )
        out.append(LatencyAdvisory(
            kind=kind,
            key=r.target.key,
            title=title,
            body=f"{evidence}\n{hint}\nNothing was changed; config.yaml is yours to edit.",
            suggested=suggested,
        ))
    return out


def latency_command(args: argparse.Namespace) -> int:
    from hermes_cli import compression_advisor
    from hermes_cli.config import load_config

    config = load_config() or {}
    settings = latency_settings(config)
    if not settings["enabled"] and not args.force:
        print("Latency self-test is disabled (selftest.latency.enabled: false); use --force to run once.")
        return 0
    routes = targets(config)
    if not routes:
        print("No providers configured (model / fallback_providers).")
        return 1
    results = []
    for t in routes:
        r = measure(t, timeout_s=settings["timeout_s"])
        results.append(r)
        logger.info(
            "selftest-latency target=%s provider=%s model=%s ttft_ms=%s total_ms=%s streamed=%s ok=%s",
            t.label, t.provider, t.model, r.ttft_ms, r.total_ms, r.streamed, r.ok,
        )
        status = f"ttft={r.ttft_ms}ms total={r.total_ms}ms" if r.ok else f"error: {r.error}"
        print(f"{_describe(r)}: {status}")
    advisories = evaluate(results, settings["ttft_slo_ms"])
    if not advisories:
        print(f"All providers within the {settings['ttft_slo_ms']}ms TTFT SLO.")
        return 0
    for adv in advisories:
        print(f"[{adv.kind}] {adv.title}")
    if args.no_deliver:
        return 0

    async def _run() -> int:
        return await compression_advisor.deliver(
            advisories,
            await compression_advisor._owner_id(config),
            compression_advisor.notification_notifier(config),
        )

    try:
        sent = asyncio.run(_run())
    except RuntimeError as exc:
        print(f"{exc}")
        return 1
    print(f"Delivered {sent} new Needs-You card(s).")
    return 0


def register_selftest_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes selftest``."""
    parser = subparsers.add_parser("selftest", help="Runtime self-test canaries")
    sub = parser.add_subparsers(dest="selftest_command", required=True)
    latency = sub.add_parser(
        "latency",
        help=(
            "Measure time-to-first-token for the main provider and each fallback; "
            "raise SLO breaches as Needs-You cards (never edits config)"
        ),
    )
    latency.add_argument("--force", action="store_true",
                         help="Run even when selftest.latency.enabled is false")
    latency.add_argument("--no-deliver", action="store_true",
                         help="Print results without raising Needs-You cards")
    latency.set_defaults(func=latency_command)
