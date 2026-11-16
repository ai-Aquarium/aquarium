"""``hermes triage skills`` — layered triage skills per user-profile (FG-03 P3).

Each kind (email / whatsapp / calendar) reads built-in → the profile's
template → one person's own version (see :mod:`hermes_cli.triage_skills`).
Runs on the box as the operator: ``--profile`` picks the profile (default:
the active one, as ``hermes -p``), ``--user UID`` addresses that person's
layer and ``--template`` the profile's template.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

from hermes_cli import triage_skills
from hermes_cli.triage_status import KINDS, SkillFileError

CLI_AUTHOR = "cli:operator"


def _home(args: argparse.Namespace) -> Path:
    name = (getattr(args, "profile", None) or "").strip()
    if not name:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    from hermes_cli.profile_registry import get_profile_registry

    entry = next((e for e in get_profile_registry() if e.name == name), None)
    if entry is None or not Path(entry.hermes_home).is_dir():
        raise SkillFileError(404, f"no such profile: {name!r}")
    return Path(entry.hermes_home)


def _user(args: argparse.Namespace) -> Optional[str]:
    return (getattr(args, "user", None) or "").strip() or None


def _layer(args: argparse.Namespace) -> str:
    """The editable layer a write addresses: ``--template`` or ``--user UID``."""
    if getattr(args, "template", False):
        return "template"
    if _user(args):
        return "user"
    raise SkillFileError(400, "say which layer: --template or --user UID")


def _emit(args: argparse.Namespace, payload: Any, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, default=str))
    else:
        print(text)


def _content(args: argparse.Namespace) -> str:
    if getattr(args, "text", None) is not None:
        return args.text
    if getattr(args, "file", None):
        return Path(args.file).read_text(encoding="utf-8")
    return sys.stdin.read()


def _describe(f: triage_skills.LayeredFile) -> str:
    where = "off" if f.disabled else f.layer
    layers = ",".join(f"{k}{'(off)' if v == 'disabled' else ''}" for k, v in f.layers_present.items())
    return f"{f.key:48} {where:9} [{layers}]"


def skills_list_command(args: argparse.Namespace) -> int:
    home, user = _home(args), _user(args)
    files = triage_skills.resolve(args.kind, home, user, with_content=False)
    care = triage_skills.care_section(args.kind, home, user)
    payload = {
        "kind": args.kind, "home": str(home), "user_id": user,
        "files": [f.as_dict() for f in files],
        "care": {"key": triage_skills.CARE_KEY, **care},
    }
    lines = [_describe(f) for f in files]
    lines.append(f"{triage_skills.CARE_KEY:48} {care['layer']}")
    _emit(args, payload, "\n".join(lines))
    return 0


def skills_show_command(args: argparse.Namespace) -> int:
    home, user = _home(args), _user(args)
    if args.layer == "effective":
        f = next((f for f in triage_skills.resolve(args.kind, home, user) if f.key == args.key), None)
        if f is None:
            raise SkillFileError(404, f"no triage skill {args.key!r} for {args.kind}")
        layer, content, disabled = f.layer, f.content, f.disabled
    else:
        layer = args.layer
        content = triage_skills.layer_content(args.kind, layer, args.key, home, user)
        disabled = None
    payload = {"kind": args.kind, "key": args.key, "layer": layer, "disabled": disabled, "content": content}
    text = content if content is not None else f"({args.key} is {'turned off' if disabled else 'not in this layer'})"
    _emit(args, payload, text)
    return 0


def skills_edit_command(args: argparse.Namespace) -> int:
    layer, home = _layer(args), _home(args)
    version = triage_skills.write_file(
        args.kind, layer, args.key, _content(args), home=home, user_id=_user(args), author=CLI_AUTHOR,
    )
    _emit(args, {"ok": True, "layer": layer, "key": args.key, "version": version["id"]},
          f"Saved {args.key} in the {layer} layer.")
    return 0


def _set_disabled(args: argparse.Namespace, disabled: bool) -> int:
    layer, home = _layer(args), _home(args)
    result = triage_skills.set_disabled(
        args.kind, layer, args.key, disabled, home=home, user_id=_user(args), author=CLI_AUTHOR,
    )
    verb = "Turned off" if disabled else "Turned on"
    _emit(args, {"ok": True, "layer": layer, "key": args.key, "disabled": disabled,
                 "noop": bool(result.get("noop"))},
          f"{verb} {args.key} in the {layer} layer." + (" (no change)" if result.get("noop") else ""))
    return 0


def skills_disable_command(args: argparse.Namespace) -> int:
    return _set_disabled(args, True)


def skills_enable_command(args: argparse.Namespace) -> int:
    return _set_disabled(args, False)


def skills_reset_command(args: argparse.Namespace) -> int:
    user, home = _user(args), _home(args)
    if not user:
        raise SkillFileError(400, "reset needs --user UID (it drops that person's version)")
    if args.key:
        result = triage_skills.reset_file(args.kind, args.key, home=home, user_id=user, author=CLI_AUTHOR)
        keys = [] if result.get("noop") else [args.key]
    else:
        keys = triage_skills.reset_all(args.kind, home=home, user_id=user, author=CLI_AUTHOR)
    _emit(args, {"ok": True, "reset": keys},
          ("Reset to template: " + ", ".join(keys)) if keys else "Nothing to reset.")
    return 0


def skills_care_command(args: argparse.Namespace) -> int:
    home, user = _home(args), _user(args)
    if args.text is not None or args.file:
        layer = _layer(args)
        triage_skills.write_care(args.kind, _content(args), layer=layer, home=home,
                                 user_id=user, author=CLI_AUTHOR)
    care = triage_skills.care_section(args.kind, home, None if args.template else user)
    _emit(args, {"kind": args.kind, **care}, care["content"])
    return 0


def skills_history_command(args: argparse.Namespace) -> int:
    layer = _layer(args)
    versions = triage_skills.history(args.kind, layer, args.key, _home(args), _user(args))
    text = "\n".join(
        f"{v.get('id')}  {v.get('action', ''):8} {v.get('author', '')}  {v.get('message', '')}"
        for v in versions
    ) or "No history."
    _emit(args, {"kind": args.kind, "layer": layer, "key": args.key, "versions": versions}, text)
    return 0


def skills_diff_command(args: argparse.Namespace) -> int:
    user = _user(args)
    if not user:
        raise SkillFileError(400, "diff needs --user UID (template vs that person's version)")
    result = triage_skills.diff(args.kind, args.key, _home(args), user)
    _emit(args, result, result["diff"] or "Same as the template.")
    return 0


def _guarded(func):
    def run(args: argparse.Namespace) -> int:
        try:
            return func(args)
        except SkillFileError as error:
            print(f"error ({error.status}): {error.detail}", file=sys.stderr)
            raise SystemExit(1) from error
        except (ValueError, OSError) as error:
            print(f"error: {error}", file=sys.stderr)
            raise SystemExit(1) from error

    return run


def register_triage_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes triage`` (and ``hermes triage skills ...``)."""
    parser = subparsers.add_parser(
        "triage",
        help="Triage pipelines (email / WhatsApp / calendar)",
        description="Triage pipelines: the skills each profile and person triages with.",
    )
    sub = parser.add_subparsers(dest="triage_command", required=True)
    skills = sub.add_parser(
        "skills",
        help="Layered triage skills: built-in → profile template → a person's own version",
        description=(
            "Each triage kind reads built-in skills, then the profile's template, "
            "then one person's own version (override, add or turn off whole files)."
        ),
    )
    actions = skills.add_subparsers(dest="skills_command", required=True)

    def common(p: argparse.ArgumentParser, *, who: str = "optional") -> None:
        p.add_argument("--kind", required=True, choices=list(KINDS))
        p.add_argument("--profile", default=None, help="Profile name (default: the active profile)")
        p.add_argument("--json", action="store_true", help="Print JSON")
        if who == "user":
            p.add_argument("--user", required=True, metavar="UID", help="That person's version")
            return
        group = p.add_mutually_exclusive_group(required=who == "layer")
        group.add_argument("--user", metavar="UID", help="That person's version in the profile")
        group.add_argument("--template", action="store_true", help="The profile's template")

    def text_source(p: argparse.ArgumentParser) -> None:
        src = p.add_mutually_exclusive_group()
        src.add_argument("--text", default=None, help="The new text")
        src.add_argument("--file", default=None, help="Read the new text from this file")

    def add(name: str, func, help_text: str, *, key: str = "required", who: str = "optional"):
        p = actions.add_parser(name, help=help_text)
        if key == "required":
            p.add_argument("key", help="Skill key, e.g. email-triage/classify-emails.md")
        elif key == "optional":
            p.add_argument("key", nargs="?", default=None, help="Skill key (omit: every key)")
        common(p, who=who)
        p.set_defaults(func=_guarded(func))
        return p

    add("list", skills_list_command, "Every key, which layer wins and which are off", key="none")
    show = add("show", skills_show_command, "Print one key (the winning text, or one layer's)")
    show.add_argument("--layer", default="effective", choices=["effective", *triage_skills.LAYERS])
    text_source(add("edit", skills_edit_command,
                    "Save a key in the template or a person's layer (text from --text/--file/stdin)",
                    who="layer"))
    add("disable", skills_disable_command, "Turn a key off in a layer", who="layer")
    add("enable", skills_enable_command, "Turn a key back on in a layer", who="layer")
    add("reset", skills_reset_command, "Reset a person's version to the template", key="optional", who="user")
    text_source(add("care", skills_care_command,
                    'Show or set the required "What I care about" section', key="none"))
    add("history", skills_history_command, "Saved versions of a key in one layer", who="layer")
    add("diff", skills_diff_command, "Template vs a person's version of a key", who="user")
