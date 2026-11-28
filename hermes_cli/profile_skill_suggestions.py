"""Profile skill suggestions — score library skills a profile doesn't have.

Powers the "Could learn" list on the agent-profile page: every skill in the
box-wide library that this profile has never installed is scored 1-10 for
relevance against the profile's goal (``profile.yaml`` description) and
``SOUL.md`` by the auxiliary LLM, so the list reads "what this agent would
benefit from" instead of a flat catalog dump.

Result is cached in ``<profile_dir>/skill_suggestions.json``, keyed by a
hash of (goal + soul + candidate skill set): editing the goal, the soul,
installing a suggested skill, or the library gaining a new entry all change
the key and re-score. Scoring is expensive (one LLM call), so callers serve
the cache whenever it is fresh.

Design notes
------------
- Mirrors ``hermes_cli/profile_describer.py``: lazy aux client import inside
  the function, lenient JSON parse, never raises on expected failure modes —
  they surface as ``ok=False`` + ``reason`` so the page renders an empty
  state instead of an error.
- Candidates are skills with **no** ``used_by`` row for this profile —
  installed-but-disabled skills already appear under "On this agent".
- ``SOUL.md`` is clipped to ``MAX_SOUL_CHARS``; profiles carry 90+ library
  skills, so the candidate list is capped at ``MAX_CANDIDATES`` (lowest
  count of prior evidence first — none, since there's no usage signal for
  uninstalled skills, so simply alphabetical head — like the describer's
  even sampling is unnecessary; scores are per-skill, order doesn't matter).
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from hermes_cli import profiles as profiles_mod

logger = logging.getLogger(__name__)

MAX_CANDIDATES = 60
MAX_SOUL_CHARS = 4000
MAX_SKILLS_FOR_CONTEXT = 40
CACHE_NAME = "skill_suggestions.json"

_SYSTEM_PROMPT = """You are a skill-matcher for the Hermes Agent.

A user runs "profiles" — distinct agent identities, each with its own goal
(description), personality instructions (SOUL.md), and an installed set of
skills. You are given one profile's context plus a list of skills it does
NOT yet have. Score how relevant each skill would be FOR THIS PROFILE.

Output a single JSON array, one object per skill, same order as input:

  [
    {"skill": "<exact skill name>", "score": <1-10>, "reason": "<short phrase>"},
    ...
  ]

Rules:
  - score 10 = clearly built for what this profile does; 1 = unrelated.
  - Judge by the skill's name and description against the profile's goal and
    personality. A generic utility any agent might use scores 4-6, not 10.
  - reason: <= 12 words, concrete ("summarizes email — profile handles inboxes").
  - Output only JSON. No code fences, no preamble, no trailing commentary.
"""

_USER_TEMPLATE = """Profile: {name}
Goal: {goal}

SOUL.md (clipped):
{soul}

Skills this profile already has (context, do not score):
{installed}

Candidate skills to score:
{candidates}
"""


@dataclass
class SuggestionOutcome:
    """Result of scoring one profile's skill candidates."""

    profile_name: str
    ok: bool
    reason: str = ""
    suggestions: List[Dict[str, Any]] = field(default_factory=list)
    cached: bool = False
    context_hash: str = ""


def cache_path(profile_dir: Path) -> Path:
    return profile_dir / CACHE_NAME


def _read_soul(profile_dir: Path) -> str:
    try:
        soul = (profile_dir / "SOUL.md").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    return soul[:MAX_SOUL_CHARS]


def _context_hash(goal: str, soul: str, candidates: List[str]) -> str:
    h = hashlib.sha256()
    h.update(goal.encode("utf-8", "replace"))
    h.update(b"\x00")
    h.update(soul.encode("utf-8", "replace"))
    for name in candidates:
        h.update(b"\x00")
        h.update(name.encode("utf-8", "replace"))
    return h.hexdigest()[:16]


def _read_cache(profile_dir: Path, context_hash: str) -> Optional[List[Dict[str, Any]]]:
    """Cached suggestions when the context hash matches, else None."""
    try:
        data = json.loads(cache_path(profile_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict) or data.get("context_hash") != context_hash:
        return None
    suggestions = data.get("suggestions")
    return suggestions if isinstance(suggestions, list) else None


def _write_cache(profile_dir: Path, context_hash: str, suggestions: List[Dict[str, Any]]) -> None:
    try:
        cache_path(profile_dir).write_text(
            json.dumps(
                {
                    "context_hash": context_hash,
                    "generated_at": int(time.time()),
                    "suggestions": suggestions,
                }
            ),
            encoding="utf-8",
        )
    except OSError as exc:
        logger.debug("skill-suggestions: cache write failed: %s", exc)


def _candidates(profile_name: str) -> List[Dict[str, Any]]:
    """Library skills this profile has never installed.

    ``build_library`` returns ``used_by`` rows for every profile; a skill
    installed here (enabled or not) already shows under "On this agent", so
    only skills with no row at all are candidates.
    """
    from hermes_cli import skills_library

    library = skills_library.build_library()
    out: List[Dict[str, Any]] = []
    for entry in library.get("skills", []):
        if any(u.get("profile") == profile_name for u in entry.get("used_by", [])):
            continue
        out.append(entry)
    out.sort(key=lambda e: e.get("name") or "")
    return out


def _installed_names(profile_dir: Path) -> List[str]:
    """Installed skill names for prompt context (goal/soul alone can be thin)."""
    from hermes_cli import profile_describer

    names = [
        f"{cat}/{name}" if cat else name
        for cat, name in profile_describer.installed_skills(profile_dir)
    ]
    return names[:MAX_SKILLS_FOR_CONTEXT]


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _parse_suggestions(raw: str, known: Dict[str, Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Parse the LLM's JSON array; unknown/dup names and bad scores dropped."""
    stripped = _FENCE_RE.sub("", (raw or "").strip())
    start, end = stripped.find("["), stripped.rfind("]")
    if start == -1 or end <= start:
        return []
    try:
        rows = json.loads(stripped[start : end + 1])
    except (ValueError, json.JSONDecodeError):
        return []
    if not isinstance(rows, list):
        return []
    out: List[Dict[str, Any]] = []
    seen: set = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get("skill")
        if not isinstance(name, str) or name in seen or name not in known:
            continue
        try:
            score = int(row.get("score"))
        except (TypeError, ValueError):
            continue
        score = max(1, min(10, score))
        reason = str(row.get("reason") or "")[:120]
        entry = known[name]
        out.append(
            {
                "skill": name,
                "score": score,
                "reason": reason,
                "description": entry.get("description") or "",
                "category": entry.get("category") or "",
            }
        )
        seen.add(name)
    out.sort(key=lambda s: (-s["score"], s["skill"]))
    return out


def suggest_skills(
    profile_name: str,
    *,
    refresh: bool = False,
    timeout: Optional[int] = None,
) -> SuggestionOutcome:
    """Score the library skills ``profile_name`` doesn't have, 1-10 each.

    Serves ``skill_suggestions.json`` when its context hash (goal + soul +
    candidate set) is unchanged, unless ``refresh=True``. Never raises for
    expected failures — ``ok=False`` with ``reason`` instead.
    """
    canon = profiles_mod.normalize_profile_name(profile_name)
    if not profiles_mod.profile_exists(canon):
        return SuggestionOutcome(canon, False, "profile not found")
    try:
        if canon == "default":
            from hermes_constants import get_hermes_home  # type: ignore

            profile_dir = Path(get_hermes_home())
        else:
            profile_dir = profiles_mod.get_profile_dir(canon)
    except Exception as exc:
        return SuggestionOutcome(canon, False, f"cannot resolve profile dir: {exc}")

    meta = profiles_mod.read_profile_meta(profile_dir)
    goal = str(meta.get("description") or "")
    soul = _read_soul(profile_dir)

    try:
        candidates = _candidates(canon)
    except Exception as exc:
        logger.info("skill-suggestions: library scan failed for %s (%s)", canon, exc)
        return SuggestionOutcome(canon, False, "skill library unavailable")
    if not candidates:
        return SuggestionOutcome(canon, True, "nothing to suggest", suggestions=[])

    candidate_names = [str(c.get("name") or "") for c in candidates]
    context_hash = _context_hash(goal, soul, candidate_names)
    if not refresh:
        cached = _read_cache(profile_dir, context_hash)
        if cached is not None:
            return SuggestionOutcome(
                canon, True, "cached", suggestions=cached,
                cached=True, context_hash=context_hash,
            )

    try:
        from agent.auxiliary_client import (  # type: ignore
            get_auxiliary_extra_body,
            get_text_auxiliary_client,
            resolve_task_timeout,
        )
        client, aux_model = get_text_auxiliary_client("profile_skill_suggestions")
    except Exception as exc:
        logger.debug("skill-suggestions: auxiliary client unavailable: %s", exc)
        return SuggestionOutcome(canon, False, "auxiliary client unavailable",
                                 context_hash=context_hash)
    if client is None or not aux_model:
        return SuggestionOutcome(canon, False, "no auxiliary client configured",
                                 context_hash=context_hash)

    scored = candidates[:MAX_CANDIDATES]
    candidate_block = "\n".join(
        f"  - {c['name']}: {c.get('description') or '(no description)'}"
        for c in scored
    )
    installed = _installed_names(profile_dir)
    user_msg = _USER_TEMPLATE.format(
        name=canon,
        goal=goal or "(none written)",
        soul=soul or "(empty)",
        installed="\n".join(f"  - {n}" for n in installed) or "  (none)",
        candidates=candidate_block,
    )

    try:
        resp = client.chat.completions.create(
            model=aux_model,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_tokens=4000,
            timeout=timeout or resolve_task_timeout(
                "profile_skill_suggestions", model=aux_model, default=90
            ),
            extra_body=get_auxiliary_extra_body() or None,
        )
    except Exception as exc:
        logger.info("skill-suggestions: API call failed for %s (%s)", canon, exc)
        return SuggestionOutcome(canon, False, f"LLM error: {type(exc).__name__}",
                                 context_hash=context_hash)

    try:
        raw = resp.choices[0].message.content or ""
    except Exception:
        raw = ""

    known = {str(c.get("name")): c for c in scored}
    suggestions = _parse_suggestions(raw, known)
    if not suggestions:
        return SuggestionOutcome(canon, False, "LLM returned no usable scores",
                                 context_hash=context_hash)

    _write_cache(profile_dir, context_hash, suggestions)
    return SuggestionOutcome(
        canon, True, "scored", suggestions=suggestions, context_hash=context_hash
    )
