"""HTTP surface for per-person MySQL and SQLite connections (data sources).

Like ``/api/mssql/connections``: every route acts on the signed-in caller's
OWN connections only, and passwords are write-only.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from hermes_cli import db_connections as dbc
from hermes_cli.data_engines import EngineError

router = APIRouter(prefix="/api/db/connections")


async def _caller(request: Request):
    from hermes_cli.credentials_api import _principal

    return await _principal(request, allow_as=False)


async def _run(coro):
    try:
        return await coro
    except EngineError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("")
async def list_connections(request: Request):
    principal = await _caller(request)
    return {
        "connections": await _run(dbc.list_mine(principal)),
        "drivers": {engine: dbc.driver_available(engine) for engine in dbc.ENGINES},
    }


@router.put("/{engine}/{name}")
async def put_connection(engine: str, name: str, request: Request):
    principal = await _caller(request)
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    return {"connection": await _run(dbc.save(principal, engine, name, body))}


@router.delete("/{engine}/{name}")
async def delete_connection(engine: str, name: str, request: Request):
    principal = await _caller(request)
    return {"deleted": await _run(dbc.delete(principal, engine, name))}


@router.post("/{engine}/{name}/test")
async def test_connection(engine: str, name: str, request: Request):
    principal = await _caller(request)
    return await _run(dbc.run_test(principal, engine, name))
