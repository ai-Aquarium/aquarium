"""The ledger sweep: what it reports, how it dedupes, and that a clock runs it."""
from __future__ import annotations

import re
from pathlib import Path

from app_mcp import sweep as sw
from app_mcp.ledger import CoverageLedger, load

REPO = Path(__file__).resolve().parents[2]


def _ledger(tmp_path: Path, snapshots: list[tuple[str, list[dict]]]) -> Path:
    path = tmp_path / "app-mcp" / "coverage-ledger.jsonl"
    ledger = CoverageLedger(path)
    for page, elements in snapshots:
        ledger.observe(page, elements)
    return path


def test_reports_unhinted_controls_per_page_and_skips_hinted_ones(tmp_path):
    path = _ledger(tmp_path, [
        ("/", [{"role": "button", "name": "Snooze", "hint": "Hides it"},
               {"role": "button", "name": "Archive"}]),
        ("/todos/42", [{"role": "link", "name": "Back"}]),
    ])
    report = sw.sweep(load(path).values())
    assert report.unhinted == {"/": [("button", "Archive")], "/todos/[id]": [("link", "Back")]}
    assert report.gap_count == 2


def test_a_control_hinted_since_its_last_gap_is_no_longer_reported(tmp_path):
    path = _ledger(tmp_path, [
        ("/", [{"role": "button", "name": "Archive"}]),
        ("/", [{"role": "button", "name": "Archive", "hint": "Archives it"}]),
    ])
    assert sw.sweep(load(path).values()).gap_count == 0


def test_pages_without_a_guide_are_reported(tmp_path):
    path = _ledger(tmp_path, [
        ("/", [{"role": "button", "name": "Go", "hint": "x"}]),
        ("/no-such-page", [{"role": "button", "name": "Go", "hint": "x"}]),
    ])
    report = sw.sweep(load(path).values())
    assert report.unguided == ["/no-such-page"]
    title, lines = sw.render(report)
    assert "1 page(s) without a guide" in title
    assert any(line.startswith("/no-such-page: no page guide") for line in lines)


def test_dedupe_key_is_stable_for_the_same_gaps_and_changes_with_them(tmp_path):
    rows = [{"page": "/", "role": "button", "name": "A", "hinted": False},
            {"page": "/", "role": "button", "name": "B", "hinted": False}]
    same = sw.sweep(reversed(rows)).dedupe_key
    assert sw.sweep(rows).dedupe_key == same
    assert same.startswith(sw.DEDUPE_PREFIX)
    assert sw.sweep(rows[:1]).dedupe_key != same


def test_card_body_is_capped():
    rows = [{"page": "/", "role": "button", "name": f"B{i:03}", "hinted": False} for i in range(100)]
    title, lines = sw.render(sw.sweep(rows))
    assert title.startswith("app-mcp: 100 control(s) without a hint")
    assert len(lines) == sw.MAX_LINES + 1
    assert lines[sw.MAX_LINES - 1].startswith("…and 61 more")


def test_dry_run_prints_without_delivering(tmp_path, capsys, monkeypatch):
    path = _ledger(tmp_path, [("/", [{"role": "button", "name": "Archive"}])])
    called = []
    monkeypatch.setattr(sw, "deliver", lambda *a, **k: called.append(a))
    assert sw.main(["--ledger", str(path)]) == 0
    out = capsys.readouterr().out
    assert '/: button "Archive"' in out
    assert not called


def test_deliver_raises_one_deduped_owner_ask(tmp_path, monkeypatch):
    import asyncio
    import sys
    import types

    created: list[dict] = []

    class _Owner:
        user_id = "owner-1"

    class _Principals:
        def __init__(self, _store):
            pass

        async def get_owner(self):
            return _Owner()

    class _Notifications:
        def __init__(self, _store, config=None):
            pass

        async def initialize(self):
            return None

        async def create(self, **kwargs):
            created.append(kwargs)
            return types.SimpleNamespace(created=True)

    fakes = {
        "hermes_cli": types.ModuleType("hermes_cli"),
        "hermes_cli.access": types.SimpleNamespace(PrincipalStore=_Principals),
        "hermes_cli.datastore": types.SimpleNamespace(get_store=lambda *a, **k: object()),
        "hermes_cli.human_comms": types.SimpleNamespace(NotificationStore=_Notifications),
    }
    for name, module in fakes.items():
        monkeypatch.setitem(sys.modules, name, module)
    report = sw.sweep([{"page": "/", "role": "button", "name": "Archive", "hinted": False}])
    asyncio.run(sw.deliver(report))
    assert len(created) == 1
    ask = created[0]
    assert ask["kind"] == "proactive_ask"
    assert ask["target_user_id"] == "owner-1"
    assert ask["dedupe_key"] == report.dedupe_key
    assert '/: button "Archive"' in ask["body"]


def test_a_timer_runs_the_sweep_with_delivery():
    service = (REPO / "deploy" / "hermes-appmcp-hint-sweep.service").read_text()
    timer = (REPO / "deploy" / "hermes-appmcp-hint-sweep.timer").read_text()
    exec_start = re.search(r"^ExecStart=(.+)$", service, re.M)
    assert exec_start and exec_start.group(1).strip().endswith("-m app_mcp.sweep --deliver")
    assert "User=hermes" in service
    assert "Unit=hermes-appmcp-hint-sweep.service" in timer
    assert "Persistent=true" in timer


def test_app_mcp_and_the_sweep_share_a_ledger_folder_every_box_has():
    """``ProtectSystem=strict`` makes everything read-only unless granted; the grant is
    ``StateDirectory=``, the same path on every box, so the units copy over as they are."""
    unit = (REPO / "app-mcp" / "deploy" / "app-mcp.service").read_text()
    drop_in = (REPO / "deploy" / "app-mcp-ledger.conf").read_text()
    sweep_unit = (REPO / "deploy" / "hermes-appmcp-hint-sweep.service").read_text()
    assert "ProtectSystem=strict" in unit
    state = re.findall(r"^StateDirectory=(\S+)$", drop_in, re.M)
    assert state and state == re.findall(r"^StateDirectory=(\S+)$", sweep_unit, re.M)
    # Same mode in both, or each start would chmod the folder the other way.
    mode = re.compile(r"^StateDirectoryMode=(\S+)$", re.M)
    assert mode.findall(drop_in) == mode.findall(sweep_unit) == ["0700"]
    # The sweep reads app-mcp's own env files, so it finds the same HERMES_HOME.
    env = re.compile(r"^EnvironmentFile=(\S+)$", re.M)
    assert env.findall(unit) == env.findall(sweep_unit)
    for text in (drop_in, sweep_unit):
        assert "hermes-home" not in text and "ReadWritePaths" not in text
