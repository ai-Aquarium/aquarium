"""Background base backup + incremental pre-upgrade backups, against the fake box of
test_aquarium_cli (fake root, fake systemctl/docker, real gpg, tar and SQLite)."""
from __future__ import annotations

import gzip
import io
import json
import os
import sqlite3
import subprocess
import sys
import tarfile
import threading
import time
from pathlib import Path

import pytest

from test_aquarium_cli import FAKE_LOGGER, Box, Handler, aq, released_box, server  # noqa: E402,F401

pytestmark = pytest.mark.live_system_guard_bypass

HOME = "/opt/data/hermes-home"
BACKUPS = "/var/backups/aquarium"


@pytest.fixture
def box(tmp_path, monkeypatch, server):  # noqa: F811
    b = Box(tmp_path, monkeypatch, server)
    Handler.routes["/health"] = Handler.routes["/bridge/health"]
    fake = b.bin / "systemd-run"
    fake.write_text(FAKE_LOGGER.replace("#!PY", "#!" + sys.executable))
    fake.chmod(0o755)
    monkeypatch.setattr(aq.os, "dup2", lambda *_: None)
    released_box(b)
    return b


def key(box) -> Path:
    return box.p("/etc/aquarium/backup.key")


def make_base(box) -> Path:
    assert box.run("backup", "--base") == 0
    bases = sorted(box.p(BACKUPS).glob("*+base.tar.gz.gpg"))
    assert bases
    return bases[-1]


def touch(box, path: str, text: str) -> None:
    f = box.write(path, text)
    later = time.time_ns() + 5_000_000_000
    os.utime(f, ns=(later, later))


def archive_members(box, path: Path) -> set:
    data = aq._gpg_read(path, key(box))
    assert data is not None
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        return {m.name for m in tar.getmembers() if m.isfile()}


def change_box(box):
    """Edit one file, add one, delete one, and write to the live SQLite database."""
    touch(box, f"{HOME}/config.yaml", "model: changed\n")
    touch(box, f"{HOME}/notes/new.md", "new since the base\n")
    os.unlink(box.p(f"{HOME}/whatsapp/session-personal/creds.json"))
    db = sqlite3.connect(box.p(f"{HOME}/state.db"))
    db.execute("insert into t values (43)")
    db.commit()
    db.close()


def test_base_backup_records_every_file_and_its_status(box):
    box.write(f"{HOME}/cache/vision/temp_image_1.jpg", "scratch")
    box.write(f"{HOME}/cache/documents/kept.pdf", "attachment")
    base = make_base(box)
    idx = json.loads(aq._gpg_read(Path(str(base) + ".index.gpg"), key(box)))
    assert idx["name"] == base.name and idx["size"] == base.stat().st_size
    assert idx["sha256"] == aq.sha256_file(base)
    entry = idx["tree"][f"root{HOME}/config.yaml"]
    st = box.p(f"{HOME}/config.yaml").stat()
    assert entry["size"] == st.st_size and entry["mtime_ns"] == st.st_mtime_ns and len(entry["sha256"]) == 64
    assert f"root{HOME}/cache/documents/kept.pdf" in idx["tree"]
    assert not any("/cache/vision" in name for name in idx["tree"])
    status = json.loads(box.p(aq.BASE_STATUS).read_text())
    assert status["state"] == "done" and status["name"] == base.name and status["pid"] is None
    dest = box.tmp / "o"
    dest.mkdir()
    manifest = aq.open_backup(base, key(box), dest)
    assert manifest["kind"] == "base"
    assert set(manifest["timings"]) >= {"database", "app_dbs", "sqlite", "files", "compress_encrypt"}


def test_delta_holds_only_changes_and_restores_byte_for_byte(box):
    make_base(box)
    change_box(box)
    cfg = aq.load_config()
    base = aq.pick_base(cfg)
    assert base is not None
    delta = aq.make_backup(cfg, label="pre-update-v1.1.0", base=base)
    assert delta.name.endswith(f"+base-{base['created']}.tar.gz.gpg")
    r = f"root{HOME}"
    assert archive_members(box, delta) == {"db/postgres.dump", "db/globals.sql", "manifest.json",
                                           f"{r}/config.yaml", f"{r}/notes/new.md", f"{r}/state.db"}
    dest = box.tmp / "opened"
    dest.mkdir()
    manifest = aq.open_backup(delta, key(box), dest)
    assert manifest["kind"] == "delta" and manifest["base"]["name"] == base["name"]
    live = {}
    for src in manifest["paths"]:
        for p in aq.iter_tree(aq.P(src)):
            if p.is_file() and not p.is_symlink() and p.name != "state.db":
                live["root" + aq.real(p)] = p.read_bytes()
    opened = {str(p.relative_to(dest)): p.read_bytes() for p in (dest / "root").rglob("*")
              if p.is_file() and p.name != "state.db"}
    assert opened == live  # nothing missing, nothing extra (the deleted file is gone)
    assert not (dest / f"{r}/whatsapp/session-personal/creds.json").exists()
    db = sqlite3.connect(dest / f"{r}/state.db")
    assert db.execute("select count(*) from t").fetchone() == (2,)
    assert not list(dest.glob(".base-*"))


def test_restoring_a_delta_puts_the_exact_state_back(box, capsys):
    make_base(box)
    change_box(box)
    cfg = aq.load_config()
    delta = aq.make_backup(cfg, label="pre-upgrade-x", base=aq.pick_base(cfg))
    touch(box, f"{HOME}/config.yaml", "model: after the upgrade\n")
    box.write(f"{HOME}/whatsapp/session-personal/creds.json", "came back")
    assert box.run("restore", str(delta), "--test") == 0, capsys.readouterr().out
    assert box.run("restore", str(delta), "--yes", "--no-safety-backup") == 0, capsys.readouterr().out
    assert box.p(f"{HOME}/config.yaml").read_text() == "model: changed\n"
    assert box.p(f"{HOME}/notes/new.md").read_text() == "new since the base\n"
    assert not box.p(f"{HOME}/whatsapp/session-personal/creds.json").exists()


def test_delta_without_its_base_is_refused_clearly(box, capsys):
    base = make_base(box)
    cfg = aq.load_config()
    delta = aq.make_backup(cfg, label="pre-upgrade-x", base=aq.pick_base(cfg))
    base.rename(box.tmp / base.name)
    assert box.run("restore", str(delta), "--test") == 1
    assert "holds only the changes since" in capsys.readouterr().out
    (box.tmp / base.name).write_bytes(b"replaced")
    os.replace(box.tmp / base.name, base)
    assert box.run("restore", str(delta), "--test") == 1
    assert "damaged or was replaced" in capsys.readouterr().out


def _rewrite_index(box, base: Path, **changes):
    path = Path(str(base) + ".index.gpg")
    idx = json.loads(aq._gpg_read(path, key(box)))
    idx.update(changes)
    aq._gpg_write(json.dumps(idx).encode(), key(box), path)


@pytest.mark.parametrize("case", ["missing", "no-index", "other-key", "stale", "other-server", "other-folders",
                                  "truncated", "bitflip", "in-progress"])
def test_unusable_base_falls_back_to_a_full_backup(box, capsys, case):
    if case != "missing":
        base = make_base(box)
    if case == "no-index":
        Path(str(base) + ".index.gpg").unlink()
    elif case == "other-key":
        key(box).write_text("a new key\n")
    elif case == "stale":
        conf = box.p("/etc/aquarium/aquarium.conf")
        conf.write_text(conf.read_text() + "BACKUP_BASE_MAX_AGE_HOURS=0\n")
    elif case == "other-server":
        _rewrite_index(box, base, hostname="elsewhere")
    elif case == "other-folders":
        _rewrite_index(box, base, paths=["/somewhere/else"])
    elif case == "truncated":
        with open(base, "ab") as fh:
            fh.write(b"x")
    elif case == "bitflip":
        data = bytearray(base.read_bytes())
        data[len(data) // 2] ^= 1
        base.write_bytes(bytes(data))
    elif case == "in-progress":
        base.unlink()
        Path(str(base) + ".index.gpg").unlink()
        part = box.p(f"{BACKUPS}/aquarium-backup-20990101T000000Z+base.tar.gz.gpg.part")
        part.write_bytes(b"half written")
        aq.save_base_status({"state": "running", "pid": None})
    capsys.readouterr()
    assert aq.pick_base(aq.load_config()) is None
    assert "full backup:" in capsys.readouterr().out
    assert box.run("update") == 0, capsys.readouterr().out
    pre = list(box.p(BACKUPS).glob("*-pre-update-v1.1.0*.tar.gz.gpg"))
    assert len(pre) == 1 and "+base-" not in pre[0].name
    assert not list(box.p(BACKUPS).glob("*.part"))


def test_old_level9_full_backup_still_restores(box, capsys):
    """A backup as the earlier `make_backup` wrote it: gzip level 9, gpg compression, no kind."""
    home = box.p(HOME)
    manifest = {"format": 1, "created": "20260101T000000Z", "label": "manual", "release": "v1.0.0",
                "layout": "release", "hostname": "old", "files": {}, "paths": [HOME], "db": None,
                "apps_db": []}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w|gz") as tar:  # default level 9
        for p in aq.iter_tree(home):
            arc = "root" + aq.real(p)
            info = tar.gettarinfo(str(p), arc)
            if info.isfile():
                data = p.read_bytes()
                manifest["files"][arc] = aq.hashlib.sha256(data).hexdigest()
                tar.addfile(info, io.BytesIO(data))
            else:
                tar.addfile(info)
        data = json.dumps(manifest).encode()
        info = tarfile.TarInfo("manifest.json")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    assert box.run("backup") == 0  # creates the key
    old = box.p(f"{BACKUPS}/aquarium-backup-20260101T000000Z-manual.tar.gz.gpg")
    subprocess.run(["gpg", "--batch", "--yes", "--quiet", "--pinentry-mode", "loopback", "--passphrase-file",
                    str(key(box)), "--homedir", str(box.tmp), "--symmetric", "--cipher-algo", "AES256",
                    "-o", str(old)], input=buf.getvalue(), check=True)
    touch(box, f"{HOME}/config.yaml", "changed\n")
    assert box.run("restore", str(old), "--test") == 0, capsys.readouterr().out
    assert box.run("restore", str(old), "--yes", "--no-safety-backup") == 0, capsys.readouterr().out
    assert box.p(f"{HOME}/config.yaml").read_text() == "model: x\n"


def test_new_backups_are_plain_gzip(box):
    assert box.run("backup") == 0
    path = sorted(box.p(BACKUPS).glob("*-manual.tar.gz.gpg"))[-1]
    data = aq._gpg_read(path, key(box))
    assert data[:2] == b"\x1f\x8b" and gzip.decompress(data)[257:262] == b"ustar"


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


def _names(folder: Path) -> list:
    return sorted(p.name for p in folder.iterdir())


@pytest.mark.parametrize("keep, gone", [
    (2, {"B1", "D1", "F0"}),
    (3, {"F0"}),
])
def test_prune_keeps_every_base_a_kept_delta_needs(box, keep, gone):
    folder = box.p(BACKUPS)
    folder.mkdir(parents=True)
    names = {
        "F0": "aquarium-backup-20261031T000000Z-manual.tar.gz.gpg",
        "B1": "aquarium-backup-20261101T000000Z+base.tar.gz.gpg",
        "D1": "aquarium-backup-20261102T000000Z-pre-update-v1+base-20261101T000000Z.tar.gz.gpg",
        "F": "aquarium-backup-20261103T000000Z-manual.tar.gz.gpg",
        "B2": "aquarium-backup-20261104T000000Z+base.tar.gz.gpg",
        "D2": "aquarium-backup-20261105T000000Z-pre-upgrade-v2+base-20261104T000000Z.tar.gz.gpg",
        "B3": "aquarium-backup-20261106T000000Z+base.tar.gz.gpg",
    }
    for tag, name in names.items():
        (folder / name).write_bytes(b"x")
        if tag.startswith("B"):
            (folder / (name + ".index.gpg")).write_bytes(b"x")
    cfg = {**aq.load_config(), "BACKUP_KEEP": str(keep)}
    aq.prune_backups(cfg)
    left = set(_names(folder))
    for tag, name in names.items():
        assert (name in left) == (tag not in gone), tag
        if tag.startswith("B"):
            assert (name + ".index.gpg" in left) == (tag not in gone)


def test_units_ship_in_deploy_and_run_at_low_priority():
    repo = Path(__file__).resolve().parents[2]
    for name, text in aq.base_backup_units().items():
        assert (repo / "deploy" / name).read_text() == text
    service = aq.base_backup_units()["aquarium-base-backup.service"]
    assert "Nice=19" in service and "IOSchedulingClass=idle" in service
    assert "ExecStart=/usr/local/sbin/aquarium backup --base" in service


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


def test_permission_only_change_is_kept(box, capsys):
    script = box.write(f"{HOME}/notes/run.sh", "echo hi\n")
    os.chmod(script, 0o644)
    make_base(box)
    os.chmod(script, 0o755)
    cfg = aq.load_config()
    delta = aq.make_backup(cfg, label="pre-upgrade-x", base=aq.pick_base(cfg))
    assert f"root{HOME}/notes/run.sh" in archive_members(box, delta)
    os.chmod(script, 0o600)
    assert box.run("restore", str(delta), "--yes", "--no-safety-backup") == 0, capsys.readouterr().out
    assert box.p(f"{HOME}/notes/run.sh").stat().st_mode & 0o777 == 0o755


def test_a_reader_without_delta_support_refuses_a_delta(box):
    """The old open_backup checks that every file in the manifest was unpacked."""
    make_base(box)
    cfg = aq.load_config()
    delta = aq.make_backup(cfg, label="pre-upgrade-x", base=aq.pick_base(cfg))
    dest = box.tmp / "old"
    dest.mkdir()
    with tarfile.open(fileobj=io.BytesIO(aq._gpg_read(delta, key(box))), mode="r:gz") as tar:
        tar.extractall(dest, filter="tar")
    manifest = json.loads((dest / "manifest.json").read_text())
    missing = [n for n in manifest["files"] if not (dest / n).is_file()]
    assert missing and set(missing) == set(manifest["inherited"])
    assert f"root{HOME}/config.yaml" in manifest["files"]


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
