"""Per-person MySQL and SQLite connections (data-dictionary plan, Phase 7).

The same model as Settings' SQL Server connections
(:mod:`hermes_cli.mssql_connections`): each connection is a private entry in
the credential store, only its owner lists, edits, tests or reads through it,
and passwords are write-only. Each connection becomes a data source with a
dictionary (:mod:`hermes_cli.data_engines`).

SQLite files are read from the box itself, so only the profile owner or an
admin may add one, and only under the folders in ``data_sources.sqlite_roots``
(``config.yaml``; default ``<HERMES_HOME>/data-sources``).
"""

from __future__ import annotations

import contextlib
import hashlib
import ssl
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

from hermes_cli.credential_store import (
    Credential,
    CredentialError,
    default_credential_store,
    merge_kept_secrets,
)
from hermes_cli.data_engines import EngineError

ENGINES = ("mysql", "sqlite")
MYSQL_DEFAULT_PORT = 3306
TLS_MODES = ("verify", "on", "off")
_MYSQL_TEXT = ("host", "database", "username", "vpn", "label")


def normalize_name(name: Any) -> str:
    from hermes_cli import mssql_connections as mssql

    try:
        return mssql.normalize_name(name)
    except mssql.MssqlError as exc:
        raise EngineError(str(exc), exc.status) from None


def _engine(engine: Any) -> str:
    engine = str(engine or "").strip().lower()
    if engine not in ENGINES:
        raise EngineError(f"engine must be one of {', '.join(ENGINES)}", 404)
    return engine


def mysql_driver():
    try:
        import pymysql
    except ImportError:
        try:
            from tools.lazy_deps import ensure

            ensure("mysql.driver", prompt=False)
            import pymysql
        except Exception as exc:
            raise EngineError(
                "MySQL support is not installed on this server (the 'mysql' extra)", 503
            ) from exc
    return pymysql


def driver_available(engine: str) -> bool:
    if engine == "sqlite":
        return True
    try:
        import pymysql  # noqa: F401
    except Exception:
        return False
    return True


def mysql_ssl(payload: Mapping[str, Any]) -> Optional[ssl.SSLContext]:
    """The TLS context for a MySQL payload (None = no TLS)."""
    mode = payload.get("tls") or "verify"
    if mode == "off":
        return None
    if mode == "on":
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # pragma: no cover - certifi is a core dependency
        return ssl.create_default_context()


def sqlite_roots() -> List[Path]:
    from hermes_cli.config import load_config_readonly
    from hermes_constants import get_hermes_home

    cfg = (load_config_readonly() or {}).get("data_sources") or {}
    roots = cfg.get("sqlite_roots") if isinstance(cfg, Mapping) else None
    if not roots:
        roots = [str(get_hermes_home() / "data-sources")]
    if isinstance(roots, str):
        roots = [roots]
    return [Path(str(r)).expanduser().resolve() for r in roots]


def sqlite_path(value: Any) -> Path:
    """The resolved file, or :class:`EngineError` unless it is a file inside a SQLite root."""
    text = str(value or "").strip()
    if not text:
        raise EngineError("path is required")
    path = Path(text).expanduser()
    if not path.is_absolute():
        raise EngineError("path must be absolute")
    resolved = path.resolve()
    roots = sqlite_roots()
    if not any(resolved == r or r in resolved.parents for r in roots):
        raise EngineError(
            "SQLite files must be inside " + ", ".join(str(r) for r in roots)
            + " (config.yaml data_sources.sqlite_roots)",
            403,
        )
    if not resolved.is_file():
        raise EngineError("no such SQLite file")
    return resolved


def _own_sqlite_folder(principal: Any, path: Path) -> None:
    """Members add only files in their own ``<root>/<user_id>/`` folder; admins any root.

    Otherwise anyone could register a file someone else keeps private.
    """
    from hermes_cli import site_sources as ss

    if ss._is_profile_admin(principal):
        return
    user_id = str(getattr(principal, "user_id", "") or "")
    folders = [r / user_id for r in sqlite_roots()] if user_id else []
    if not any(f in path.parents for f in folders):
        raise EngineError(
            "you can add SQLite files from your own folder: "
            + ", ".join(str(f) for f in folders),
            403,
        )


# -- store ------------------------------------------------------------------------------


async def own_entries(principal: Any, engine: Optional[str] = None) -> List[Credential]:
    """The caller's OWN MySQL/SQLite connections — never another person's."""
    user_id = getattr(principal, "user_id", None)
    entries = await default_credential_store().list(principal)
    return [
        e for e in entries
        if e.provider in ENGINES and e.kind == e.provider and e.owner_user_id == user_id
        and (engine is None or e.provider == engine)
    ]


async def find_own(principal: Any, engine: str, name: str) -> Optional[Credential]:
    for entry in await own_entries(principal, engine):
        if entry.name == name:
            return entry
    return None


async def _own(principal: Any, engine: str, name: str) -> Credential:
    entry = await find_own(principal, engine, name)
    if entry is None:
        raise EngineError(f"no {engine} connection with that name", 404)
    return entry


def view_of(cred: Credential) -> Dict[str, Any]:
    p = cred.payload
    out: Dict[str, Any] = {"engine": cred.provider, "name": cred.name, "label": p.get("label") or ""}
    if cred.provider == "mysql":
        out.update(
            host=p.get("host", ""),
            port=p.get("port") or MYSQL_DEFAULT_PORT,
            database=p.get("database", ""),
            username=p.get("username", ""),
            tls=p.get("tls") or "verify",
            vpn=p.get("vpn") or "",
            password_set=bool(p.get("password")),
        )
    else:
        out["path"] = p.get("path", "")
    return out


def _payload(engine: str, body: Mapping[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    label = str(body.get("label") or "").strip()
    if label:
        payload["label"] = label[:200]
    if engine == "sqlite":
        payload["path"] = str(sqlite_path(body.get("path")))
        return payload
    for field in _MYSQL_TEXT:
        value = body.get(field)
        if value is not None and str(value).strip():
            payload[field] = str(value).strip()[:500]
    for field in ("host", "database", "username"):
        if not payload.get(field):
            raise EngineError(f"{field} is required")
    port = body.get("port")
    try:
        payload["port"] = int(port) if port not in (None, "") else MYSQL_DEFAULT_PORT
    except (TypeError, ValueError):
        raise EngineError("port must be a number") from None
    tls = body.get("tls") or "verify"
    if tls not in TLS_MODES:
        raise EngineError(f"tls must be one of {', '.join(TLS_MODES)}")
    payload["tls"] = tls
    password = body.get("password")
    if isinstance(password, str) and password:
        payload["password"] = password
    return payload


async def save(principal: Any, engine: Any, name: Any, body: Mapping[str, Any]) -> Dict[str, Any]:
    """Create or replace the caller's connection; an omitted password is kept."""
    engine, name = _engine(engine), normalize_name(name)
    if not isinstance(body, Mapping):
        raise EngineError("body must be an object")
    payload = _payload(engine, body)
    if engine == "sqlite":
        _own_sqlite_folder(principal, Path(payload["path"]))
    existing = await find_own(principal, engine, name)
    if engine == "mysql":
        payload = merge_kept_secrets(engine, payload, existing.payload if existing else None)
        if not payload.get("password"):
            raise EngineError("password is required")
        if payload.get("vpn"):
            from hermes_cli import vpn

            try:
                await vpn.find_vpn(principal, payload["vpn"])
            except vpn.VpnNotFound:
                raise EngineError(f"no VPN named '{payload['vpn']}'") from None
    try:
        cred = await default_credential_store().put(
            principal, provider=engine, name=name, kind=engine, payload=payload,
            services=[engine], visibility=principal.private_visibility,
        )
    except CredentialError as exc:
        raise EngineError(str(exc).replace(str(payload.get("password") or "\0"), "***")) from exc
    from hermes_cli import data_engines

    await data_engines.remember_connection(principal)
    return view_of(cred)


async def delete(principal: Any, engine: Any, name: Any) -> bool:
    from hermes_cli import data_engines

    engine, name = _engine(engine), normalize_name(name)
    cred = await _own(principal, engine, name)
    await release_route(principal, cred)
    deleted = await default_credential_store().delete(principal, engine, name)
    if deleted:
        await data_engines.forget_connection(principal.user_id, engine, name)
    return bool(deleted)


async def run_test(principal: Any, engine: Any, name: Any) -> Dict[str, Any]:
    """Open the caller's connection and list its tables; ok + plain reason."""
    from hermes_cli import data_engines

    engine, name = _engine(engine), normalize_name(name)
    cred = await _own(principal, engine, name)
    result: Dict[str, Any] = {}
    try:
        if engine == "mysql":
            adapter: Any = data_engines.MysqlAdapter(
                cred.payload, ip=await route_for(principal, cred), label=name)
        else:
            adapter = data_engines.SqliteAdapter(cred.payload, label=name)
        tables = await adapter.list_tables()
        result.update(ok=True, tables=len(tables))
    except EngineError as exc:
        result.update(ok=False, error=str(exc))
    return {"connection": view_of(cred), "test": result}


async def list_mine(principal: Any) -> List[Dict[str, Any]]:
    return [view_of(e) for e in await own_entries(principal)]


# -- VPN ------------------------------------------------------------------------------


def _route_user(cred: Credential) -> str:
    digest = hashlib.sha256(f"{cred.owner_user_id}\0{cred.provider}\0{cred.name}".encode()).hexdigest()
    return f"{cred.provider}-{digest[:16]}"


async def route_for(principal: Any, cred: Credential, *, agent: bool = False) -> Optional[str]:
    """The VPN address to dial for a MySQL ``cred`` (None: dial ``host`` directly)."""
    vpn_name = cred.payload.get("vpn")
    if not vpn_name:
        return None
    from hermes_cli import vpn

    try:
        vpn_cred = await vpn.find_vpn(principal, vpn_name)
    except vpn.VpnNotFound:
        raise EngineError(f"the VPN '{vpn_name}' is not set up (Settings -> In&Out)") from None
    doc = await vpn.ensure_host_route(
        vpn_cred, _route_user(cred), str(cred.payload["host"]),
        int(cred.payload.get("port") or MYSQL_DEFAULT_PORT), agent=agent,
    )
    if not doc.get("routed") or not doc.get("ip"):
        raise EngineError(str(doc.get("error") or "the VPN route could not be set up"), 502)
    return str(doc["ip"])


async def release_route(principal: Any, cred: Credential) -> None:
    vpn_name = cred.payload.get("vpn")
    if not vpn_name:
        return
    from hermes_cli import vpn

    with contextlib.suppress(vpn.VpnError):
        vpn_cred = await vpn.find_vpn(principal, vpn_name)
        await vpn.release_host_route(vpn_cred, _route_user(cred))



