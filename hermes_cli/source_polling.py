"""Which channel sources the pipeline readers poll (FG-03 P2).

The email poller and the WhatsApp batcher read the box source registry
(:mod:`hermes_cli.source_registry`): every enabled source with at least one
enabled route is polled, once, however many profiles it routes to. The
box-wide ``/opt/data/*/config.json`` stays as a fallback for a box whose
registry is unreachable or has no sources for the channel yet.

``source_registry.pollers`` in config.yaml picks the mode:

* ``registry`` (default) — the registry first; the config.json fallback only
  when the registry is unreachable or holds no source for the channel.
* ``registry_only`` — the registry and nothing else; unreachable means poll
  nothing.
* ``config`` — the legacy config.json only.

A source has exactly one reader: where a gateway person bridge and the
pipeline could both read one WhatsApp bridge, the pipeline reads its external
messages and the gateway only the owner's self-chat
(:func:`pipeline_reads_bridge`).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Optional

from hermes_cli.source_registry import Source, normalize_address

logger = logging.getLogger(__name__)

MODES = ("registry", "registry_only", "config")
DEFAULT_MODE = "registry"

#: Box-wide pipeline configs, the fallback when the registry can't be used.
FALLBACK_CONFIG_PATHS = {
    "email": os.environ.get("EMAIL_CONFIG_PATH", "/opt/data/email-messages/config.json"),
    "whatsapp": "/opt/data/whatsapp-messages/config.json",
}


@dataclass(frozen=True)
class PollPlan:
    """The sources one reader polls this round, and where they came from."""

    channel: str
    mode: str  # "registry" or "config"
    sources: tuple[Source, ...] = field(default_factory=tuple)
    reason: str = ""

    @property
    def from_registry(self) -> bool:
        return self.mode == "registry"

    def describe(self) -> str:
        if self.from_registry:
            return (
                f"{self.channel} sources from the source registry: "
                f"{len(self.sources)} routed ({self.reason})"
            )
        return f"{self.channel} sources from the box-wide config.json fallback ({self.reason})"


def poller_mode(config: Optional[Mapping[str, Any]] = None) -> str:
    if config is None:
        from hermes_cli.config import load_config_readonly

        config = load_config_readonly()
    section = (config or {}).get("source_registry")
    raw = section.get("pollers") if isinstance(section, Mapping) else None
    mode = str(raw or DEFAULT_MODE).strip().lower()
    if mode not in MODES:
        logger.warning(
            "source_registry.pollers=%r is not one of %s; using %r", raw, MODES, DEFAULT_MODE
        )
        return DEFAULT_MODE
    return mode


async def _registry_sources(
    channel: str, *, config: Optional[Mapping[str, Any]], dsn: Optional[str]
) -> list[Source]:
    from hermes_cli.source_registry import connect_box, list_sources

    # ``config`` only picks the poller mode; the registry DSN is box-wide
    # (the default profile's), whichever profile this reader runs in.
    connection = await connect_box(dsn=dsn)
    try:
        return await list_sources(connection, channel=channel)
    finally:
        await connection.close()


async def load_poll_plan_async(
    channel: str,
    *,
    config: Optional[Mapping[str, Any]] = None,
    dsn: Optional[str] = None,
) -> PollPlan:
    """What ``channel``'s reader polls now (see the module doc for the modes)."""
    mode = poller_mode(config)
    if mode == "config":
        return PollPlan(channel, "config", reason="source_registry.pollers is 'config'")
    try:
        sources = await _registry_sources(channel, config=config, dsn=dsn)
    except Exception as exc:
        why = f"registry unreachable: {type(exc).__name__}: {exc}"
        if mode == "registry_only":
            return PollPlan(channel, "registry", reason=f"{why}; registry_only polls nothing")
        return PollPlan(channel, "config", reason=why)
    if not sources and mode == "registry":
        return PollPlan(channel, "config", reason=f"the registry has no {channel} source")
    routed = tuple(s for s in sources if s.routed_profiles())
    skipped = len(sources) - len(routed)
    return PollPlan(
        channel,
        "registry",
        routed,
        reason=f"{skipped} disabled or unrouted source(s) not polled",
    )


def load_poll_plan(
    channel: str,
    *,
    config: Optional[Mapping[str, Any]] = None,
    dsn: Optional[str] = None,
    previous: Optional[PollPlan] = None,
    log: Any = None,
) -> PollPlan:
    """Synchronous :func:`load_poll_plan_async` for the pipeline loops.

    Logs the plan when it is the first one or its mode/sources changed.
    """
    plan = asyncio.run(load_poll_plan_async(channel, config=config, dsn=dsn))
    if previous is None or (plan.mode, plan.sources) != (previous.mode, previous.sources):
        (log or logger.info)(plan.describe())
    return plan


def load_fallback_config(channel: str, path: Optional[str] = None) -> dict[str, Any]:
    try:
        with open(path or FALLBACK_CONFIG_PATHS[channel], encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return {}


def ref(source: Source) -> dict[str, Any]:
    return dict(source.credential_ref or {})


# --- WhatsApp: one reader per bridge -------------------------------------------------


def source_bridge_port(source: Source, bridge_ports: Mapping[str, int]) -> Optional[int]:
    """The bridge port a WhatsApp source is read from, via its credential_ref."""
    pointer = ref(source)
    port = pointer.get("port")
    if isinstance(port, int) and port > 0:
        return port
    name = pointer.get("bridge")
    if name and isinstance(bridge_ports.get(name), int):
        return bridge_ports[name]
    return None


def pipeline_reads_bridge(
    plan: PollPlan,
    *,
    port: int,
    own_number: Optional[str] = None,
    bridge_name: Optional[str] = None,
    bridge_ports: Optional[Mapping[str, int]] = None,
    fallback_phones: Iterable[Mapping[str, Any]] = (),
) -> Optional[str]:
    """The pipeline source reading this bridge (its id or config id), or None."""
    bridge_ports = bridge_ports or {}
    number = normalize_address("whatsapp", own_number) if own_number else None
    if plan.from_registry:
        for source in plan.sources:
            if (
                source_bridge_port(source, bridge_ports) == port
                or (bridge_name and ref(source).get("bridge") == bridge_name)
                or (number and source.address == number)
            ):
                return source.source_id
        return None
    for phone in fallback_phones:
        if phone.get("enabled", True) and phone.get("bridge_port") == port:
            return str(phone.get("id") or port)
    return None


# --- Email: one reader per mailbox ------------------------------------------------


async def pipeline_reads_mailbox(address: str) -> Optional[str]:
    """The pipeline source (registry id, or config.json account id) reading
    ``address``, or None. For the gateway's start-up double-reader warning."""
    wanted = normalize_address("email", address)
    plan = await load_poll_plan_async("email")
    if plan.from_registry:
        return next((s.source_id for s in plan.sources if s.address == wanted), None)
    for account in load_fallback_config("email").get("accounts", []):
        if account.get("enabled", True) and str(account.get("address", "")).lower() == wanted:
            return str(account.get("id") or wanted)
    return None
