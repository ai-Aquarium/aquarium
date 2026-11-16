"""One cheap routing call per incoming batch (FG-03 P4).

A source (mailbox, WhatsApp number, Telegram bot) belongs to one user and is
routed to some of that user's user-profiles (:mod:`hermes_cli.source_registry`).
For each batch from a source, one tool-less auxiliary LLM call reads the batch
plus the owner's "What I care about" for every routed user-profile
(:func:`hermes_cli.triage_skills.care_sections_for_source`) and picks zero or
more of them, each with a one-line reason. Only the picked user-profiles run
full triage (P5).

* No routes → no call, nothing picked.
* The call fails or returns unusable output → wait and retry
  (``triage.router.retries``, default 3); after the last failure every routed
  user-profile is picked (``fallback=True``) so nothing is missed.
* Every decision is stored in ``aquarium_box.routing_decisions`` so the
  owner can see why a profile did or didn't get a batch.
* The system prompt depends only on the source's routes and care texts, so it
  is byte-stable between batches (provider prompt caching).

Config (config.yaml, never env vars)::

    triage:
      router:
        mode: shadow        # off | shadow | enforce
        retries: 3
        retry_delay_seconds: 5
    auxiliary:
      triage_router: {provider: auto, model: "", ...}   # the cheap model

``shadow`` (default until P5): decisions are made and stored, today's triage
scripts run unchanged. ``enforce``: callers act on the decision (P5).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Awaitable, Callable, Mapping, Optional, Sequence

from hermes_cli.source_registry import BOX_SCHEMA

AUX_TASK = "triage_router"
MODES = ("off", "shadow", "enforce")
DEFAULT_MODE = "shadow"
DEFAULT_RETRIES = 3
DEFAULT_RETRY_DELAY_SECONDS = 5.0

DECISIONS_DDL = f"""
CREATE TABLE IF NOT EXISTS {BOX_SCHEMA}.routing_decisions (
    decision_id    BIGSERIAL PRIMARY KEY,
    batch_id       TEXT NOT NULL,
    source_id      UUID NOT NULL,
    channel        TEXT NOT NULL,
    owner_user_id  TEXT NOT NULL,
    choices        JSONB NOT NULL DEFAULT '[]'::jsonb,
    selected       TEXT[] NOT NULL DEFAULT '{{}}',
    model          TEXT,
    attempts       INTEGER NOT NULL DEFAULT 0,
    fallback       BOOLEAN NOT NULL DEFAULT FALSE,
    error          TEXT,
    decided_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, batch_id)
);
CREATE INDEX IF NOT EXISTS routing_decisions_owner_idx
    ON {BOX_SCHEMA}.routing_decisions (owner_user_id, decided_at DESC);
"""

#: ``(system_prompt, user_prompt) -> raw model text``; injectable for tests.
LLMCall = Callable[[str, str], Awaitable[str]]


@dataclass(frozen=True)
class RouteChoice:
    profile: str
    selected: bool
    reason: str = ""


@dataclass(frozen=True)
class RoutingDecision:
    batch_id: str
    source_id: str
    channel: str
    owner_user_id: str
    choices: tuple[RouteChoice, ...] = field(default_factory=tuple)
    model: Optional[str] = None
    attempts: int = 0
    fallback: bool = False
    error: Optional[str] = None
    decision_id: Optional[int] = None
    decided_at: Optional[datetime] = None

    @property
    def selected(self) -> list[str]:
        return [c.profile for c in self.choices if c.selected]

    def as_dict(self) -> dict[str, Any]:
        raise NotImplementedError


def router_settings(config: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    """``{"mode", "retries", "retry_delay_seconds"}`` from ``triage.router``."""
    raise NotImplementedError


async def ensure_schema(connection: Any) -> None:
    """Create ``routing_decisions`` (called from ``connect_box`` / db migrate)."""
    raise NotImplementedError


def build_prompts(channel: str, care_sections: Sequence[Mapping[str, Any]],
                  batch_text: str) -> tuple[str, str]:
    """``(system, user)``: system lists each routed profile + its care text and
    the strict JSON reply schema; user is the batch. Deterministic."""
    raise NotImplementedError


def parse_reply(raw: str, profiles: Sequence[str]) -> tuple[RouteChoice, ...]:
    """One choice per routed profile, in ``profiles`` order. Unknown profiles
    are dropped, missing ones count as not selected. Raises ``ValueError`` on
    output that isn't the JSON schema (counts as a failed attempt)."""
    raise NotImplementedError


async def route_batch(
    connection: Any,
    *,
    source_id: str,
    batch_id: str,
    batch_text: str,
    config: Optional[Mapping[str, Any]] = None,
    llm: Optional[LLMCall] = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> RoutingDecision:
    """Decide and store which of the source owner's user-profiles get this
    batch. Idempotent per ``(source_id, batch_id)``: a stored decision is
    returned without a new call."""
    raise NotImplementedError


def route_batch_sync(**kwargs: Any) -> Optional[RoutingDecision]:
    """For the sync pipeline scripts: opens a box connection, runs
    :func:`route_batch`, and returns ``None`` (logged, never raised) when the
    registry is unreachable so today's triage is never blocked."""
    raise NotImplementedError


async def list_decisions(
    connection: Any,
    *,
    owner_user_id: Optional[str] = None,
    source_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    limit: int = 50,
) -> list[RoutingDecision]:
    raise NotImplementedError


async def get_decision(connection: Any, source_id: str, batch_id: str) -> Optional[RoutingDecision]:
    raise NotImplementedError
