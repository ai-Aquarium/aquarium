"""FG-03 P3 → P4 E2E — the router's care sections, on real Postgres.

Real profiles over a tmp hermes root and the real box source registry (see
``test_source_registry_e2e``). John's mailbox routes to John@CFO and John@CMO;
each entry must carry that profile's / John's own "What I care about" text and
never Mary's, who uses CFO too.
"""

from __future__ import annotations

from pathlib import Path

from hermes_cli import source_registry as registry
from hermes_cli import triage_skills as tsk
from tests.hermes_cli._pg_fixture import hermes_root, postgres_dsn  # noqa: F401 — pytest fixtures
from tests.hermes_cli.test_source_registry_e2e import _box, box  # noqa: F401 — pytest fixture


def test_johns_mailbox_gives_one_care_section_per_routed_profile(box):  # noqa: F811
    homes = box["homes"]
    cfo, cmo, default = homes["cfo"], homes["cmo"], homes["default"]
    tsk.write_care("email", "John@CFO: invoices and payments", layer="user",
                   home=cfo, user_id="john", author="john")
    tsk.write_care("email", "Mary@CFO: board papers", layer="user",
                   home=cfo, user_id="mary", author="mary")
    tsk.write_care("email", "CMO template: campaigns and press", layer="template",
                   home=cmo, author="cmo_owner")
    tsk.write_care("email", "Mary's default-profile care", layer="user",
                   home=default, user_id="mary", author="mary")

    async def scenario(c):
        src = await registry.register_source(
            c, channel="email", address="john@example.com", owner_user_id="john")
        for profile in ("cfo", "cmo", "default"):
            await registry.set_route(c, source_id=src.source_id, profile_slug=profile,
                                     enabled=True, actor_user_id="john")
        # A turned-off route is never read.
        await registry.set_route(c, source_id=src.source_id, profile_slug="default",
                                 enabled=False, actor_user_id="john")
        john = await tsk.care_sections_for_source(c, src.source_id)
        same = await tsk.care_sections_for_source(c, src.source_id, "email")

        mary_src = await registry.register_source(
            c, channel="email", address="mary@example.com", owner_user_id="mary")
        await registry.set_route(c, source_id=mary_src.source_id, profile_slug="cfo",
                                 enabled=True, actor_user_id="mary")
        mary = await tsk.care_sections_for_source(c, mary_src.source_id)

        await registry.set_source_enabled(c, source_id=src.source_id, enabled=False,
                                          actor_user_id="john")
        disabled = await tsk.care_sections_for_source(c, src.source_id)

        bot = await registry.register_source(
            c, channel="telegram", address="12345", owner_user_id="john")
        await registry.set_route(c, source_id=bot.source_id, profile_slug="cfo",
                                 enabled=True, actor_user_id="john")
        telegram = await tsk.care_sections_for_source(c, bot.source_id)
        wrong_kind = None
        try:
            await tsk.care_sections_for_source(c, mary_src.source_id, "whatsapp")
        except tsk.SkillFileError as exc:
            wrong_kind = exc.status
        missing = await tsk.care_sections_for_source(c, "00000000-0000-0000-0000-000000000000")
        return john, same, mary, disabled, telegram, wrong_kind, missing

    john, same, mary, disabled, telegram, wrong_kind, missing = _box(box["dsn"], scenario)

    assert john == same
    assert [(e["profile"], e["user_id"], e["layer"], e["care"]) for e in john] == [
        ("cfo", "john", "user", "John@CFO: invoices and payments"),
        ("cmo", "john", "template", "CMO template: campaigns and press"),
    ]
    assert [Path(e["home"]) for e in john] == [cfo, cmo]
    assert not any("Mary" in e["care"] for e in john)
    assert [(e["profile"], e["user_id"], e["care"]) for e in mary] == [
        ("cfo", "mary", "Mary@CFO: board papers")]
    assert disabled == []
    assert telegram == []
    assert wrong_kind == 400
    assert missing == []


def test_a_routed_profile_without_care_text_gets_the_builtin(box):  # noqa: F811
    async def scenario(c):
        src = await registry.register_source(
            c, channel="whatsapp", address="+852 5555 0001", owner_user_id="john")
        await registry.set_route(c, source_id=src.source_id, profile_slug="cmo",
                                 enabled=True, actor_user_id="john")
        return await tsk.care_sections_for_source(c, src.source_id)

    [entry] = _box(box["dsn"], scenario)
    shipped = (Path(tsk.__file__).resolve().parent.parent
               / "custom/skills/triage-care/whatsapp.md").read_text()
    assert (entry["profile"], entry["layer"], entry["care"]) == ("cmo", "builtin", shipped)
