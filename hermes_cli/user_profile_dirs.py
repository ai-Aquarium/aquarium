"""Per-user folders inside a profile (FG-03 P1).

A profile is a template; each person using it gets
``<profile home>/users/<user_id>/`` for their own version of profile-level
settings, starting with triage skills (FG-03 P3). Per-user memory stays at
``memories/users/<user_id>/`` (FG-24) and is not moved here.
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from hermes_constants import get_hermes_home

USERS_DIRNAME = "users"


def users_root(home: Optional[Path] = None) -> Path:
    """``<home>/users`` for ``home`` (default: the active profile home)."""
    return Path(home or get_hermes_home()) / USERS_DIRNAME


def user_profile_dir(user_id: str, home: Optional[Path] = None) -> Path:
    """``<home>/users/<user_id>``, refusing ids that escape ``users/``.

    Does not create the folder.
    """
    from hermes_cli.access import validate_user_id

    parent = users_root(home)
    candidate = parent / validate_user_id(user_id)
    resolved = candidate.resolve()
    if resolved.parent != parent.resolve():
        raise ValueError(
            f"Refusing user folder for {user_id!r}: {resolved} escapes {parent}"
        )
    return candidate
