"""Daily review of how many asks (to-dos) triage raised, per profile.

Triage records every to-do a batch emits (there is no per-batch cap), so the
triage skills' ``todo-decisions.md`` are the only filter. When a profile's
triage files more than ``triage.ask_review.daily_threshold`` to-dos within 24
hours, the profile owner gets one ``proactive_ask`` in Needs you naming the
count and the busiest triage skills, linking to Profile › My triage skills.

At most one warning per profile per local day: the dedupe key carries the
profile and the date, and an existing row with that key (pending *or* already
answered) suppresses a re-raise. The gateway's housekeeping loop polls this
hourly; ``hermes todos ask-review`` runs it by hand.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Mapping, Optional
from urllib.parse import quote

from hermes_cli.needs_you import TRIAGE_ASK_REVIEW, triage_skills_href

logger = logging.getLogger(__name__)

DEFAULT_DAILY_THRESHOLD = 20
WINDOW = timedelta(hours=24)
#: How many skills the warning names.
BUSIEST_SHOWN = 3


@dataclass
class AskReview:
    """What one profile's review found."""

    profile: str
    count: int
    threshold: int
    by_skill: list[tuple[str, int]] = field(default_factory=list)
    warned: bool = False
    notification_id: Optional[str] = None


def review_settings(config: Optional[Mapping[str, Any]]) -> tuple[bool, int]:
    """``(enabled, daily_threshold)`` from ``triage.ask_review`` in config.yaml."""
    triage = (config or {}).get("triage") or {}
    section = triage.get("ask_review") if isinstance(triage, Mapping) else None
    section = section if isinstance(section, Mapping) else {}
    enabled = section.get("enabled", True) is not False
    try:
        threshold = int(section.get("daily_threshold", DEFAULT_DAILY_THRESHOLD))
    except (TypeError, ValueError):
        threshold = DEFAULT_DAILY_THRESHOLD
    return enabled, max(0, threshold)


def skill_of(actor: str) -> str:
    """``skill:email-triage`` → ``email-triage``; anything else as written."""
    return actor.split(":", 1)[1] if actor.startswith("skill:") else actor


def dedupe_key(profile: str, day: date) -> str:
    return f"{TRIAGE_ASK_REVIEW}:{quote(profile or 'default', safe='')}:{day.isoformat()}"


def warning_text(profile: str, count: int, threshold: int,
                 by_skill: list[tuple[str, int]]) -> tuple[str, str]:
    busiest = ", ".join(f"{name} ({n})" for name, n in by_skill[:BUSIEST_SHOWN])
    title = f"Triage raised {count} asks in the last day — review your triage skills?"
    body = (
        f"Triage filed {count} to-dos for profile '{profile}' in the last 24 hours "
        f"(threshold {threshold}). Busiest: {busiest}. If that is more than you "
        "need, tighten the to-do rules in those triage skills under Profile › "
        f"My triage skills ({triage_skills_href(profile)})."
    )
    return title, body


async def review_profile(
    todos: Any,
    notifications: Any,
    owner: Any,
    *,
    profile: str,
    threshold: int,
    now: Optional[datetime] = None,
) -> AskReview:
    """Count the last day's triage to-dos; above ``threshold``, warn once today."""
    now = (now or datetime.now().astimezone()).astimezone()
    counts = await todos.created_by_actor_since(owner, now - WINDOW)
    by_skill = sorted(
        ((skill_of(actor), n) for actor, n in counts.items()),
        key=lambda pair: (-pair[1], pair[0]),
    )
    review = AskReview(profile, sum(n for _, n in by_skill), threshold, by_skill)
    if review.count <= threshold:
        return review
    key = dedupe_key(profile, now.date())
    if await notifications.get_by_dedupe_key(key, owner) is not None:
        return review
    title, body = warning_text(profile, review.count, threshold, by_skill)
    result = await notifications.create(
        kind="proactive_ask",
        target_user_id=owner.user_id,
        title=title,
        body=body,
        dedupe_key=key,
        now=now.replace(tzinfo=None),
        context={
            "profile": profile,
            "count": review.count,
            "threshold": threshold,
            "skills": dict(by_skill),
            "href": triage_skills_href(profile),
        },
    )
    review.warned = bool(result.created)
    review.notification_id = result.notification.id
    return review


async def review_active_profile(
    profile: str,
    *,
    config: Optional[Mapping[str, Any]] = None,
    now: Optional[datetime] = None,
) -> Optional[AskReview]:
    """Run the review for the profile whose HERMES_HOME is in scope.

    ``None`` when the review is disabled or the profile has no owner.
    """
    from hermes_cli.access import PrincipalStore
    from hermes_cli.config import load_config_readonly
    from hermes_cli.datastore import get_store
    from hermes_cli.human_comms import NotificationStore
    from hermes_cli.todo_store import TodoStore

    resolved = dict(config) if config is not None else (load_config_readonly() or {})
    enabled, threshold = review_settings(resolved)
    if not enabled:
        return None
    app = get_store("supabase-app", "prod", config=resolved)
    owner = await PrincipalStore(app).get_owner()
    if owner is None:
        return None
    return await review_profile(
        TodoStore(app),
        NotificationStore(app, config=resolved),
        owner,
        profile=profile,
        threshold=threshold,
        now=now,
    )


def run_ask_review(
    profiles: Optional[list[tuple[str, Any]]] = None,
    *,
    now: Optional[datetime] = None,
) -> list[AskReview]:
    """Review every profile this process serves; one bad profile skips, not stops."""
    from hermes_cli.console_scope import _scoped_to

    if profiles is None:
        from agent.secret_scope import is_multiplex_active
        from hermes_cli.profiles import profiles_to_serve

        profiles = profiles_to_serve(multiplex=is_multiplex_active())
    out: list[AskReview] = []
    for name, home in profiles:
        try:
            with _scoped_to(home):
                review = asyncio.run(review_active_profile(name, now=now))
        except Exception:
            logger.debug("ask review: profile %s skipped", name, exc_info=True)
            continue
        if review is not None:
            out.append(review)
            if review.warned:
                logger.info(
                    "ask review: profile %s raised %d asks (threshold %d), warned",
                    name, review.count, review.threshold,
                )
    return out


__all__ = [
    "AskReview",
    "DEFAULT_DAILY_THRESHOLD",
    "dedupe_key",
    "review_active_profile",
    "review_profile",
    "review_settings",
    "run_ask_review",
    "skill_of",
    "warning_text",
]
