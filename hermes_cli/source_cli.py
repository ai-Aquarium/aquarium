"""``hermes source`` — the box-wide registry of incoming sources (FG-03 P2).

One mailbox / WhatsApp number / Telegram bot has one owner and routes only to
the owner's chosen user-profiles. Runs on the box as the operator; writes act
as ``--as`` (default: the default profile's owner), and the store still
enforces that only a source's owner changes its routes.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any, Awaitable, Callable

from hermes_cli import source_registry as registry


def _owner_user_id() -> str:
    from hermes_cli.access import PrincipalStore
    from hermes_cli.datastore import get_store

    owner = asyncio.run(PrincipalStore(get_store("supabase-app", "prod")).get_owner())
    if owner is None:
        print("No owner is enrolled; run 'hermes owner init <user_id>' first.", file=sys.stderr)
        raise SystemExit(1)
    return owner.user_id


def _actor(args: argparse.Namespace) -> str:
    return (getattr(args, "as_user", None) or "").strip() or _owner_user_id()


def _run(fn: Callable[[Any], Awaitable[Any]]) -> Any:
    async def main():
        connection = await registry.connect_box()
        try:
            return await fn(connection)
        finally:
            await connection.close()

    try:
        return asyncio.run(main())
    except registry.SourceRegistryError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from error


async def _resolve(connection: Any, ref: str) -> registry.Source:
    """A source by id, or by ``channel:address`` (e.g. ``email:john@example.com``)."""
    source = await registry.get_source(connection, ref)
    if source is None and ":" in ref:
        channel, address = ref.split(":", 1)
        if channel.strip().lower() in registry.CHANNELS:
            source = await registry.get_source_by_address(connection, channel, address)
    if source is None:
        raise registry.SourceNotFound(f"No such source: {ref}")
    return source


def _emit(args: argparse.Namespace, payload: Any, text: str) -> None:
    if getattr(args, "json", False):
        print(json.dumps(payload, indent=2, default=str))
    else:
        print(text)


def _describe(source: registry.Source) -> str:
    routes = ", ".join(
        f"{r.profile_slug}{'' if r.enabled else ' (off)'}" for r in source.routes
    ) or "not routed"
    state = "" if source.enabled else " [disabled]"
    label = f" ({source.display})" if source.display else ""
    return (
        f"{source.channel:9} {source.address}{label}{state}\n"
        f"          id {source.source_id}  owner {source.owner_user_id}  -> {routes}"
    )


def source_list_command(args: argparse.Namespace) -> int:
    owner = None if args.all else _actor(args)
    sources = _run(lambda c: registry.list_sources(c, owner_user_id=owner, channel=args.channel))
    _emit(
        args,
        {"sources": [s.as_dict() for s in sources]},
        "\n".join(_describe(s) for s in sources) or "No sources registered.",
    )
    return 0


def source_register_command(args: argparse.Namespace) -> int:
    owner = (args.owner or "").strip() or _actor(args)
    source = _run(lambda c: registry.register_source(
        c, channel=args.channel, address=args.address,
        owner_user_id=owner, display=args.display,
    ))
    _emit(args, {"source": source.as_dict()}, f"Registered:\n{_describe(source)}")
    return 0


def _route(args: argparse.Namespace, enabled: bool) -> int:
    actor = _actor(args)

    async def run(connection):
        source = await _resolve(connection, args.source)
        return await registry.set_route(
            connection, source_id=source.source_id, profile_slug=args.profile,
            enabled=enabled, actor_user_id=actor,
        )

    route = _run(run)
    verb = "Routed" if enabled else "Unrouted"
    _emit(args, {"route": route.as_dict()}, f"{verb} {args.source} -> {route.profile_slug}")
    return 0


def source_route_command(args: argparse.Namespace) -> int:
    return _route(args, True)


def source_unroute_command(args: argparse.Namespace) -> int:
    return _route(args, False)


def source_remove_command(args: argparse.Namespace) -> int:
    actor = _actor(args)

    async def run(connection):
        source = await _resolve(connection, args.source)
        return await registry.remove_source(
            connection, source_id=source.source_id, actor_user_id=actor
        )

    deleted = _run(run)
    _emit(args, {"deleted": deleted}, f"Removed {args.source}." if deleted else "Nothing removed.")
    return 0


def source_conflicts_command(args: argparse.Namespace) -> int:
    rows = _run(lambda c: registry.list_conflicts(c, include_resolved=args.resolved))
    text = "\n".join(
        f"#{c.conflict_id} {c.channel} {c.address}: {c.claimant_user_id} claimed, "
        f"owner {c.existing_owner_user_id or '-'}"
        f"{' (resolved)' if c.resolved_at else ''} — {c.detail}"
        for c in rows
    ) or "No conflicts."
    _emit(args, {"conflicts": [c.as_dict() for c in rows]}, text)
    return 0


def register_source_subparser(subparsers: argparse._SubParsersAction) -> None:
    """Register ``hermes source`` and its sub-actions."""
    parser = subparsers.add_parser(
        "source",
        help="Incoming sources (mailbox / WhatsApp number / Telegram bot) and their routes",
        description=(
            "The box-wide registry of incoming sources. Each source has one "
            "owner and is read only by the owner's profiles it routes to."
        ),
    )
    sub = parser.add_subparsers(dest="source_command", required=True)
    from hermes_cli.source_migrate import add_migrate_parser

    add_migrate_parser(sub)

    def common(p: argparse.ArgumentParser, *, actor: bool = True) -> None:
        p.add_argument("--json", action="store_true", help="Print JSON")
        if actor:
            p.add_argument(
                "--as", dest="as_user", default=None,
                help="Act as this user id (default: the default profile's owner)",
            )

    lst = sub.add_parser("list", help="List sources and their routes")
    lst.add_argument("--all", action="store_true", help="Every owner's sources")
    lst.add_argument("--channel", choices=list(registry.CHANNELS), default=None)
    common(lst)
    lst.set_defaults(func=source_list_command)

    reg = sub.add_parser("register", help="Register a source to one owner")
    reg.add_argument("channel", choices=list(registry.CHANNELS))
    reg.add_argument("address", help="Email address, WhatsApp number or Telegram bot id")
    reg.add_argument("--owner", default=None, help="Owner user id (default: --as)")
    reg.add_argument("--display", default=None, help="Display label")
    common(reg)
    reg.set_defaults(func=source_register_command)

    for name, func, text in (
        ("route", source_route_command, "Route a source to one of its owner's profiles"),
        ("unroute", source_unroute_command, "Stop routing a source to a profile"),
    ):
        p = sub.add_parser(name, help=text)
        p.add_argument("source", help="Source id or channel:address")
        p.add_argument("profile", help="Profile name (e.g. default, cfo)")
        common(p)
        p.set_defaults(func=func)

    rm = sub.add_parser("remove", help="Remove a source and its routes")
    rm.add_argument("source", help="Source id or channel:address")
    common(rm)
    rm.set_defaults(func=source_remove_command)

    con = sub.add_parser("conflicts", help="List refused / disputed claims")
    con.add_argument("--resolved", action="store_true", help="Include resolved ones")
    common(con, actor=False)
    con.set_defaults(func=source_conflicts_command)
