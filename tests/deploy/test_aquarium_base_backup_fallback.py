"""An upgrade uses a base backup only when it is safe; otherwise it takes a full backup."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_aquarium_base_backup import (  # noqa: F401
    BACKUPS,
    HOME,
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
