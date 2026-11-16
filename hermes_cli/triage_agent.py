"""Full triage inside each chosen user-profile's agent (FG-03 P5).

After the P4 router picks user-profiles for a batch, each pick gets one
headless, tool-less turn of that profile's agent acting as the source owner
(``agent.seeded_session.spawn_seeded_session(profile_home=..., internal_user_id=...)``).
Its skills text is ``triage_skills.compose_prompt(kind, home, owner)``
(built-in → template → the owner's own version). The reply uses today's
triage JSON schema, so ``custom/shared/triage_handlers.process_result`` acts
on it unchanged, scoped to that profile and owner.

``triage.agent.<channel>`` in config.yaml picks, per channel:

* ``legacy`` (default): today's box-wide DeepSeek triage only.
* ``shadow``: legacy triage acts; each picked user-profile also runs its
  agent turn and the result is stored in ``aquarium_box.triage_comparisons``
  for side-by-side review, never acted on.
* ``agent``: only the picked user-profiles' agent turns act.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Mapping, Optional, Sequence

MODES = ("legacy", "shadow", "agent")
CHANNELS = ("email", "whatsapp", "calendar")


@dataclass(frozen=True)
class ProfileTriage:
    """One user-profile's agent triage of one batch."""

    profile: str
    owner_user_id: str
    home: Optional[Path]
    result: Optional[dict] = None
    error: Optional[str] = None
    session_id: Optional[str] = None
    skills_layer: Optional[str] = None  # winning layer of the care section

    @property
    def ok(self) -> bool:
        return self.result is not None and self.error is None

    def as_dict(self) -> dict[str, Any]:
        raise NotImplementedError


#: ``runner(prompt, *, profile_home, owner_user_id, session_id, config) -> str | None``
#: — the reply text of one headless turn. The default wraps
#: ``spawn_seeded_session``; tests inject a stand-in.
TurnRunner = Callable[..., Optional[str]]


def agent_mode(channel: str, config: Optional[Mapping[str, Any]] = None) -> str:
    """``triage.agent.<channel>``; anything unknown means ``legacy``."""
    raise NotImplementedError


def build_triage_prompt(
    kind: str,
    batch: Mapping[str, Any],
    *,
    home: Path,
    owner_user_id: str,
    config: Optional[Mapping[str, Any]] = None,
) -> str:
    """The turn's prompt: fixed instructions + composed skills, then the batch.

    Everything before the batch is byte-stable for a user-profile (same
    layers in → same bytes), so provider prefix caching holds across batches.
    """
    raise NotImplementedError


def parse_triage_reply(raw: Optional[str]) -> Optional[dict]:
    """Today's triage JSON object from the reply (tolerates code fences), else None."""
    raise NotImplementedError


def run_profile_triage(
    kind: str,
    batch: Mapping[str, Any],
    *,
    profile: str,
    owner_user_id: str,
    config: Optional[Mapping[str, Any]] = None,
    runner: Optional[TurnRunner] = None,
) -> ProfileTriage:
    """One headless turn of ``profile``'s agent as ``owner_user_id``. Never raises.

    Refuses (``error`` set, no turn) when the profile does not exist or the
    owner is not an active person in it.
    """
    raise NotImplementedError


def triage_selected(
    kind: str,
    batch: Mapping[str, Any],
    profiles: Sequence[str],
    *,
    owner_user_id: str,
    config: Optional[Mapping[str, Any]] = None,
    runner: Optional[TurnRunner] = None,
) -> list[ProfileTriage]:
    """:func:`run_profile_triage` for each picked profile, in the given order."""
    raise NotImplementedError


async def ensure_schema(connection: Any) -> None:
    """Create ``aquarium_box.triage_comparisons`` (idempotent)."""
    raise NotImplementedError


async def record_comparison(
    connection: Any,
    *,
    source_id: str,
    batch_id: str,
    channel: str,
    owner_user_id: str,
    legacy_result: Optional[Mapping[str, Any]],
    agent: ProfileTriage,
) -> None:
    """Store one shadow comparison row (one per source, batch, profile). Idempotent."""
    raise NotImplementedError


async def list_comparisons(
    connection: Any,
    *,
    owner_user_id: Optional[str] = None,
    source_id: Optional[str] = None,
    batch_id: Optional[str] = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    raise NotImplementedError


def record_comparisons_sync(
    *,
    source_id: str,
    batch_id: str,
    channel: str,
    owner_user_id: str,
    legacy_result: Optional[Mapping[str, Any]],
    agents: Sequence[ProfileTriage],
    dsn: Optional[str] = None,
) -> bool:
    """Blocking wrapper for the pipelines. False on any error; never raises."""
    raise NotImplementedError


__all__ = [
    "MODES", "CHANNELS", "ProfileTriage", "TurnRunner", "agent_mode",
    "build_triage_prompt", "parse_triage_reply", "run_profile_triage",
    "triage_selected", "ensure_schema", "record_comparison",
    "list_comparisons", "record_comparisons_sync",
]
