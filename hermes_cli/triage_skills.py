"""Layered triage skills per user-profile (FG-03 P3).

Each triage kind (``email``, ``whatsapp``, ``calendar``, ``telegram``) reads three layers,
highest wins, matched by file *key*:

1. **built-in** — the box-wide folders the pipelines read today
   (``triage.skills_dirs`` + ``skills_subdirs``, see
   :func:`hermes_cli.triage_status.skill_sources`), falling back to the repo's
   ``custom/skills/<kind>-triage`` when none exist. Keys are
   ``<folder>/<file>`` (``email-triage/classify-emails.md``) or
   ``<folder>/<subdir>/<file>`` so email's two folders never collide.
2. **template** — ``<profile home>/triage-skills/<kind>/<key>``: the
   profile's version, edited by its owner/admins.
3. **user** — ``<profile home>/users/<user_id>/triage-skills/<kind>/<key>``:
   one person's version inside that profile, edited only by that person.

A layer can *override* a key (same key), *add* one (a new key, usually a
top-level ``<name>.md``) or *disable* one (an empty ``<key>.disabled``
marker). Overrides replace whole files; there is no line-level merge.
"Reset to template" deletes the user's override/marker for a key.

Every write (edit, disable, enable, reset) appends a version to
``<layer dir>/.versions/<key with / as __>.jsonl`` before the file changes,
the same History format as :mod:`hermes_cli.triage_status`.

Each kind also has a required **"What I care about"** section, the short text
the FG-03 P4 router reads to decide which of the owner's user-profiles get a
batch. It resolves user → template → built-in
(``custom/skills/triage-care/<kind>.md``) and can't be saved empty.

The ``triage-skills/`` folder sits outside ``skills/`` so agent skill
discovery never loads it, and inside ``users/`` it is already excluded from
clone/export (P1).
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from hermes_cli.triage_status import (
    DEFAULT_SKILL_DIRS,
    KINDS as STATUS_KINDS,
    MAX_SKILL_FILE_BYTES,
    SOURCE_DIRS,
    SkillFileError,
    kind_config,
    skill_sources,
)

LAYERS: tuple[str, ...] = ("builtin", "template", "user")
EDITABLE_LAYERS: tuple[str, ...] = ("template", "user")
TRIAGE_SKILLS_DIRNAME = "triage-skills"
CARE_KEY = "what-i-care-about.md"
CARE_BUILTIN_DIR = "custom/skills/triage-care"
DISABLED_SUFFIX = ".disabled"
VERSIONS_DIR = ".versions"
MAX_CARE_BYTES = 4 * 1024

_SEGMENT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_REPO_ROOT = Path(__file__).resolve().parent.parent
#: Triage kinds with layered skills: the status page's three, plus Telegram
#: (FG-03 P6), which has no box-wide legacy pipeline or status card.
KINDS: tuple[str, ...] = STATUS_KINDS + ("telegram",)
#: Source-registry channel → triage kind.
CHANNEL_KINDS: Dict[str, str] = {"email": "email", "whatsapp": "whatsapp", "telegram": "telegram"}

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class LayeredFile:
    """One key as the user-profile sees it."""

    key: str
    #: The layer whose content wins (``None`` when disabled).
    layer: Optional[str]
    #: The winning file (``None`` when disabled).
    path: Optional[Path]
    content: Optional[str]
    disabled: bool
    #: Which layers have this key: content, or a ``.disabled`` marker.
    layers_present: Dict[str, str]

    @property
    def enabled(self) -> bool:
        return not self.disabled

    def as_dict(self, *, with_content: bool = False) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "key": self.key,
            "layer": self.layer,
            "path": str(self.path) if self.path else None,
            "disabled": self.disabled,
            "layers": dict(self.layers_present),
        }
        if with_content:
            out["content"] = self.content
        return out


# -- keys and folders ------------------------------------------------------------


def validate_kind(kind: str) -> str:
    if kind not in KINDS:
        raise SkillFileError(404, f"unknown triage kind: {kind!r}")
    return kind


def validate_key(key: str) -> str:
    """A relative ``*.md`` key of 1–3 safe segments (no ``..``, no dot files)."""
    parts = key.split("/") if isinstance(key, str) else []
    if (
        not 1 <= len(parts) <= 3
        or not all(_SEGMENT_RE.match(p) for p in parts)
        or not parts[-1].endswith(".md")
        or any(p.startswith(".") or p == VERSIONS_DIR for p in parts)
    ):
        raise SkillFileError(400, f"invalid triage skill key: {key!r}")
    if key == CARE_KEY:
        raise SkillFileError(400, f'{CARE_KEY!r} is the "What I care about" section, not a skill file')
    return key


def template_dir(kind: str, home: Path) -> Path:
    return Path(home) / TRIAGE_SKILLS_DIRNAME / validate_kind(kind)


def user_dir(kind: str, home: Path, user_id: str) -> Path:
    from hermes_cli.user_profile_dirs import user_profile_dir

    try:
        folder = user_profile_dir(user_id, Path(home))
    except ValueError as exc:
        raise SkillFileError(400, str(exc)) from exc
    return folder / TRIAGE_SKILLS_DIRNAME / validate_kind(kind)


def layer_dir(kind: str, layer: str, home: Path, user_id: Optional[str]) -> Path:
    if layer == "template":
        root = template_dir(kind, home)
    elif layer == "user":
        if not user_id:
            raise SkillFileError(400, "the user layer needs a user id")
        root = user_dir(kind, home, user_id)
    else:
        raise SkillFileError(400, f"layer {layer!r} is not editable here")
    if not _inside(root, Path(home)):
        raise SkillFileError(400, f"the {layer} triage skills folder escapes the profile home")
    return root


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def _contained(path: Path, root: Path, what: str) -> Path:
    """``path`` if it is no symlink and resolves inside ``root`` (it may not exist yet)."""
    if path.is_symlink() or not _inside(path, root):
        raise SkillFileError(400, f"{what!r} escapes its layer folder")
    return path


def _layer_file(root: Path, key: str) -> Path:
    file = _contained(root / validate_key(key), root, key)
    _contained(Path(str(file) + DISABLED_SUFFIX), root, key)
    return file


# -- reading -------------------------------------------------------------------


def builtin_files(kind: str, config: Optional[Dict[str, Any]] = None) -> List[tuple[str, Path]]:
    """``(key, path)`` of the built-in layer, in the order ``load_skills`` reads.

    ``config`` defaults to the kind's box-wide ``config.json``. When none of
    those folders exist (dev boxes, tests) the repo's shipped sources are used.
    """
    validate_kind(kind)
    if config is None:
        _, config = kind_config(kind)
    out: List[tuple[str, Path]] = []
    for source in skill_sources(kind, config):
        prefix = source["name"]
        for f in source["files"]:
            out.append((f"{prefix}/{Path(f['path']).name}", Path(f["path"])))
    if not out:
        # Same folders the pipeline falls back to (email also reads WhatsApp's).
        shipped = {Path(d).name for d in SOURCE_DIRS.values()}
        for name in (Path(d).name for d in DEFAULT_SKILL_DIRS[kind]):
            src = _REPO_ROOT / Path(SOURCE_DIRS[kind]).parent / name
            if name in shipped:
                out.extend((f"{name}/{f.name}", f) for f in sorted(src.glob("*.md")))
    return out


def _scan_layer(root: Path) -> Dict[str, str]:
    """``key -> "content" | "disabled"`` for one template/user layer folder."""
    found: Dict[str, str] = {}
    if not root.is_dir():
        return found
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if any(p.startswith(".") for p in rel.split("/")) or not path.is_file():
            continue
        if path.is_symlink() or not _inside(path, root):
            continue
        if rel.endswith(".md" + DISABLED_SUFFIX):
            key = rel[: -len(DISABLED_SUFFIX)]
            state = "disabled"
        elif rel.endswith(".md"):
            key, state = rel, "content"
        else:
            continue
        if key == CARE_KEY:
            continue
        try:
            validate_key(key)
        except SkillFileError:
            continue
        # A content file and a marker for the same key: the marker wins.
        if found.get(key) != "disabled":
            found[key] = state
    return found


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SkillFileError(500, f"cannot read {path.name}: {exc.strerror or exc}") from exc


def resolve(
    kind: str,
    home: Path,
    user_id: Optional[str] = None,
    *,
    config: Optional[Dict[str, Any]] = None,
    with_content: bool = True,
) -> List[LayeredFile]:
    """Every key for ``kind`` in this user-profile, built-in order then added keys.

    ``user_id=None`` resolves the template view (built-in + template).
    The order is deterministic so :func:`compose_prompt` is byte-stable.
    """
    builtin = builtin_files(kind, config)
    tdir = template_dir(kind, home)
    udir = user_dir(kind, home, user_id) if user_id else None
    tmpl = _scan_layer(tdir)
    usr = _scan_layer(udir) if udir is not None else {}

    keys: List[str] = [k for k, _ in builtin]
    builtin_paths = dict(builtin)
    for k in sorted(set(tmpl) | set(usr)):
        if k not in builtin_paths:
            keys.append(k)

    out: List[LayeredFile] = []
    for key in keys:
        present: Dict[str, str] = {}
        if key in builtin_paths:
            present["builtin"] = "content"
        if key in tmpl:
            present["template"] = tmpl[key]
        if key in usr:
            present["user"] = usr[key]
        winner = None
        for layer in reversed(LAYERS):
            if layer in present:
                winner = layer
                break
        if winner is None or present[winner] == "disabled":
            out.append(LayeredFile(key, None, None, None, True, present))
            continue
        path = {
            "builtin": builtin_paths.get(key),
            "template": tdir / key,
            "user": (udir / key) if udir is not None else None,
        }[winner]
        content = _read(path) if with_content and path is not None else None
        out.append(LayeredFile(key, winner, path, content, False, present))
    return out


def compose_prompt(
    kind: str,
    home: Path,
    user_id: Optional[str] = None,
    *,
    config: Optional[Dict[str, Any]] = None,
) -> str:
    """The skills text for one user-profile, in today's ``load_skills`` format.

    ``## Skill: <file name>`` blocks joined by ``---``, enabled keys only,
    followed by the "What I care about" section. Same layers in → same bytes
    out (prompt-cache safe).
    """
    blocks = [
        f"## Skill: {Path(f.key).name}\n{f.content}"
        for f in resolve(kind, home, user_id, config=config)
        if f.enabled and f.content is not None
    ]
    care = care_section(kind, home, user_id)
    blocks.append(f"## Skill: {CARE_KEY}\n{care['content']}")
    return "\n\n---\n\n".join(blocks)


def layer_content(kind: str, layer: str, key: str, home: Path, user_id: Optional[str] = None,
                  *, config: Optional[Dict[str, Any]] = None) -> Optional[str]:
    """The raw content one layer holds for ``key`` (``None`` if none/disabled)."""
    validate_key(key)
    if layer == "builtin":
        path = dict(builtin_files(kind, config)).get(key)
        return _read(path) if path else None
    file = _layer_file(layer_dir(kind, layer, home, user_id), key)
    if Path(str(file) + DISABLED_SUFFIX).exists() or not file.is_file():
        return None
    return _read(file)


def diff(kind: str, key: str, home: Path, user_id: str, *,
         config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """The template view vs this user's view of one key (unified diff text)."""
    import difflib

    mine = {f.key: f for f in resolve(kind, home, user_id, config=config)}
    theirs = {f.key: f for f in resolve(kind, home, None, config=config)}
    a, b = theirs.get(key), mine.get(key)
    if a is None and b is None:
        raise SkillFileError(404, f"no triage skill {key!r} for {kind}")
    a_text = "" if a is None or a.disabled else (a.content or "")
    b_text = "" if b is None or b.disabled else (b.content or "")
    lines = difflib.unified_diff(
        a_text.splitlines(keepends=True), b_text.splitlines(keepends=True),
        fromfile=f"template/{key}", tofile=f"mine/{key}",
    )
    return {
        "key": key,
        "template_disabled": bool(a and a.disabled),
        "mine_disabled": bool(b and b.disabled),
        "changed": a_text != b_text or bool(a and a.disabled) != bool(b and b.disabled),
        "diff": "".join(lines),
    }


# -- "What I care about" ---------------------------------------------------------


def _builtin_care(kind: str) -> str:
    path = _REPO_ROOT / CARE_BUILTIN_DIR / f"{kind}.md"
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return f"Anything in my {kind} that needs me to act, decide or reply."


def care_section(kind: str, home: Path, user_id: Optional[str] = None) -> Dict[str, Any]:
    """``{"layer", "content"}`` of the required "What I care about" section."""
    validate_kind(kind)
    candidates = []
    if user_id:
        candidates.append(("user", user_dir(kind, home, user_id) / CARE_KEY))
    candidates.append(("template", template_dir(kind, home) / CARE_KEY))
    for layer, path in candidates:
        if path.is_file() and not path.is_symlink():
            text = _read(path)
            if text.strip():
                return {"layer": layer, "content": text}
    return {"layer": "builtin", "content": _builtin_care(kind)}


# -- history -------------------------------------------------------------------


def _history_file(root: Path, key: str) -> Path:
    versions = _contained(root / VERSIONS_DIR, root, VERSIONS_DIR)
    return _contained(versions / (key.replace("/", "__") + ".jsonl"), root, key)


def history(kind: str, layer: str, key: str, home: Path, user_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """Saved versions of one key in one layer, newest first."""
    if key != CARE_KEY:
        validate_key(key)
    return _history_records(_history_file(layer_dir(kind, layer, home, user_id), key))


def _history_records(hist: Path) -> List[Dict[str, Any]]:
    """Newest first; unreadable lines are skipped."""
    try:
        lines = hist.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return list(reversed(out))


def _version(action: str, content: Optional[str], *, author: str, message: str, seq: int) -> Dict[str, Any]:
    now = time.time()
    return {
        "id": f"{int(now * 1000)}-{seq}",
        "at": now,
        "author": author,
        "action": action,
        "message": message,
        "content": content,
    }


def _ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        pass


def _append_history(root: Path, key: str, records: Sequence[Dict[str, Any]]) -> tuple[Path, Optional[int]]:
    hist = _history_file(root, key)
    _ensure_dir(hist.parent)
    size = hist.stat().st_size if hist.exists() else None
    with hist.open("a", encoding="utf-8") as fh:
        fh.write("".join(json.dumps(r) + "\n" for r in records))
        fh.flush()
        os.fsync(fh.fileno())
    return hist, size


def _rollback(hist: Path, size: Optional[int]) -> None:
    try:
        if size is None:
            hist.unlink(missing_ok=True)
        else:
            with hist.open("r+b") as fh:
                fh.truncate(size)
    except OSError:
        pass


def _apply(root: Path, key: str, *, action: str, content: Optional[str], author: str,
           message: str, before: Optional[str], change) -> Dict[str, Any]:
    """Record the version, then run ``change()``; undo the record if it fails."""
    existing = history_from_root(root, key)
    records = []
    if not existing and before is not None:
        records.append(_version("baseline", before, author="system", message="Before the first change", seq=1))
    version = _version(action, content, author=author, message=message, seq=len(existing) + len(records) + 1)
    records.append(version)
    try:
        hist, size = _append_history(root, key, records)
    except OSError as exc:
        raise SkillFileError(500, f"could not record history: {exc.strerror or exc}") from exc
    try:
        change()
    except BaseException as exc:
        _rollback(hist, size)
        if isinstance(exc, OSError):
            raise SkillFileError(500, f"could not save {key}: {exc.strerror or exc}") from exc
        raise
    return version


def history_from_root(root: Path, key: str) -> List[Dict[str, Any]]:
    """Saved versions of one key in one layer folder, oldest first."""
    return list(reversed(_history_records(_history_file(root, key))))


def _atomic_write(file: Path, content: str) -> None:
    _ensure_dir(file.parent)
    fd, tmp = tempfile.mkstemp(dir=str(file.parent), prefix=f".{file.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(content)
        os.chmod(tmp, 0o600)
        os.replace(tmp, file)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# -- writing -------------------------------------------------------------------


def _effective_below(kind: str, layer: str, key: str, home: Path, user_id: Optional[str],
                     config: Optional[Dict[str, Any]]) -> Optional[str]:
    """What ``key`` shows *under* ``layer`` (template for user, built-in for template)."""
    if layer == "user":
        f = next((f for f in resolve(kind, home, None, config=config) if f.key == key), None)
        return None if f is None or f.disabled else f.content
    path = dict(builtin_files(kind, config)).get(key)
    return _read(path) if path else None


def write_file(kind: str, layer: str, key: str, content: str, *, home: Path,
               user_id: Optional[str] = None, author: str,
               config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Override or add ``key`` in ``layer``; clears that layer's disable marker."""
    if len(content.encode("utf-8")) > MAX_SKILL_FILE_BYTES:
        raise SkillFileError(413, "triage skill file is too large")
    root = layer_dir(kind, layer, home, user_id)
    file = _layer_file(root, key)
    marker = Path(str(file) + DISABLED_SUFFIX)
    before = _read(file) if file.is_file() else _effective_below(kind, layer, key, home, user_id, config)

    def change() -> None:
        _atomic_write(file, content)
        marker.unlink(missing_ok=True)

    return _apply(root, key, action="edit", content=content, author=author,
                  message="Edited", before=before, change=change)


def set_disabled(kind: str, layer: str, key: str, disabled: bool, *, home: Path,
                 user_id: Optional[str] = None, author: str,
                 config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Turn ``key`` off (marker) or back on (remove marker) in ``layer``.

    Turning on a key a *lower* layer disabled copies nothing; the caller
    should :func:`write_file` their own text instead (raises 409).
    """
    root = layer_dir(kind, layer, home, user_id)
    file = _layer_file(root, key)
    marker = Path(str(file) + DISABLED_SUFFIX)
    view = resolve(kind, home, user_id if layer == "user" else None, config=config, with_content=False)
    f = next((f for f in view if f.key == key), None)
    if f is None:
        raise SkillFileError(404, f"no triage skill {key!r} for {kind}")
    if not disabled:
        # Without this layer's marker, would a lower layer still turn it off?
        below = None if layer == "template" else next(
            (t for t in resolve(kind, home, None, config=config, with_content=False) if t.key == key), None)
        if not file.is_file() and below is not None and below.disabled:
            raise SkillFileError(409, f"{key!r} is turned off in the template; save your own version to use it")
        if not marker.exists():
            return {"action": "enable", "noop": True}
    if disabled and marker.exists():
        return {"action": "disable", "noop": True}
    before = _read(file) if file.is_file() else None

    def change() -> None:
        if disabled:
            _ensure_dir(marker.parent)
            marker.write_text("", encoding="utf-8")
        else:
            marker.unlink(missing_ok=True)

    return _apply(root, key, action="disable" if disabled else "enable", content=None,
                  author=author, message="Turned off" if disabled else "Turned on",
                  before=before, change=change)


def reset_file(kind: str, key: str, *, home: Path, user_id: str, author: str) -> Dict[str, Any]:
    """Reset to template: drop this user's override/marker for ``key``."""
    root = layer_dir(kind, "user", home, user_id)
    file = _layer_file(root, key)
    marker = Path(str(file) + DISABLED_SUFFIX)
    if not file.exists() and not marker.exists():
        return {"action": "reset", "noop": True}
    before = _read(file) if file.is_file() else None

    def change() -> None:
        file.unlink(missing_ok=True)
        marker.unlink(missing_ok=True)

    return _apply(root, key, action="reset", content=None, author=author,
                  message="Reset to template", before=before, change=change)


def reset_all(kind: str, *, home: Path, user_id: str, author: str) -> List[str]:
    """Reset every key this user changed for ``kind``; returns the keys reset."""
    root = layer_dir(kind, "user", home, user_id)
    done = []
    for key in sorted(_scan_layer(root)):
        if not reset_file(kind, key, home=home, user_id=user_id, author=author).get("noop"):
            done.append(key)
    care = root / CARE_KEY
    if care.is_file():
        reset_care(kind, home=home, user_id=user_id, author=author)
        done.append(CARE_KEY)
    return done


def write_care(kind: str, content: str, *, layer: str, home: Path,
               user_id: Optional[str] = None, author: str) -> Dict[str, Any]:
    """Save the "What I care about" section in ``layer``; empty text is refused."""
    if not content.strip():
        raise SkillFileError(422, '"What I care about" can\'t be empty')
    if len(content.encode("utf-8")) > MAX_CARE_BYTES:
        raise SkillFileError(413, '"What I care about" is too long (4 KB max)')
    root = layer_dir(kind, layer, home, user_id)
    file = _contained(root / CARE_KEY, root, CARE_KEY)
    before = care_section(kind, home, user_id if layer == "user" else None)["content"]
    return _apply(root, CARE_KEY, action="edit", content=content, author=author,
                  message="Edited", before=before, change=lambda: _atomic_write(file, content))


def reset_care(kind: str, *, home: Path, user_id: str, author: str) -> Dict[str, Any]:
    root = layer_dir(kind, "user", home, user_id)
    file = root / CARE_KEY
    if not file.exists() and not file.is_symlink():
        return {"action": "reset", "noop": True}
    before = _read(file) if file.is_file() and not file.is_symlink() else None
    return _apply(root, CARE_KEY, action="reset", content=None, author=author,
                  message="Reset to template", before=before,
                  change=lambda: file.unlink(missing_ok=True))


# -- permissions -----------------------------------------------------------------


def can_edit_layer(layer: str, principal: Any, user_id: Optional[str] = None) -> bool:
    """Template: the profile's owner/admins. User layer: only that person."""
    if layer == "template":
        from hermes_cli.route_roles import ADMIN_ROLES

        return bool(getattr(principal, "is_owner", False)) or getattr(principal, "role", None) in ADMIN_ROLES
    if layer == "user":
        me = getattr(principal, "user_id", None)
        return bool(me) and me == user_id
    return False


# -- router input (FG-03 P4) -----------------------------------------------------


async def care_sections_for_source(
    connection: Any, source_id: str, kind: Optional[str] = None
) -> List[Dict[str, Any]]:
    """What the router reads for one batch from ``source_id``.

    One ``{"profile", "user_id", "home", "care", "layer"}`` per enabled route
    of an enabled source, in profile order: the source owner's "What I care
    about" in that profile (``layer`` says which layer it came from). Only the
    owner's own user layer is read. ``kind`` defaults to the source channel's
    triage kind; an unknown source gives ``[]``. A routed profile whose home
    is gone is skipped, and so is one where the owner is no longer eligible to
    route (suspended, or now a ``viewer``): a stale route never delivers.
    """
    from hermes_cli import source_registry as registry
    from hermes_cli.profiles import get_profile_dir

    source = await registry.get_source(connection, source_id)
    if source is None:
        return []
    channel_kind = CHANNEL_KINDS.get(source.channel)
    if kind is not None and kind != channel_kind:
        raise SkillFileError(400, f"a {source.channel} source has no {kind!r} triage")
    if channel_kind is None:
        return []
    out: List[Dict[str, Any]] = []
    for profile in await registry.routed_profiles(connection, source.source_id):
        home = get_profile_dir(profile)
        if not home.is_dir():
            logger.warning("triage routing: profile %r has no home at %s; skipped", profile, home)
            continue
        try:
            eligible = await registry.may_route_to(source.owner_user_id, profile)
        except Exception as exc:  # noqa: BLE001 - unverifiable means not eligible
            logger.warning("triage routing: could not check %r for this source: %s", profile, exc)
            eligible = False
        if not eligible:
            logger.info("triage routing: owner not eligible in profile %r; skipped", profile)
            continue
        care = care_section(channel_kind, home, source.owner_user_id)
        out.append({
            "profile": profile,
            "user_id": source.owner_user_id,
            "home": str(home),
            "care": care["content"],
            "layer": care["layer"],
        })
    return out
