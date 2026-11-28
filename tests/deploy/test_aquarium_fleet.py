"""`aquarium fleet` — the root side of Settings → Fleet, against a fake box.

Reuses the fake server of test_aquarium_cli (fake root, fake systemctl/docker/cosign, a
local GitHub Releases API). The fleet inventory lives in
$AQUARIUM_TEST_PREFIX/etc/aquarium/fleet.json; remote boxes are a fake `ssh` on PATH
that answers canned output per remote command and records what it was asked, and a
fake `systemd-run` only logs its arguments.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

from test_aquarium_cli import (
    FAKE_LOGGER, FAKE_SYSTEMCTL, Box, Handler, aq, released_box, server,  # noqa: F401
)

pytestmark = pytest.mark.live_system_guard_bypass


# ssh here is a fake on PATH: logs the call, answers canned files under FAKE_SSH_DIR,
# saves a `cat` push to script.sh and a `systemd-run` to `ran`.
FAKE_SSH = r'''#!PY
import os, sys
d = os.environ["FAKE_SSH_DIR"]
with open(os.environ["FAKE_CALLS"], "a") as fh:
    fh.write("ssh " + " ".join(sys.argv[1:]) + "\n")
i = next(i for i, a in enumerate(sys.argv) if "@" in a)
remote = sys.argv[i + 1:]
fail = os.environ.get("FAKE_SSH_FAIL")
if fail:
    sys.stderr.write("ssh: connect to host failed: Connection timed out\n")
    sys.exit(int(fail))
if remote[0] == "cat":
    data = sys.stdin.buffer.read()
    with open(os.path.join(d, "script.sh"), "wb") as fh:
        fh.write(data)
elif remote[0] == "systemd-run":
    with open(os.path.join(d, "ran"), "w") as fh:
        fh.write(" ".join(remote))
elif remote[0] == "systemctl":
    path = os.path.join(d, "systemctl.out")
    if os.path.exists(path):
        sys.stdout.write(open(path).read())
elif remote[0] == "journalctl":
    path = os.path.join(d, "journal.out")
    if os.path.exists(path):
        sys.stdout.write(open(path).read())
else:
    # `aquarium <...> status` and friends: canned answer per last argument.
    path = os.path.join(d, remote[-1] + ".out")
    if os.path.exists(path):
        sys.stdout.write(open(path).read())
sys.exit(0)
'''

FAKE_JOURNALCTL = r'''#!PY
import os, sys
with open(os.environ["FAKE_CALLS"], "a") as fh:
    fh.write("journalctl " + " ".join(sys.argv[1:]) + "\n")
j = os.environ.get("FAKE_JOURNAL")
if j:
    sys.stdout.write(open(j).read())
sys.exit(0)
'''

# The stock fake handles is-active; add `show` (unit state from FAKE_SYSTEMCTL_SHOW).
FLEET_SYSTEMCTL = FAKE_SYSTEMCTL.replace(
    'if args[0] == "list-unit-files":',
    '''if args[0] == "show":
    show = os.environ.get("FAKE_SYSTEMCTL_SHOW")
    if show:
        print(open(show).read())
    sys.exit(0)
if args[0] == "list-unit-files":''',
    1,
)


@pytest.fixture
def box(tmp_path, monkeypatch, server):  # noqa: F811
    b = Box(tmp_path, monkeypatch, server)
    Handler.routes["/health"] = Handler.routes["/bridge/health"]
    b.ssh_dir = tmp_path / "ssh"
    b.ssh_dir.mkdir()
    for name, text in (("ssh", FAKE_SSH), ("systemd-run", FAKE_LOGGER),
                       ("journalctl", FAKE_JOURNALCTL), ("systemctl", FLEET_SYSTEMCTL)):
        f = b.bin / name
        f.write_text(text.replace("#!PY", "#!" + sys.executable))
        f.chmod(0o755)
    monkeypatch.setenv("FAKE_SSH_DIR", str(b.ssh_dir))
    monkeypatch.delenv("FAKE_SSH_FAIL", raising=False)
    return b


def fleet(b, *boxes):
    b.write("/etc/aquarium/fleet.json", json.dumps({
        "schema": 1,
        "ssh": {"user": "root", "identity": "/etc/aquarium/fleet_id_ed25519", "connect_timeout": 3},
        "boxes": list(boxes),
    }), mode=0o600)
    return b


LEO = {"name": "leo", "label": "Leo's box", "self": True, "branch": "develop"}
HSD = {"name": "hsd", "label": "HSD", "host": "10.0.0.7", "branch": "develop"}

REMOTE_RELEASE = json.dumps({
    "ok": True,
    "installed": {"layout": "release", "version": "v1.0.0", "label": "v1.0.0",
                  "commit": None, "channel": "stable", "installed_at": "2026-11-01T10:00:00Z"},
    "job": None,
}) + "\n"
REMOTE_GIT = json.dumps({
    "ok": True,
    "installed": {"layout": "git", "version": None, "label": "git-aa11bb2",
                  "commit": "aa11bb2", "channel": None, "installed_at": None},
    "job": None,
}) + "\n"


def ssh_answer(b, name, text):
    (b.ssh_dir / name).write_text(text)


def call(b, monkeypatch, capsys, verb, body=None) -> tuple[int, dict]:
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body) if body is not None else ""))
    code = b.run("fleet", verb)
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("{")]
    return code, (json.loads(lines[-1]) if lines else {})


def jobs_file(b) -> dict:
    path = b.p("/var/lib/aquarium/fleet-jobs.json")
    return json.loads(path.read_text()) if path.exists() else {}


def test_no_fleet_file_means_no_fleet(box, monkeypatch, capsys):
    for verb in ("status", "job", "probe"):
        code, answer = call(box, monkeypatch, capsys, verb)
        assert code == 0 and answer["ok"] and answer["available"] is False
    code, answer = call(box, monkeypatch, capsys, "switch", {"box": "hsd", "layout": "git", "by": "Leo"})
    assert code == 0 and answer["available"] is False


def test_probe_answers_yes_when_boxes_exist(box, monkeypatch, capsys):
    fleet(box, HSD)
    code, answer = call(box, monkeypatch, capsys, "probe")
    assert code == 0 and answer["available"] is True


def test_status_lists_self_and_remote(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, LEO, HSD)
    ssh_answer(box, "status.out", REMOTE_RELEASE)
    code, answer = call(box, monkeypatch, capsys, "status")
    assert code == 0 and answer["available"] is True
    leo, hsd = answer["boxes"]
    assert leo["self"] is True and leo["reachable"] is True
    assert leo["installed"]["layout"] == "release" and leo["installed"]["version"] == "v1.0.0"
    assert hsd["self"] is False and hsd["reachable"] is True
    assert hsd["installed"]["layout"] == "release"
    # the ssh call is batch-mode, key-forced, and carries no host names back
    ssh = [ln for ln in box.log().splitlines() if ln.startswith("ssh ")][0]
    assert "BatchMode=yes" in ssh and "-i /etc/aquarium/fleet_id_ed25519" in ssh
    assert "root@10.0.0.7" in ssh and "10.0.0.7" not in json.dumps(answer)


def test_status_marks_an_unreachable_box(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, LEO, HSD)
    monkeypatch.setenv("FAKE_SSH_FAIL", "255")
    code, answer = call(box, monkeypatch, capsys, "status")
    leo, hsd = answer["boxes"]
    assert leo["reachable"] is True
    assert hsd["reachable"] is False and hsd["installed"] is None and hsd["error"]


def test_switch_to_git_pushes_the_installer(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, LEO, HSD)
    ssh_answer(box, "status.out", REMOTE_RELEASE)
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "hsd", "layout": "git", "by": "Leo"})
    assert code == 0 and answer["ok"] and answer["started"] is True
    script = (box.ssh_dir / "script.sh").read_text()
    assert "--from-branch develop" in script and "install-aquarium.sh" in script
    assert 'rm "$APP"' in script
    assert "aquarium-fleet-switch" in (box.ssh_dir / "ran").read_text()
    rec = jobs_file(box)["hsd"]
    assert rec["state"] == "running" and rec["to"] == "git" and rec["by"] == "Leo"


def test_switch_to_release_pushes_migrate_layout(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, HSD)
    ssh_answer(box, "status.out", REMOTE_GIT)
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "hsd", "layout": "release", "by": "Leo"})
    assert code == 0 and answer["ok"]
    script = (box.ssh_dir / "script.sh").read_text()
    assert "migrate-layout --yes" in script and "INSTALL_SOURCE=release" in script


def test_switch_refuses_the_layout_the_box_already_has(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, HSD)
    ssh_answer(box, "status.out", REMOTE_RELEASE)
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "hsd", "layout": "release", "by": "Leo"})
    assert code == 1 and answer["ok"] is False and "already" in answer["error"]
    assert not (box.ssh_dir / "ran").exists()


def test_switch_refuses_an_unknown_box_and_a_bad_layout(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, HSD)
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "nope", "layout": "git", "by": "Leo"})
    assert code == 1 and answer["ok"] is False
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "hsd", "layout": "sideways", "by": "Leo"})
    assert code == 1 and "layout" in answer["error"]


def test_switch_refuses_an_unreachable_box(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, HSD)
    monkeypatch.setenv("FAKE_SSH_FAIL", "255")
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "hsd", "layout": "git", "by": "Leo"})
    assert code == 1 and "not reachable" in answer["error"]


def test_switch_refuses_while_a_switch_is_running(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, HSD)
    ssh_answer(box, "status.out", REMOTE_RELEASE)
    ssh_answer(box, "systemctl.out", "ActiveState=active\nExecMainStatus=0\nResult=\n")
    b = box
    b.write("/var/lib/aquarium/fleet-jobs.json", json.dumps({
        "hsd": {"id": "old", "unit": "aquarium-fleet-switch", "to": "git", "by": "Leo",
                "started": "2026-11-27T10:00:00Z", "state": "running"}}), mode=0o600)
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "hsd", "layout": "git", "by": "Leo"})
    assert code == 1 and "already running" in answer["error"]


def test_job_reports_the_unit_state(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, HSD)
    box.write("/var/lib/aquarium/fleet-jobs.json", json.dumps({
        "hsd": {"id": "s1", "unit": "aquarium-fleet-switch", "to": "git", "by": "Leo",
                "started": "2026-11-27T10:00:00Z", "state": "running"}}), mode=0o600)
    ssh_answer(box, "systemctl.out", "ActiveState=inactive\nExecMainStatus=0\nResult=success\n")
    ssh_answer(box, "journal.out", "deploy OK (aa11bb2)\n")
    code, answer = call(box, monkeypatch, capsys, "job")
    job = answer["jobs"]["hsd"]
    assert job["state"] == "ok" and job["finished"]
    assert jobs_file(box)["hsd"]["state"] == "ok"


def test_switch_on_self_runs_a_local_unit(box, monkeypatch, capsys):
    released_box(box)
    fleet(box, LEO)
    code, answer = call(box, monkeypatch, capsys, "switch",
                        {"box": "leo", "layout": "git", "by": "Leo"})
    assert code == 0 and answer["ok"]
    assert "systemd-run --unit aquarium-fleet-switch" in box.log()
    script = box.p("/var/lib/aquarium/aquarium-fleet-switch.sh").read_text()
    assert "--from-branch develop" in script
    assert "ssh " not in box.log()
