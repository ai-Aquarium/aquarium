"""deploy/hermes-telegram-triage.service runs custom/telegram/triage_agent.py
the way hermes-calendar-triage runs its agent (FG-03 P6). The script is run
for real as the unit runs it, with a temp HERMES_HOME."""

from __future__ import annotations

import configparser
import fnmatch
import importlib.util
import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
UNIT = REPO / "deploy" / "hermes-telegram-triage.service"
CHECKOUT = "/opt/data/hermes-agent"


def _unit(path: Path) -> configparser.ConfigParser:
    parser = configparser.ConfigParser(interpolation=None, strict=False)
    parser.optionxform = str
    parser.read_string(path.read_text())
    return parser


def _in_repo(box_path: str) -> Path:
    assert box_path.startswith(CHECKOUT + "/"), box_path
    return REPO / box_path[len(CHECKOUT) + 1:]


def _home(tmp_path: Path, mode: str) -> Path:
    home = tmp_path / "hermes-home"
    home.mkdir()
    (home / "config.yaml").write_text(f"triage:\n  agent:\n    telegram: '{mode}'\n")
    return home


def test_unit_runs_the_script_unprivileged_like_the_calendar_triage_unit():
    unit = _unit(UNIT)["Service"]
    calendar = _unit(REPO / "deploy" / "hermes-calendar-triage.service")["Service"]
    assert (unit["User"], unit["Group"]) == ("hermes", "hermes")
    for key in ("EnvironmentFile", "Type", "Restart", "RestartSec"):
        assert unit[key] == calendar[key], key
    python, script = unit["ExecStart"].split()
    assert python == f"{CHECKOUT}/.venv/bin/python"
    assert _in_repo(script) == REPO / "custom" / "telegram" / "triage_agent.py"
    assert _in_repo(unit["WorkingDirectory"]) == _in_repo(script).parent
    assert _unit(UNIT)["Install"]["WantedBy"] == "multi-user.target"


def test_deploy_restarts_it_and_deploy_state_captures_it():
    deploy = (REPO / "deploy" / "hermes-deploy.sh").read_text()
    assert "list-unit-files 'hermes-*.service' --state=enabled" in deploy
    assert fnmatch.fnmatch(UNIT.name, "hermes-*.service")
    spec = importlib.util.spec_from_file_location("_deploy_state", REPO / "scripts" / "deploy_state.py")
    deploy_state = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(deploy_state)
    assert any(fnmatch.fnmatch(UNIT.name, g) for g in deploy_state.DEFAULT_UNIT_GLOBS)


def test_execstart_starts_and_keeps_running(tmp_path: Path):
    unit = _unit(UNIT)["Service"]
    script = _in_repo(unit["ExecStart"].split()[1])
    env = {**os.environ, "HERMES_HOME": str(_home(tmp_path, "off")), "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(
        [sys.executable, str(script)], cwd=_in_repo(unit["WorkingDirectory"]), env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(4)
        assert proc.poll() is None, proc.stdout.read()
    finally:
        proc.terminate()
        out, _ = proc.communicate(timeout=10)
    assert "[telegram-triage] Starting Telegram triage agent" in out
    assert "Traceback" not in out and "Pass failed" not in out


@pytest.mark.parametrize("mode", ["off", "bogus"])
def test_running_service_leaves_batches_untouched_unless_agent(tmp_path: Path, mode: str):
    """The real main loop over a temp batch dir: a no-op unless agent."""
    base = tmp_path / "telegram-messages"
    batches = base / "batches"
    batches.mkdir(parents=True)
    batch = batches / "tg_1_2_3.json"
    batch.write_text(json.dumps({"batch_id": "tg_1_2_3", "account_id": "tgbot:1", "messages": []}))
    before = (batch.read_bytes(), batch.stat().st_mtime_ns)
    runner = textwrap.dedent(f"""
        import runpy, sys
        from pathlib import Path
        from hermes_cli import telegram_triage as tt
        tt.BASE_DIR = Path({str(base)!r})
        tt.BATCH_DIR = tt.BASE_DIR / "batches"
        tt.PROCESSED_DIR = tt.BASE_DIR / "processed"
        sys.argv = [{str(REPO / "custom/telegram/triage_agent.py")!r}]
        runpy.run_path(sys.argv[0], run_name="__main__")
    """)
    env = {**os.environ, "HERMES_HOME": str(_home(tmp_path, mode)), "PYTHONUNBUFFERED": "1"}
    proc = subprocess.Popen(
        [sys.executable, "-c", runner], cwd=REPO / "custom" / "telegram", env=env,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        time.sleep(7)  # two passes at POLL_SECONDS
        assert proc.poll() is None, proc.stdout.read()
    finally:
        proc.terminate()
        out, _ = proc.communicate(timeout=10)
    assert f"watching {batches}" in out
    assert "Processing batch" not in out and "Traceback" not in out
    assert (batch.read_bytes(), batch.stat().st_mtime_ns) == before
    assert not (base / "processed").exists()
