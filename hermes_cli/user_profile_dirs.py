"""Per-user folders inside a profile (FG-03 P1).

A profile is a template; each person using it gets
``<profile home>/users/<user_id>/`` for their own version of profile-level
settings, starting with triage skills (FG-03 P3). Per-user memory stays at
``memories/users/<user_id>/`` (FG-24) and is not moved here.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, List, Mapping, Optional

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


def archived_user_dirs_root(user_id: str, home: Optional[Path] = None) -> Path:
    """``<home>/users/.archived/<user_id>``: every archived copy of that user's folder."""
    from hermes_cli.access import validate_user_id

    parent = users_root(home) / ".archived"
    candidate = parent / validate_user_id(user_id)
    resolved = candidate.resolve()
    if resolved.parent != parent.resolve():
        raise ValueError(
            f"Refusing archive folder for {user_id!r}: {resolved} escapes {parent}"
        )
    return candidate


# -- lifecycle (create on enrolment, archive on removal, backfill) -----------
#
# Re-enrolment policy: a user who is removed or deactivated and later
# re-enrolled gets a **fresh, empty** folder. Their old folder stays under
# ``users/.archived/<user_id>/<timestamp>/`` and is never restored
# automatically, so a purge-then-re-add or a hand-back to a different person
# cannot resurface stale settings. An operator can move an archive back by hand.

ARCHIVED_DIRNAME = ".archived"
_DIR_MODE = 0o700
_ARCHIVE_STAMP = "%Y%m%dT%H%M%SZ"

logger = logging.getLogger(__name__)


def _ensure_private_dir(path: Path) -> None:
    """``mkdir`` ``path`` as 0700 if missing; refuse a symlink or a file there."""
    if path.is_symlink():
        raise ValueError(f"Refusing user folder path {path}: it is a symlink")
    if path.exists():
        if not path.is_dir():
            raise ValueError(f"Refusing user folder path {path}: not a directory")
        return
    try:
        path.mkdir(mode=_DIR_MODE)
    except FileExistsError:
        if not path.is_dir() or path.is_symlink():
            raise
        return
    os.chmod(path, _DIR_MODE)


def ensure_user_profile_dir(user_id: str, home: Optional[Path] = None) -> Path:
    """Create ``<home>/users/<user_id>/`` (0700) if missing; return it.

    Idempotent: an existing folder and its contents are left untouched.
    """
    target = user_profile_dir(user_id, home)
    if target.name.startswith("."):
        raise ValueError(f"Refusing user folder for {user_id!r}: reserved name")
    base = Path(home or get_hermes_home())
    if not base.is_dir():
        raise FileNotFoundError(f"Profile home {base} does not exist")
    _ensure_private_dir(target.parent)
    _ensure_private_dir(target)
    return target


def archive_user_profile_dir(
    user_id: str,
    home: Optional[Path] = None,
    *,
    now: Optional[datetime] = None,
) -> Optional[Path]:
    """Move ``users/<user_id>/`` to ``users/.archived/<user_id>/<UTC stamp>/``.

    Never deletes. Returns the archive path, or ``None`` when there was no
    folder to archive. A second archive within the same second gets ``-N``.
    """
    source = user_profile_dir(user_id, home)
    if source.is_symlink() or not source.is_dir():
        return None
    archive_root = archived_user_dirs_root(user_id, home)
    _ensure_private_dir(archive_root.parent)
    _ensure_private_dir(archive_root)
    stamp = (
        (now or datetime.now(timezone.utc))
        .astimezone(timezone.utc)
        .strftime(_ARCHIVE_STAMP)
    )
    destination = archive_root / stamp
    suffix = 1
    while destination.exists() or destination.is_symlink():
        destination = archive_root / f"{stamp}-{suffix}"
        suffix += 1
    os.rename(source, destination)
    return destination


def box_profile_homes() -> List[Path]:
    """The default profile home followed by every ``profiles/<name>`` home."""
    from hermes_cli.profiles import (
        _PROFILE_ID_RE,
        _get_default_hermes_home,
        _get_profiles_root,
    )

    homes = [_get_default_hermes_home()]
    root = _get_profiles_root()
    if root.is_dir():
        homes.extend(
            entry
            for entry in sorted(root.iterdir())
            if entry.is_dir()
            and not entry.is_symlink()
            and _PROFILE_ID_RE.match(entry.name)
        )
    return homes


def _schema_for_home(home: Path, mode: str) -> str:
    from hermes_cli.datastore import app_schema
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(str(home))
    try:
        return app_schema(mode)  # type: ignore[arg-type]
    finally:
        reset_hermes_home_override(token)


def profile_home_for_schema(
    schema: str, mode: str, *, hint: Optional[Path] = None
) -> Optional[Path]:
    """The profile home whose derived app schema is ``schema``, else ``None``.

    ``hint`` (the home a store was built under) is tried first; then every
    profile on the box. This is how an enrolment into another profile's schema
    writes under *that* profile's home, whatever the process's own home is.
    """
    candidates: List[Path] = [hint] if hint is not None else []
    candidates.extend(home for home in box_profile_homes() if home != hint)
    for home in candidates:
        if _schema_for_home(home, mode) == schema:
            return home
    return None


def sync_user_profile_dir(
    user_id: str,
    *,
    active: bool,
    schema: str,
    mode: str,
    hint: Optional[Path] = None,
) -> Optional[Path]:
    """Create (``active``) or archive (not ``active``) a user's profile folder.

    The hook :class:`hermes_cli.access.PrincipalStore` runs after an enrolment
    change commits. Best effort: a filesystem failure is logged, never raised,
    because the ``principals`` row is the source of truth and
    ``hermes member backfill-folders`` repairs missing folders. Only the prod
    app schema carries real enrolments; dev schemas are skipped.
    """
    if mode != "prod":
        return None
    try:
        home = profile_home_for_schema(schema, mode, hint=hint)
        if home is None:
            logger.warning(
                "No profile home derives schema %r; user folder for %s not %s",
                schema,
                user_id,
                "created" if active else "archived",
            )
            return None
        if active:
            return ensure_user_profile_dir(user_id, home)
        return archive_user_profile_dir(user_id, home)
    except (OSError, ValueError) as exc:
        logger.warning(
            "Could not %s the user folder for %s in schema %s: %s",
            "create" if active else "archive",
            user_id,
            schema,
            exc,
        )
        return None


@dataclass
class ProfileBackfill:
    """What :func:`backfill_user_profile_dirs` did in one profile home."""

    home: Path
    created: List[str] = field(default_factory=list)
    existing: List[str] = field(default_factory=list)
    skipped: str = ""
    errors: List[str] = field(default_factory=list)


async def _backfill_one(
    home: Path, *, dry_run: bool, config: Optional[Mapping[str, object]]
) -> ProfileBackfill:
    from agent.profile_runtime import profile_runtime_scope
    from hermes_cli.access import PrincipalStore
    from hermes_cli.config import load_config_readonly
    from hermes_cli.datastore import _dsn_missing, get_store

    report = ProfileBackfill(home=home)
    with profile_runtime_scope(home):
        store = get_store(
            "supabase-app",
            "prod",
            config=config if config is not None else (load_config_readonly() or {}),
        )
        if _dsn_missing(store.dsn):
            report.skipped = "no app datastore configured"
            return report
        try:
            principals = await PrincipalStore(store).list_principals(active=True)
        except Exception as exc:  # noqa: BLE001 - one bad profile must not stop the rest
            report.skipped = f"could not read principals: {exc}"
            return report
    for principal in principals:
        try:
            target = user_profile_dir(principal.user_id, home)
            if target.is_dir() and not target.is_symlink():
                report.existing.append(principal.user_id)
                continue
            if not dry_run:
                ensure_user_profile_dir(principal.user_id, home)
            report.created.append(principal.user_id)
        except (OSError, ValueError) as exc:
            report.errors.append(f"{principal.user_id}: {exc}")
    return report


async def backfill_user_profile_dirs(
    homes: Optional[Iterable[Path]] = None,
    *,
    dry_run: bool = False,
    config: Optional[Mapping[str, object]] = None,
) -> List[ProfileBackfill]:
    """Create the folder of every **active** principal in every profile.

    Idempotent: existing folders are reported, never touched. Inactive
    principals and folders with no principal are left alone. ``homes``
    defaults to :func:`box_profile_homes`; ``config`` overrides each profile's
    own ``config.yaml`` (tests only).
    """
    reports = []
    for home in homes if homes is not None else box_profile_homes():
        reports.append(await _backfill_one(Path(home), dry_run=dry_run, config=config))
    return reports
