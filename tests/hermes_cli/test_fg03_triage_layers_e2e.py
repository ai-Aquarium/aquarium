"""FG-03 P3 E2E — layered triage skills per user-profile, over the real API.

Real profiles (``default``, ``cfo``, ``cmo``, plus ``hr`` that John is not in)
made by the profile API over a tmp hermes root and one throwaway Postgres, each
in its own derived schema with its own ``principals``. Requests go through the
real route table and ``require_profile_scope`` (``?profile=``); the only
stand-ins are the login gate's subject and the box-wide built-in skill folder
(a tmp copy, so the test never reads ``/opt/data``).
"""

from __future__ import annotations

import argparse
import asyncio
import json

import asyncpg
import pytest
import yaml

import hermes_cli.datastore as datastore
from hermes_cli import triage_skills
from hermes_cli.access import initialize_access
from hermes_cli.changes import initialize_changes
from hermes_cli.datastore import get_store, initialize_supabase_app
from hermes_cli.invitations import initialize_invitations
from tests.hermes_cli._pg_fixture import (  # noqa: F401 — pytest fixtures
    hermes_root,
    pg_config,
    postgres_dsn,
)

SUBJECT_HEADER = "X-Test-Subject"
KIND = "email"
KEY = "email-triage/classify-emails.md"
OTHER = "email-triage/escalation-rules.md"
BUILTIN = "# built-in classify\n"

#: (user_id, role) per profile. John and Mary: cfo + cmo; hr has Mary, not John.
ROSTERS: dict[str, list[tuple[str, str]]] = {
    "default": [("leo", "owner"), ("john", "member"), ("mary", "member")],
    "cfo": [("cfo_owner", "owner"), ("cfo_admin", "admin"), ("john", "member"), ("mary", "member")],
    "cmo": [("cmo_owner", "owner"), ("john", "member"), ("mary", "member")],
    "hr": [("hr_owner", "owner"), ("mary", "member")],
}


async def _reset(dsn: str) -> None:
    connection = await asyncpg.connect(dsn, ssl=False)
    try:
        for row in await connection.fetch(
            "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_%'"
        ):
            await connection.execute(f'DROP SCHEMA "{row["nspname"]}" CASCADE')
        await initialize_supabase_app(connection)
    finally:
        await connection.close()


async def _seed(home, dsn: str, roster) -> None:
    from hermes_cli.console_scope import _scoped_to

    with _scoped_to(home):
        datastore._verified_schemas.clear()
        connection = await get_store("supabase-app", "prod", config=pg_config(dsn)).connect()
        try:
            await initialize_access(connection)
            await initialize_invitations(connection)
            await initialize_changes(connection)
            for user_id, role in roster:
                await connection.execute(
                    "INSERT INTO principals (user_id, display, role, active) "
                    "VALUES ($1, $2, $3, true)",
                    user_id, user_id.title(), role,
                )
        finally:
            await connection.close()


@pytest.fixture
def box(postgres_dsn, hermes_root, monkeypatch, tmp_path):  # noqa: F811
    from hermes_cli import web_server
    from hermes_cli.profile_registry import get_profile_registry
    from hermes_cli.profiles import create_profile

    asyncio.run(_reset(postgres_dsn))
    (hermes_root / "config.yaml").write_text(yaml.safe_dump(pg_config(postgres_dsn)))
    for name in ROSTERS:
        if name != "default":
            create_profile(name, clone_from="default", clone_config=True, no_alias=True)
    homes = {e.name: e.hermes_home for e in get_profile_registry()}
    for name, roster in ROSTERS.items():
        asyncio.run(_seed(homes[name], postgres_dsn, roster))
    datastore._verified_schemas.clear()

    builtin = tmp_path / "box-skills" / "email-triage"
    builtin.mkdir(parents=True)
    (builtin / "classify-emails.md").write_text(BUILTIN)
    (builtin / "escalation-rules.md").write_text("# built-in escalation\n")
    config = {"triage": {"skills_dirs": [str(builtin)], "skills_subdirs": []}}
    monkeypatch.setattr(triage_skills, "kind_config", lambda kind: (tmp_path / "cfg.json", config))

    monkeypatch.setattr(
        web_server,
        "_comms_session_subject",
        lambda request: (request.headers.get(SUBJECT_HEADER) or "").strip(),
    )
    monkeypatch.setattr(web_server.app.state, "auth_required", False, raising=False)
    monkeypatch.setattr(web_server.app.state, "bound_host", None, raising=False)
    return {"homes": homes}


def _client(user_id: str):
    from starlette.testclient import TestClient

    from hermes_cli import web_server

    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    client.headers[SUBJECT_HEADER] = user_id
    return client


def _effective(client, profile: str, key: str = KEY) -> dict:
    r = client.get("/api/triage/layers/file", params={"kind": KIND, "key": key, "profile": profile})
    assert r.status_code == 200, r.text
    return r.json()


def _put(client, profile: str, layer: str, content: str, key: str = KEY):
    return client.put(
        f"/api/triage/layers/file?profile={profile}",
        json={"kind": KIND, "layer": layer, "key": key, "content": content},
    )


def test_layers_per_user_profile_over_the_api(box):
    john, mary, admin = _client("john"), _client("mary"), _client("cfo_admin")
    cfo, cmo = box["homes"]["cfo"], box["homes"]["cmo"]

    view = john.get("/api/triage/layers", params={"kind": KIND, "profile": "cfo"})
    assert view.status_code == 200, view.text
    body = view.json()
    assert body["profile"] == "cfo" and body["user_id"] == "john"
    assert body["can_edit_template"] is False
    files = {f["key"]: f for f in body["files"]}
    assert files[KEY]["layer"] == "builtin" and files[KEY]["disabled"] is False
    assert body["care"]["layer"] == "builtin" and body["care"]["content"].strip()

    # John edits his CFO email file: only John's CFO view changes.
    r = _put(john, "cfo", "user", "# john's CFO classify\n")
    assert r.status_code == 200, r.text
    assert (cfo / "users" / "john" / "triage-skills" / KIND / KEY).read_text() == "# john's CFO classify\n"
    assert _effective(john, "cfo")["content"] == "# john's CFO classify\n"
    assert _effective(john, "cfo")["layer"] == "user"
    assert _effective(mary, "cfo")["content"] == BUILTIN
    assert _effective(john, "cmo")["content"] == BUILTIN
    assert not (cmo / "users" / "john" / "triage-skills").exists()
    hist = john.get("/api/triage/layers/history",
                    params={"kind": KIND, "key": KEY, "layer": "user", "profile": "cfo"}).json()
    assert [v["action"] for v in hist["versions"]] == ["edit", "baseline"]
    assert hist["versions"][0]["author"] == "user:john"

    # Mary (member) can't change the CFO template; the CFO admin can.
    assert _put(mary, "cfo", "template", "# mary was here\n").status_code == 403
    r = mary.put("/api/triage/layers/care?profile=cfo",
                 json={"kind": KIND, "layer": "template", "content": "anything"})
    assert r.status_code == 403
    assert admin.get("/api/triage/layers", params={"kind": KIND, "profile": "cfo"}).json()[
        "can_edit_template"
    ] is True
    r = _put(admin, "cfo", "template", "# CFO template classify\n")
    assert r.status_code == 200, r.text
    # Shows for Mary; John keeps his override; CMO unaffected.
    assert _effective(mary, "cfo")["content"] == "# CFO template classify\n"
    assert _effective(mary, "cfo")["layer"] == "template"
    assert _effective(john, "cfo")["content"] == "# john's CFO classify\n"
    assert _effective(mary, "cmo")["content"] == BUILTIN
    layered = _client("john").get("/api/triage/layers/file", params={
        "kind": KIND, "key": KEY, "layer": "template", "profile": "cfo"}).json()
    assert layered["content"] == "# CFO template classify\n"
    assert layered["layers"] == {"builtin": "content", "template": "content", "user": "content"}

    d = john.get("/api/triage/layers/diff", params={"kind": KIND, "key": KEY, "profile": "cfo"}).json()
    assert d["changed"] is True
    assert "-# CFO template classify" in d["diff"] and "+# john's CFO classify" in d["diff"]

    # Reset restores the template for John.
    r = john.post("/api/triage/layers/reset?profile=cfo", json={"kind": KIND, "key": KEY})
    assert r.status_code == 200 and r.json()["reset"] == [KEY]
    assert _effective(john, "cfo")["content"] == "# CFO template classify\n"
    assert john.get("/api/triage/layers/diff",
                    params={"kind": KIND, "key": KEY, "profile": "cfo"}).json()["changed"] is False


def test_disable_enable_care_and_refusals(box):
    john, mary, admin = _client("john"), _client("mary"), _client("cfo_admin")

    def listed(client, profile="cfo"):
        body = client.get("/api/triage/layers", params={"kind": KIND, "profile": profile}).json()
        return {f["key"]: f for f in body["files"]}, body["care"]

    # Disable / enable in Mary's own layer.
    r = mary.post("/api/triage/layers/disable?profile=cfo",
                  json={"kind": KIND, "layer": "user", "key": OTHER, "disabled": True})
    assert r.status_code == 200, r.text
    files, _ = listed(mary)
    assert files[OTHER]["disabled"] is True and files[OTHER]["layers"]["user"] == "disabled"
    assert listed(john)[0][OTHER]["disabled"] is False
    assert "escalation-rules.md" not in triage_skills.compose_prompt(KIND, box["homes"]["cfo"], "mary")
    r = mary.post("/api/triage/layers/disable?profile=cfo",
                  json={"kind": KIND, "layer": "user", "key": OTHER, "disabled": False})
    assert r.status_code == 200
    assert listed(mary)[0][OTHER]["disabled"] is False

    # Off in the template: Mary can't just turn it on (409), only save her own.
    r = admin.post("/api/triage/layers/disable?profile=cfo",
                   json={"kind": KIND, "layer": "template", "key": OTHER, "disabled": True})
    assert r.status_code == 200, r.text
    assert listed(mary)[0][OTHER]["disabled"] is True
    r = mary.post("/api/triage/layers/disable?profile=cfo",
                  json={"kind": KIND, "layer": "user", "key": OTHER, "disabled": False})
    assert r.status_code == 409
    assert mary.post("/api/triage/layers/disable?profile=cfo",
                     json={"kind": KIND, "layer": "template", "key": OTHER, "disabled": False}
                     ).status_code == 403

    # "What I care about": empty refused, a real one wins for that person only.
    for blank in ("", "   \n"):
        r = mary.put("/api/triage/layers/care?profile=cfo",
                     json={"kind": KIND, "layer": "user", "content": blank})
        assert r.status_code == 422, r.text
    r = mary.put("/api/triage/layers/care?profile=cfo",
                 json={"kind": KIND, "layer": "user", "content": "Invoices over 10k."})
    assert r.status_code == 200 and r.json()["care"]["layer"] == "user"
    assert listed(mary)[1]["content"] == "Invoices over 10k."
    assert listed(john)[1]["layer"] == "builtin"
    assert listed(mary, "cmo")[1]["layer"] == "builtin"
    # The care file is not addressable as a plain skill file.
    assert _put(mary, "cfo", "user", "").status_code == 200  # an empty skill file is allowed
    assert _put(mary, "cfo", "user", "", key=triage_skills.CARE_KEY).status_code == 400

    # Key traversal is refused, for reads and writes.
    for bad in ("../../config.md", "email-triage/../../../x.md", "/etc/passwd.md", ".versions/x.md",
                "email-triage/x.txt"):
        assert _put(john, "cfo", "user", "x", key=bad).status_code == 400, bad
        r = john.get("/api/triage/layers/file", params={"kind": KIND, "key": bad, "profile": "cfo"})
        assert r.status_code == 400, bad
    assert not list(box["homes"]["cfo"].rglob("x.md"))
    assert _put(john, "cfo", "builtin", "x").status_code == 400
    assert john.get("/api/triage/layers", params={"kind": "sms", "profile": "cfo"}).status_code == 404

    # A non-member of a profile is refused by profile scope.
    assert john.get("/api/triage/layers", params={"kind": KIND, "profile": "hr"}).status_code == 403
    assert _put(john, "hr", "user", "x").status_code == 403
    assert not (box["homes"]["hr"] / "users" / "john").exists()
    assert mary.get("/api/triage/layers", params={"kind": KIND, "profile": "hr"}).status_code == 200

    # Reset all drops every override and the care section for Mary only.
    r = mary.post("/api/triage/layers/reset?profile=cfo", json={"kind": KIND})
    assert r.status_code == 200
    assert set(r.json()["reset"]) == {KEY, triage_skills.CARE_KEY}
    assert listed(mary)[1]["layer"] == "builtin"


# -- CLI ---------------------------------------------------------------------------


def _parser():
    from hermes_cli.triage_cli import register_triage_subparser

    parser = argparse.ArgumentParser()
    register_triage_subparser(parser.add_subparsers(dest="command"))
    return parser


def _cli(argv, capsys):
    args = _parser().parse_args(["triage", "skills", *argv])
    assert args.func(args) == 0
    return json.loads(capsys.readouterr().out)


def test_cli(box, capsys):
    base = ["--kind", KIND, "--profile", "cfo", "--json"]
    listed = _cli(["list", *base, "--user", "john"], capsys)
    assert {f["key"]: f["layer"] for f in listed["files"]}[KEY] == "builtin"

    _cli(["edit", KEY, *base, "--user", "john", "--text", "# john via cli\n"], capsys)
    _cli(["edit", KEY, *base, "--template", "--text", "# template via cli\n"], capsys)
    assert _cli(["show", KEY, *base, "--user", "john"], capsys)["content"] == "# john via cli\n"
    assert _cli(["show", KEY, *base, "--user", "mary"], capsys)["content"] == "# template via cli\n"
    shown = _cli(["show", KEY, "--kind", KIND, "--profile", "cmo", "--json", "--user", "john"], capsys)
    assert shown["content"] == BUILTIN
    assert _cli(["diff", KEY, *base, "--user", "john"], capsys)["changed"] is True
    versions = _cli(["history", KEY, *base, "--user", "john"], capsys)["versions"]
    assert versions[0]["author"] == "cli:operator"

    _cli(["disable", OTHER, *base, "--user", "mary"], capsys)
    assert {f["key"]: f for f in _cli(["list", *base, "--user", "mary"], capsys)["files"]}[OTHER]["disabled"]
    _cli(["enable", OTHER, *base, "--user", "mary"], capsys)

    assert _cli(["care", *base, "--user", "john", "--text", "Board packs."], capsys)["layer"] == "user"
    assert _cli(["reset", *base, "--user", "john"], capsys)["reset"] == [KEY, triage_skills.CARE_KEY]
    assert _cli(["show", KEY, *base, "--user", "john"], capsys)["content"] == "# template via cli\n"

    for argv in (
        ["care", *base, "--user", "john", "--text", "  "],
        ["edit", "../x.md", *base, "--user", "john", "--text", "x"],
        ["list", "--kind", KIND, "--profile", "nope"],
    ):
        args = _parser().parse_args(["triage", "skills", *argv])
        with pytest.raises(SystemExit):
            args.func(args)
    err = capsys.readouterr().err
    assert "(422)" in err and "(400)" in err and "(404)" in err
