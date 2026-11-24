"""The background base backup next to foreground commands, upgrades and rollbacks."""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
import time

import pytest
from test_aquarium_base_backup import (  # noqa: F401
    BACKUPS,
    HOME,
    Handler,
    aq,
    archive_members,
    box,
    change_box,
    key,
    make_base,
    server,
    touch,
)

pytestmark = pytest.mark.live_system_guard_bypass


def _fake_base_job(box):
    """A running base backup as the status file describes it: a live process and partial files."""
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)", "aquarium-base-backup"])
    folder = box.p(BACKUPS)
    folder.mkdir(parents=True, exist_ok=True)
    part = folder / "aquarium-backup-20990101T000000Z+base.tar.gz.gpg.part"
    part.write_bytes(b"half")
    (folder / ".staging-base-x").mkdir()
    aq.save_base_status({"state": "running", "pid": proc.pid, "started": aq.now_iso()})
    return proc, part


def test_update_stops_the_background_job_then_queues_the_next(box, capsys):
    proc, part = _fake_base_job(box)
    try:
        assert box.run("update") == 0, capsys.readouterr().out
        assert proc.wait(timeout=10) is not None
    finally:
        proc.kill()
    assert not part.exists() and not box.p(f"{BACKUPS}/.staging-base-x").exists()
    log = box.log()
    assert "systemctl stop aquarium-base-backup.service" in log
    assert log.index("systemctl stop aquarium-base-backup.service") < log.index("systemctl restart")
    assert "systemctl start --no-block aquarium-base-backup.service" in log
    for name, text in aq.base_backup_units().items():
        assert box.p(f"/etc/systemd/system/{name}").read_text() == text
    assert json.loads(box.p(aq.BASE_STATUS).read_text())["state"] == "queued"


@pytest.mark.parametrize("argv", [("backup",), ("restore", "{backup}", "--test")])
def test_foreground_commands_stop_the_background_job(box, capsys, argv):
    first = None
    if "{backup}" in argv:
        assert box.run("backup") == 0
        first = str(sorted(box.p(BACKUPS).glob("*-manual.tar.gz.gpg"))[-1])
    proc, part = _fake_base_job(box)
    try:
        assert box.run(*[a.replace("{backup}", first or "") for a in argv]) == 0, capsys.readouterr().out
        assert proc.wait(timeout=10) is not None
    finally:
        proc.kill()
    st = json.loads(box.p(aq.BASE_STATUS).read_text())
    assert st["state"] == "stopped" and not part.exists()


def test_base_job_waits_for_a_running_command_without_blocking_it(box):
    done = {}
    with aq.admin_lock():
        t = threading.Thread(target=lambda: done.setdefault("rc", aq.main(["backup", "--base"])))
        t.start()
        time.sleep(1)
        assert json.loads(box.p(aq.BASE_STATUS).read_text())["state"] == "queued"
        assert not list(box.p(BACKUPS).glob("*+base.tar.gz.gpg*"))
    t.join(timeout=60)
    assert done.get("rc") == 0
    st = json.loads(box.p(aq.BASE_STATUS).read_text())
    assert st["state"] == "done" and st["last"]["name"] == st["name"]


def _start_upgrade(box, monkeypatch, capsys, body):
    Handler.routes["/api/releases?per_page=50"] = (200, box.releases)
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body)))
    assert box.run("upgrade", "start") == 0
    capsys.readouterr()


def _status(box, monkeypatch, capsys) -> dict:
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    capsys.readouterr()
    box.run("upgrade", "status")
    return json.loads([ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("{")][-1])


def test_upgrade_job_backs_up_changes_and_reports_the_background_backup(box, monkeypatch, capsys):
    make_base(box)
    _start_upgrade(box, monkeypatch, capsys, {"version": "v1.1.0", "by": "Leo"})
    assert box.run("upgrade", "run") == 0
    st = _status(box, monkeypatch, capsys)
    assert st["job"]["result"] == "ok" and st["job"]["backup_since"]
    assert st["job"]["base_backup"] is True
    assert st["base_backup"]["state"] == "queued" and st["base_backup"]["after_job"] == st["job"]["id"]
    assert list(box.p(BACKUPS).glob("*-pre-update-v1.1.0+base-*.tar.gz.gpg"))
    # the queued unit runs; the page then reports it finished
    assert box.run("backup", "--base") == 0
    st = _status(box, monkeypatch, capsys)
    assert st["base_backup"]["state"] == "done" and st["base_backup"]["after_job"] == st["job"]["id"]
    assert "/var/backups" not in json.dumps(st["base_backup"])


def test_rollback_restores_from_a_delta(box, monkeypatch, capsys):
    make_base(box)
    _start_upgrade(box, monkeypatch, capsys, {"version": "v1.1.0"})
    assert box.run("upgrade", "run") == 0
    touch(box, f"{HOME}/config.yaml", "written on the new version\n")
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    assert box.run("upgrade", "rollback") == 0, capsys.readouterr().out
    assert box.run("upgrade", "run") == 0, capsys.readouterr().out
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.0.0"
    assert "migrated: true" not in box.p(f"{HOME}/config.yaml").read_text()


def test_rollback_without_the_base_changes_nothing(box, monkeypatch, capsys):
    base = make_base(box)
    _start_upgrade(box, monkeypatch, capsys, {"version": "v1.1.0"})
    assert box.run("upgrade", "run") == 0
    base.unlink()
    st = _status(box, monkeypatch, capsys)
    assert st["rollback"] is None
    base.write_bytes(b"replaced")
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO("{}"))
    box.run("upgrade", "rollback")
    box.run("upgrade", "run")
    assert os.readlink(box.p("/opt/aquarium/current")) == "releases/v1.1.0"
