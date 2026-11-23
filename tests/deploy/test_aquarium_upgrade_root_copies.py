"""The upgrade job keeps the box's root-owned copies (helpers, sudoers rules, the admin
command) in step with the signed release, saves the old ones and puts them back on rollback.

Runs the real `aquarium update` / `upgrade run` code against the fake box of
test_aquarium_cli: fake root, fake systemctl/cosign/visudo/sudo, a local Releases API.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys

import pytest

from test_aquarium_cli import FAKE_LOGGER, REPO, Handler, aq, released_box, server  # noqa: F401
from test_aquarium_upgrade import box, call, git_box, releases  # noqa: F401

pytestmark = pytest.mark.live_system_guard_bypass

NEW = {
    "deploy/hermes-tools-cli": "#!/usr/bin/python3\n# allowlist v1.1.0\nALLOW = {\"projects\": {}}\n",
    "deploy/hermes-tools-shim": "#!/bin/bash\n# shim v1.1.0\n",
    "deploy/hermes-tools-exec": "#!/bin/bash\n# exec v1.1.0\n",
    "deploy/sudoers.d/hermes-tools": "hermes ALL=(hermes-tools) NOPASSWD:SETENV: /usr/local/sbin/hermes-tools-exec\n",
    "deploy/sudoers.d/aquarium-upgrade": "hermes ALL=(root) NOPASSWD: /usr/local/sbin/aquarium upgrade status\n",
    "deploy/sudoers.d/hermes-backup": "# backup rule v1.1.0\n",
}
OLD = {
    "/usr/local/sbin/hermes-tools-cli": ("# allowlist v1.0.0\n", 0o755),
    "/usr/local/lib/hermes-tools/bin/hermes": ("# shim v1.0.0\n", 0o755),
    "/etc/sudoers.d/hermes-tools": ("# rule v1.0.0\n", 0o440),
    "/etc/sudoers.d/aquarium-upgrade": ("# upgrade rule v1.0.0\n", 0o440),
}


def fakes(b, *names):
    for name in names:
        f = b.bin / name
        f.write_text(FAKE_LOGGER.replace("#!PY", "#!" + sys.executable))
        f.chmod(0o755)


@pytest.fixture
def rbox(box, monkeypatch):  # noqa: F811
    """A v1.0.0 release box with the hermes-tools trio installed; v1.1.0 ships new copies."""
    box.install_release("v1.0.0")
    box.make_release("v1.0.0")
    box.make_release("v1.1.0", extra=NEW)
    releases(box)
    fakes(box, "visudo", "sudo")
    for path, (text, mode) in OLD.items():
        box.write(path, text, mode=mode)
    return box


def upgrade(b, monkeypatch, capsys, version="v1.1.0"):
    code, answer = call(b, monkeypatch, capsys, "start", {"version": version, "by": "Leo"})
    assert code == 0, answer
    code = b.run("upgrade", "run")
    return code, aq.load_upgrade_status()


def test_upgrade_installs_the_installed_root_copies_from_the_release(rbox, monkeypatch, capsys):
    code, job = upgrade(rbox, monkeypatch, capsys)
    assert code == 0 and job["result"] == "ok", job
    for path, src in (("/usr/local/sbin/hermes-tools-cli", "deploy/hermes-tools-cli"),
                      ("/usr/local/lib/hermes-tools/bin/hermes", "deploy/hermes-tools-shim"),
                      ("/etc/sudoers.d/hermes-tools", "deploy/sudoers.d/hermes-tools"),
                      ("/etc/sudoers.d/aquarium-upgrade", "deploy/sudoers.d/aquarium-upgrade")):
        f = rbox.p(path)
        assert f.read_text() == NEW[src], path
        assert f.stat().st_mode & 0o777 == (0o440 if "sudoers" in path else 0o755), path
    # the admin command refreshed itself as one of them
    assert rbox.p("/usr/local/sbin/aquarium").read_text() == "# new aquarium\n"
    # files this box never had stay absent (no feature is turned on)
    for absent in ("/usr/local/sbin/hermes-tools-exec", "/etc/sudoers.d/hermes-backup"):
        assert not rbox.p(absent).exists(), absent
    # each sudoers rule was checked by visudo before it was swapped in
    checks = [ln for ln in rbox.log().splitlines() if ln.startswith("visudo -cf")]
    assert len(checks) == 2 and all(".aquarium-new" in ln for ln in checks)
    assert not list(rbox.p("/etc/sudoers.d").glob(".*aquarium-new"))
    # the old copies sit in the upgrade's backup, owner and mode recorded
    rec = aq.load_state()["upgrades"][-1]
    manifest = json.loads((aq.Path(rec["root_copies"]) / "manifest.json").read_text())
    assert {e["path"] for e in manifest} == set(OLD) | {"/usr/local/sbin/aquarium"}
    assert oct(os.stat(rec["root_copies"]).st_mode & 0o777) == "0o700"
    _, st = call(rbox, monkeypatch, capsys, "status")
    assert "root_copies" not in json.dumps(st) and "root-copies" not in json.dumps(st)


def test_a_sudoers_rule_visudo_refuses_replaces_nothing(rbox, monkeypatch, capsys):
    monkeypatch.setenv("FAKE_VISUDO_EXIT", "1")
    code, job = upgrade(rbox, monkeypatch, capsys)
    assert code == 1 and job["result"] == "rolled back"
    assert "visudo" in job["error"]
    assert os.readlink(rbox.p("/opt/aquarium/current")) == "releases/v1.0.0"
    for path, (text, _mode) in OLD.items():
        assert rbox.p(path).read_text() == text, path
    assert not list(rbox.p("/etc/sudoers.d").glob(".*aquarium-new"))


def test_restricted_terminal_failure_rolls_back_and_says_why(rbox, monkeypatch, capsys):
    rbox.write("/opt/data/hermes-home/config.yaml", "model: x\nterminal:\n  backend: local\n  run_as: hermes-tools\n")
    monkeypatch.setenv("FAKE_SUDO_EXIT", "1")
    code, job = upgrade(rbox, monkeypatch, capsys)
    assert code == 1 and job["result"] == "rolled back", job
    assert "agent's terminal (hermes-tools) cannot run `hermes memory status --help`" in job["error"]
    assert "sudo -n -u hermes-tools /usr/local/sbin/hermes-tools-exec bash -c hermes memory status --help" in rbox.log()
    assert os.readlink(rbox.p("/opt/aquarium/current")) == "releases/v1.0.0"
    for path, (text, mode) in OLD.items():  # the old copies are back, same mode
        assert rbox.p(path).read_text() == text and rbox.p(path).stat().st_mode & 0o777 == mode, path
    assert rbox.p("/usr/local/sbin/aquarium").read_text() == "# old aquarium\n"


def test_restricted_terminal_probe_passes(rbox, monkeypatch, capsys):
    rbox.write("/opt/data/hermes-home/profiles/sales/config.yaml", "terminal:\n  run_as: 'hermes-tools'  # FG-38\n")
    code, job = upgrade(rbox, monkeypatch, capsys)
    assert code == 0 and job["result"] == "ok", job
    assert "hermes-tools-exec bash -c hermes memory status --help" in rbox.log()


def test_rollback_puts_the_saved_copies_back(rbox, monkeypatch, capsys):
    code, _ = upgrade(rbox, monkeypatch, capsys)
    assert code == 0
    monkeypatch.setattr(aq, "_restore_backup", lambda cfg, path: None)
    code, answer = call(rbox, monkeypatch, capsys, "rollback", {"by": "Leo"})
    assert code == 0, answer
    assert rbox.run("upgrade", "run") == 0, aq.load_upgrade_status()
    assert os.readlink(rbox.p("/opt/aquarium/current")) == "releases/v1.0.0"
    for path, (text, mode) in OLD.items():
        assert rbox.p(path).read_text() == text and rbox.p(path).stat().st_mode & 0o777 == mode, path


def test_root_copies_come_from_the_tarball_not_the_release_tree(rbox, monkeypatch, capsys):
    real_build = aq.build_release

    def tampering_build(cfg, rel):  # the service user owns the tree while it builds
        real_build(cfg, rel)
        (rel / "deploy/sudoers.d").mkdir(parents=True, exist_ok=True)
        (rel / "deploy/sudoers.d/hermes-tools").write_text("hermes ALL=(ALL) NOPASSWD: ALL\n")

    monkeypatch.setattr(aq, "build_release", tampering_build)
    code, job = upgrade(rbox, monkeypatch, capsys)
    assert code == 0, job
    assert rbox.p("/etc/sudoers.d/hermes-tools").read_text() == NEW["deploy/sudoers.d/hermes-tools"]


def test_git_upgrade_installs_root_copies_from_the_signed_package(box, monkeypatch, capsys):  # noqa: F811
    git_box(box, monkeypatch)
    box.releases.clear()
    box.make_release("v1.0.0")
    box.make_release("v1.1.0", extra=NEW)
    releases(box)
    fakes(box, "visudo", "sudo")
    for path, (text, mode) in OLD.items():
        box.write(path, text, mode=mode)
    box.write("/usr/local/sbin/aquarium", "# old aquarium\n", mode=0o755)
    code, job = upgrade(box, monkeypatch, capsys)
    assert code == 0 and job["result"] == "ok", job
    assert box.p("/etc/sudoers.d/hermes-tools").read_text() == NEW["deploy/sudoers.d/hermes-tools"]
    assert box.p("/usr/local/sbin/hermes-tools-cli").read_text() == NEW["deploy/hermes-tools-cli"]
    assert "cosign verify-blob" in box.log()
    assert not list(box.p("/var/lib/aquarium/upgrade-downloads").glob("*/*.tar.gz"))


def test_failed_git_upgrade_puts_the_root_copies_back(box, monkeypatch, capsys):  # noqa: F811
    git_box(box, monkeypatch)
    box.releases.clear()
    box.make_release("v1.0.0")
    box.make_release("v1.1.0", extra=NEW)
    releases(box)
    fakes(box, "visudo", "sudo")
    for path, (text, mode) in OLD.items():
        box.write(path, text, mode=mode)
    box.set_systemd(down=[])
    monkeypatch.setattr(aq, "wait_healthy", lambda cfg, units: [])
    monkeypatch.setattr(aq, "terminal_probe", lambda cfg, src: ["the agent's terminal is broken"])
    code, job = upgrade(box, monkeypatch, capsys)
    assert code == 1 and job["result"] == "rolled back"
    for path, (text, _mode) in OLD.items():
        assert box.p(path).read_text() == text, path


# --------------------------------------------------------------------------- finish (first upgrade by an older job)


@pytest.fixture
def left_behind(box, monkeypatch):  # noqa: F811
    """What an older job's `aquarium update` leaves: v1.1.0 runs, its new admin command is
    in place (refresh_self), but the other root copies are still v1.0.0's."""
    box.make_release("v1.0.0")
    box.make_release("v1.1.0", extra=NEW)
    releases(box)
    box.install_release("v1.1.0")
    rel = box.p("/opt/aquarium/releases/v1.1.0")
    for name, text in NEW.items():
        (rel / name).parent.mkdir(parents=True, exist_ok=True)
        (rel / name).write_text(text)
    (rel / "deploy/aquarium.py").write_text("# new aquarium\n")
    box.write("/usr/local/sbin/aquarium", "# new aquarium\n", mode=0o755)
    fakes(box, "visudo", "sudo")
    for path, (text, mode) in OLD.items():
        box.write(path, text, mode=mode)
    return box


def launches(b):
    return [ln for ln in b.log().splitlines() if ln.startswith("systemd-run")]


def test_status_starts_the_finish_job_by_itself_once(left_behind, monkeypatch, capsys):
    b = left_behind
    _, st = call(b, monkeypatch, capsys, "status")
    assert len(launches(b)) == 1
    assert st["job"]["kind"] == "finish" and st["job"]["phase"] == "starting"
    assert [s["key"] for s in st["job"]["steps"]] == list(aq.FINISH_FLOW)
    alive = aq._job_alive
    monkeypatch.setattr(aq, "_job_alive", lambda job: bool(job) and job.get("phase") in ("starting", "running"))
    call(b, monkeypatch, capsys, "status")  # a second poll while it runs starts nothing
    assert len(launches(b)) == 1
    monkeypatch.setattr(aq, "_job_alive", alive)
    assert b.run("upgrade", "run") == 0
    job = aq.load_upgrade_status()
    assert job["result"] == "ok" and job["kind"] == "finish", job
    for path, src in (("/usr/local/sbin/hermes-tools-cli", "deploy/hermes-tools-cli"),
                      ("/etc/sudoers.d/hermes-tools", "deploy/sudoers.d/hermes-tools"),
                      ("/etc/sudoers.d/aquarium-upgrade", "deploy/sudoers.d/aquarium-upgrade")):
        assert b.p(path).read_text() == NEW[src], path
    assert aq.load_state()["root_copies_for"] == "v1.1.0"
    assert aq.load_state()["upgrades"][-1]["kind"] == "finish"
    _, st = call(b, monkeypatch, capsys, "status")  # done: no new job
    assert len(launches(b)) == 1 and st["finish"] is None


def test_single_flight_two_status_calls_start_one_job(left_behind, monkeypatch, capsys):
    with aq._start_lock() as mine:
        assert mine
        aq.maybe_start_finish(aq.load_config())
        assert launches(left_behind) == []
    aq.maybe_start_finish(aq.load_config())
    aq.maybe_start_finish(aq.load_config())  # the first one's job is "starting" (pid not yet set)
    assert len(launches(left_behind)) <= 2


def test_failed_finish_puts_copies_back_and_does_not_loop(left_behind, monkeypatch, capsys):
    b = left_behind
    b.write("/opt/data/hermes-home/config.yaml", "terminal:\n  run_as: hermes-tools\n")
    monkeypatch.setenv("FAKE_SUDO_EXIT", "1")
    call(b, monkeypatch, capsys, "status")
    assert b.run("upgrade", "run") == 1
    job = aq.load_upgrade_status()
    assert job["result"] == "rolled back" and "agent's terminal (hermes-tools)" in job["error"]
    for path, (text, _mode) in OLD.items():
        assert b.p(path).read_text() == text, path
    for _ in range(3):  # later polls show the reason and never start it again by themselves
        _, st = call(b, monkeypatch, capsys, "status")
    assert len(launches(b)) == 1
    assert st["finish"]["failed"] is True and "agent's terminal" in st["finish"]["error"]
    # "Try again" goes through the start verb the old sudoers rule already allows
    monkeypatch.delenv("FAKE_SUDO_EXIT")
    code, answer = call(b, monkeypatch, capsys, "start", {"finish": True, "by": "Leo"})
    assert code == 0, answer
    assert answer["status"]["job"]["kind"] == "finish" and len(launches(b)) == 2
    assert b.run("upgrade", "run") == 0
    _, st = call(b, monkeypatch, capsys, "status")
    assert st["finish"] is None and b.p("/etc/sudoers.d/hermes-tools").read_text() == NEW["deploy/sudoers.d/hermes-tools"]


def test_finish_is_not_started_when_copies_match(left_behind, monkeypatch, capsys):
    b = left_behind
    for path, src in (("/usr/local/sbin/hermes-tools-cli", "deploy/hermes-tools-cli"),
                      ("/usr/local/lib/hermes-tools/bin/hermes", "deploy/hermes-tools-shim"),
                      ("/etc/sudoers.d/hermes-tools", "deploy/sudoers.d/hermes-tools"),
                      ("/etc/sudoers.d/aquarium-upgrade", "deploy/sudoers.d/aquarium-upgrade")):
        b.p(path).unlink()
        b.write(path, NEW[src], mode=0o755)
    call(b, monkeypatch, capsys, "status")
    assert launches(b) == []
    code, answer = call(b, monkeypatch, capsys, "start", {"finish": True})
    assert code == 1 and "already match" in answer["error"]


# --------------------------------------------------------------------------- pre-flight


def test_check_with_a_version_runs_the_preflight(rbox, monkeypatch, capsys):
    code, answer = call(rbox, monkeypatch, capsys, "check", {"version": "v1.1.0"})
    assert code == 0
    checks = {c["key"]: c for c in answer["preflight"]["checks"]}
    assert set(checks) == {"disk", "backup", "services", "release"}
    assert all(c["status"] == "ok" for c in checks.values()), checks
    assert "signature is valid" in checks["release"]["message"]
    assert not list(rbox.p("/var/lib/aquarium/upgrade-downloads").glob("check-*"))


def test_preflight_explains_each_failure(rbox, monkeypatch, capsys):
    rbox.set_systemd(down=["hermes-gateway.service"])
    monkeypatch.setenv("FAKE_COSIGN_EXIT", "1")
    real_usage = aq.shutil.disk_usage
    monkeypatch.setattr(aq.shutil, "disk_usage",
                        lambda p: real_usage(p)._replace(free=2 * 2**30))
    backups = rbox.p("/var/backups/aquarium")
    backups.mkdir(parents=True, exist_ok=True)
    backups.chmod(0o500)
    try:
        _, answer = call(rbox, monkeypatch, capsys, "check", {"version": "v1.1.0"})
    finally:
        backups.chmod(0o700)
    checks = {c["key"]: c for c in answer["preflight"]["checks"]}
    assert all(c["status"] == "fail" for c in checks.values()), checks
    assert "Only 2.0 GB of disk space is free" in checks["disk"]["message"]
    assert "backup folder can't be written" in checks["backup"]["message"]
    assert "hermes-gateway.service" in checks["services"]["message"]
    assert "signature is NOT valid" in checks["release"]["message"]


def test_start_refuses_when_the_preflight_fails(rbox, monkeypatch, capsys):
    real_usage = aq.shutil.disk_usage
    monkeypatch.setattr(aq.shutil, "disk_usage", lambda p: real_usage(p)._replace(free=1 * 2**30))
    code, answer = call(rbox, monkeypatch, capsys, "start", {"version": "v1.1.0"})
    assert code == 1 and "disk space" in answer["error"]
    assert launches(rbox) == []


def test_rollback_after_a_finish_restores_both_saved_sets(left_behind, monkeypatch, capsys):
    b = left_behind
    state = aq.load_state()
    backup = b.p("/var/backups/aquarium/aquarium-backup-x-pre-update-v1.1.0.tar.gz.gpg")
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_text("x")
    state.setdefault("upgrades", []).append({"id": "20261101T000000Z", "kind": "upgrade", "from": "v1.0.0",
                                             "from_ref": "v1.0.0", "to": "v1.1.0", "to_ref": "v1.1.0",
                                             "result": "ok", "backup": str(backup)})
    state.update(previous="v1.0.0")
    aq.save_state(state)
    call(b, monkeypatch, capsys, "status")
    assert b.run("upgrade", "run") == 0
    rb = aq.rollback_target(aq.load_config())
    assert rb and rb["to"] == "v1.0.0" and len(rb["root_copies"]) == 1


def test_terminal_probe_passes_the_real_allowlist_and_cli(tmp_path):
    """The probe runs through the shipped allowlist's own parser, needs no chat ticket
    (a `hermes projects` call is refused without one), and the real CLI answers it."""
    words = aq.probe_words(REPO)
    loader = importlib.machinery.SourceFileLoader("htc_real", str(REPO / "deploy/hermes-tools-cli"))
    cli = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
    loader.exec_module(cli)
    path = cli.check(list(words))
    assert path[0] not in cli.AS_REQUESTER
    assert cli.as_requester(path, list(words), "", b"") == (list(words), "")
    with pytest.raises(cli.Refused):
        cli.check(["projects", "--help"])
    got = subprocess.run([sys.executable, "-c", "import sys; from hermes_cli.main import main; "
                          f"sys.argv = ['hermes', *{words!r}]; main()"],
                         capture_output=True, text=True, timeout=120, cwd=REPO,
                         env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/tmp"),
                              "HERMES_HOME": str(tmp_path), "LANG": "C.UTF-8"})
    assert got.returncode == 0, got.stderr[-2000:]
    assert "usage: hermes" in got.stdout


def test_terminal_probe_falls_back_when_the_allowlist_has_no_parser(tmp_path):
    (tmp_path / "deploy").mkdir()
    (tmp_path / "deploy/hermes-tools-cli").write_text("# not the real one\n")
    assert aq.probe_words(tmp_path) == aq.TERMINAL_PROBES[0]


def test_git_upgrade_without_cosign_leaves_helpers_and_says_how(box, monkeypatch, capsys):  # noqa: F811
    git_box(box, monkeypatch)
    box.releases.clear()
    box.make_release("v1.0.0")
    box.make_release("v1.1.0", extra=NEW)
    releases(box)
    fakes(box, "visudo", "sudo")
    for path, (text, mode) in OLD.items():
        box.write(path, text, mode=mode)
    monkeypatch.setattr(aq, "find_cosign", lambda: None)
    code, job = upgrade(box, monkeypatch, capsys)
    assert code == 0 and job["result"] == "ok", job
    for path, (text, _mode) in OLD.items():
        assert box.p(path).read_text() == text, path
    out = "\n".join(job.get("log") or []) + capsys.readouterr().out
    assert "cosign is not installed" in out
    assert ("visudo -cf deploy/sudoers.d/hermes-tools && install -m 0440 -o root -g root "
            "deploy/sudoers.d/hermes-tools /etc/sudoers.d/hermes-tools") in out
