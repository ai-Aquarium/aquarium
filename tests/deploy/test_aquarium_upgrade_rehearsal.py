"""Rehearse HSD's real first upgrade into this release, old job code included.

The box runs an OLD release. The admin clicks Upgrade: the OLD release's own
`aquarium upgrade start` + `upgrade run` (loaded from that release, not from this tree)
switches to the new release and refreshes `/usr/local/sbin/aquarium`, but leaves the
other root copies stale. The page's next status poll runs the NEW command, which starts
the finish job by itself; that installs every root copy the box has from the new
release (real `visudo -cf` when the host has it). An explicit rollback then puts the old
copies back.

By default the old release is a git tag (v0.2.7, what HSD runs, and the newest tag) and
the new one is this tree. The release workflow points AQUARIUM_REHEARSAL_FROM /
AQUARIUM_REHEARSAL_TO at the previous published tarball and the tarball it just built.
What stays fake: systemd, Docker/Postgres, the GitHub API, cosign, sudo and the build
(see test_aquarium_cli.Box).
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

from test_aquarium_cli import REPO, Handler, aq, server  # noqa: F401
from test_aquarium_upgrade import box, call, releases  # noqa: F401
from test_aquarium_upgrade_root_copies import fakes

pytestmark = pytest.mark.live_system_guard_bypass

HSD_RELEASE = "v0.2.7"
SOURCES = sorted({src for _inst, src, _label, _kind in aq.ROOT_COPIES} | {"deploy/aquarium.py"})


def _tag_files(tag: str) -> dict[str, str] | None:
    out = {}
    for src in SOURCES:
        got = subprocess.run(["git", "-C", str(REPO), "show", f"{tag}:{src}"], capture_output=True, text=True)
        if got.returncode == 0:
            out[src] = got.stdout
    return out or None


def _tarball_files(path: str) -> tuple[str, dict[str, str]]:
    out, version = {}, ""
    with tarfile.open(path) as tar:
        for m in tar.getmembers():
            top, _, rest = m.name.partition("/")
            if rest == "VERSION":
                version = tar.extractfile(m).read().decode().strip()
            if rest in SOURCES and m.isfile():
                out[rest] = tar.extractfile(m).read().decode()
    assert version and "deploy/aquarium.py" in out, f"{path} is not a release tarball"
    return version, out


def _tree_files() -> dict[str, str]:
    return {src: (REPO / src).read_text() for src in SOURCES if (REPO / src).exists()}


def _numbers(version: str) -> tuple[int, int, int]:
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", version)
    assert m, f"not a release version: {version!r}"
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def _target() -> tuple[int, int, int]:
    return _numbers((REPO / "VERSION").read_text().strip())


def _newest_tag_below(target: tuple[int, int, int]) -> str | None:
    """The newest stable tag strictly older than the release being built: never the target
    tag itself (its root copies match this tree) and never a newer line (a hotfix)."""
    got = subprocess.run(["git", "-C", str(REPO), "tag", "--list", "v*"], capture_output=True, text=True)
    tags = [t for t in got.stdout.split() if re.fullmatch(r"v\d+\.\d+\.\d+", t) and _numbers(t) < target]
    return max(tags, key=_numbers) if tags else None


def _bump(version: str) -> str:
    major, minor, patch = _numbers(version)
    return f"v{major}.{minor}.{patch + 1}"


REHEARSAL_ENV = ("AQUARIUM_REHEARSAL_FROM", "AQUARIUM_REHEARSAL_TO")


def _cases():
    given = [os.environ.get(k, "") for k in REHEARSAL_ENV]
    if any(given):
        # the release workflow's publish gate: never fall back to tags silently
        missing = [k for k, v in zip(REHEARSAL_ENV, given) if not v or not Path(v).is_file()]
        if missing:
            raise RuntimeError(f"rehearsal tarball missing: {', '.join(missing)} = {given}")
        return ["published"]
    target = _target()
    return sorted({t for t in (HSD_RELEASE, _newest_tag_below(target)) if t and _numbers(t) < target})


def _load(path: Path, name: str):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _cli(mod, monkeypatch, capsys, verb, body=None):
    capsys.readouterr()
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(body) if body is not None else ""))
    code = mod.main(["upgrade", verb])
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.startswith("{")]
    return code, (json.loads(lines[-1]) if lines else {})


@pytest.mark.parametrize("old_ref", _cases())
def test_first_upgrade_with_the_old_job_code_then_finish_then_rollback(box, monkeypatch, capsys, old_ref):  # noqa: F811
    if old_ref == "published":
        old_version, old = _tarball_files(os.environ["AQUARIUM_REHEARSAL_FROM"])
        new_version, new = _tarball_files(os.environ["AQUARIUM_REHEARSAL_TO"])
    else:
        old = _tag_files(old_ref)
        if not old:
            pytest.skip(f"{old_ref} is not in this checkout (shallow clone without tags)")
        old_version, new = old_ref, _tree_files()
        new_version = _bump((REPO / "VERSION").read_text().strip())
    b = box
    box.make_release(old_version, extra=old, cli_text=old["deploy/aquarium.py"])
    box.make_release(new_version, extra=new, cli_text=new["deploy/aquarium.py"])
    releases(b)
    b.install_release(old_version)
    rel = b.p(f"/opt/aquarium/releases/{old_version}")
    for src, text in old.items():
        (rel / src).parent.mkdir(parents=True, exist_ok=True)
        (rel / src).write_text(text)
    # the box has every root copy the old release ships, as its installer left them
    installed = {}
    for inst, src, _label, kind in aq.ROOT_COPIES:
        if src in old:
            b.write(inst, old[src], mode=0o440 if kind == "sudoers" else 0o755)
            installed[inst] = src
    b.write("/usr/local/sbin/aquarium", old["deploy/aquarium.py"], mode=0o755)
    b.write("/opt/data/hermes-home/profiles/sales/config.yaml", "terminal:\n  run_as: hermes-tools\n")
    fakes(b, "sudo")
    if shutil.which("visudo", path="/usr/sbin:/usr/bin:/sbin"):
        os.symlink(shutil.which("visudo", path="/usr/sbin:/usr/bin:/sbin"), b.bin / "visudo")
    else:
        fakes(b, "visudo")
    assert _numbers(old_version) < _numbers(new_version), (old_version, new_version)
    # a release that changes no root copy still upgrades; there is just nothing to finish
    stale = [inst for inst, src in installed.items() if old[src] != new.get(src)]

    # 1. the Upgrade click, handled by the OLD release's own command
    old_cmd = _load(b.p("/usr/local/sbin/aquarium"), "aquarium_old")
    assert _cli(old_cmd, monkeypatch, capsys, "check")[0] == 0
    code, answer = _cli(old_cmd, monkeypatch, capsys, "start", {"version": new_version, "by": "HSD admin"})
    assert code == 0 and answer["started"], answer
    assert old_cmd.main(["upgrade", "run"]) == 0, old_cmd.load_upgrade_status()
    assert os.readlink(b.p("/opt/aquarium/current")) == f"releases/{new_version}"
    assert b.p("/usr/local/sbin/aquarium").read_text() == new["deploy/aquarium.py"]
    left = [i for i in stale if i != "/usr/local/sbin/aquarium" and b.p(i).read_text() != new[installed[i]]]
    if not hasattr(old_cmd, "finish_needed") and any(i != "/usr/local/sbin/aquarium" for i in stale):
        assert left, "the old job code is expected to leave root copies stale"

    # 2. the page's next poll runs the NEW command: it starts the finish job by itself
    new_cmd = _load(b.p("/usr/local/sbin/aquarium"), "aquarium_new")
    launched = len([ln for ln in b.log().splitlines() if ln.startswith("systemd-run")])
    _, st = _cli(new_cmd, monkeypatch, capsys, "status")
    if left:
        assert st["job"]["kind"] == "finish" and st["job"]["phase"] == "starting", st["job"]
        assert new_cmd.main(["upgrade", "run"]) == 0, new_cmd.load_upgrade_status()
        assert new_cmd.load_upgrade_status()["result"] == "ok"
    for inst, src in installed.items():
        f = b.p(inst)
        assert f.read_text() == new[src], inst
        assert f.stat().st_mode & 0o777 == (0o440 if inst.startswith("/etc/sudoers.d/") else 0o755), inst
    assert "hermes-tools-exec bash -c hermes memory status --help" in b.log()
    _, st = _cli(new_cmd, monkeypatch, capsys, "status")  # done: nothing more starts
    assert st["job"]["kind"] in ("finish", "upgrade") and st["finish"] is None
    assert len([ln for ln in b.log().splitlines() if ln.startswith("systemd-run")]) == launched + bool(left)

    # 3. an explicit rollback puts the old release and its root copies back
    monkeypatch.setattr(new_cmd, "_restore_backup", lambda cfg, path: None)
    code, answer = _cli(new_cmd, monkeypatch, capsys, "rollback", {"by": "HSD admin"})
    assert code == 0, answer
    assert new_cmd.main(["upgrade", "run"]) == 0, new_cmd.load_upgrade_status()
    assert os.readlink(b.p("/opt/aquarium/current")) == f"releases/{old_version}"
    for inst, src in installed.items():
        assert b.p(inst).read_text() == old[src], inst
