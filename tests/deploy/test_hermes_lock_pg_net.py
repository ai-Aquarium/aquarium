"""deploy/hermes-lock-pg-net closes Supabase's pg_net schema (`net`) to every login
but the Supabase roles that use it, so the app-data sandbox login reaches no table.

The behaviour tests run the script against a fake `docker` on PATH. The real-engine
test runs it against a Supabase Postgres container named by
HERMES_TEST_SUPABASE_DB_CONTAINER (e.g. `docker run -d --name pgnet-test
-e POSTGRES_PASSWORD=pw supabase/postgres:17.6.1.136`)."""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "deploy" / "hermes-lock-pg-net"
REAL_CONTAINER = os.environ.get("HERMES_TEST_SUPABASE_DB_CONTAINER", "")

FAKE_DOCKER = r'''#!/bin/bash
calls=$FAKE_DIR/calls
echo "docker $*" >> "$calls"
case "$1" in
  inspect) [ "$FAKE_RUNNING" = 1 ] && echo true || { echo "no such container" >&2; exit 1; } ;;
  exec)
    if [[ " $* " == *" -c "* ]]; then printf 'postgres\n_supabase\n'; exit 0; fi
    cat > "$FAKE_DIR/sql.$(( $(ls "$FAKE_DIR" | grep -c '^sql\.') + 1 ))"
    [ "${FAKE_FAIL:-0}" = 1 ] && { echo 'ERROR:  permission denied' >&2; exit 3; }
    echo 'NOTICE:  revoked TABLE net._http_response from PUBLIC' >&2 ;;
esac
'''


def run(tmp_path: Path, *args: str, running: bool = True, fail: bool = False) -> subprocess.CompletedProcess:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "FAKE_DIR": str(tmp_path),
           "FAKE_RUNNING": "1" if running else "0", "FAKE_FAIL": "1" if fail else "0"}
    return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=env, check=False)


def calls(tmp_path: Path) -> list[str]:
    f = tmp_path / "calls"
    return f.read_text().splitlines() if f.exists() else []


def test_skips_without_a_running_database_container(tmp_path: Path):
    proc = run(tmp_path, running=False)
    assert proc.returncode == 0, proc.stderr
    assert "skipped" in proc.stdout
    assert not [c for c in calls(tmp_path) if c.startswith("docker exec")]


def test_rejects_unknown_arguments(tmp_path: Path):
    assert run(tmp_path, "--force").returncode == 2


def test_locks_every_database_as_supabase_admin(tmp_path: Path):
    proc = run(tmp_path, "--container", "db1")
    assert proc.returncode == 0, proc.stderr
    execs = [c for c in calls(tmp_path) if c.startswith("docker exec")]
    assert execs and all(" -i db1 psql -U supabase_admin " in c for c in execs)
    assert [c.split(" -d ")[1].split()[0] for c in execs[1:]] == ["postgres", "_supabase"]
    sql = (tmp_path / "sql.1").read_text()
    assert "pg_extension WHERE extname = 'pg_net'" in sql  # a no-op without pg_net
    assert "REVOKE ALL ON %s FROM %s" in sql
    assert "pg_net (postgres): revoked TABLE net._http_response from PUBLIC" in proc.stdout


def test_a_failed_lock_fails_the_step(tmp_path: Path):
    proc = run(tmp_path, fail=True)
    assert proc.returncode == 1
    assert "locking failed in database postgres" in proc.stderr


def test_install_and_deploy_lock_pg_net_after_migrating():
    install = (REPO / "install-aquarium.sh").read_text()
    migrate = install.index("hermes_cli.db_migrate --dsn-stdin < /etc/aquarium/db-admin.env")
    assert migrate < install.index("bash deploy/hermes-lock-pg-net")
    deploy = (REPO / "deploy" / "hermes-deploy.sh").read_text()
    lock = deploy.index('bash "$REPO/deploy/hermes-lock-pg-net"')
    assert deploy.index("hermes_cli.db_migrate --dsn-stdin") < lock < deploy.index('echo "== restarting services =="')


def test_release_update_locks_pg_net_with_the_new_release(tmp_path: Path, monkeypatch):
    spec = importlib.util.spec_from_file_location("aquarium_cli_pgnet", REPO / "deploy" / "aquarium.py")
    aq = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(aq)
    (tmp_path / "deploy").mkdir()
    (tmp_path / "deploy" / "hermes-lock-pg-net").write_text("")
    seen: list[list[str]] = []
    monkeypatch.delenv("AQUARIUM_TEST_PREFIX", raising=False)
    monkeypatch.setattr(aq, "db_running", lambda cfg: True)
    monkeypatch.setattr(aq, "run", lambda argv, **kw: seen.append(list(argv)) or subprocess.CompletedProcess(argv, 0))
    aq.lock_pg_net({"DB_CONTAINER": "supabase-db"}, tmp_path)
    assert seen == [["bash", str(tmp_path / "deploy" / "hermes-lock-pg-net"), "--container", "supabase-db"]]
    src = (REPO / "deploy" / "aquarium.py").read_text()
    assert src.index('run_probe(cfg, rel, "migrate")') < src.index("lock_pg_net(cfg, rel)") < src.index('mark("restart")')


# ------------------------------------------------------------------ real Supabase Postgres
REACH = """SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r','v','m','p','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
    AND n.nspname !~ '^pg_(temp|toast)' AND has_schema_privilege(n.oid, 'USAGE')
    AND has_any_column_privilege(c.oid, 'SELECT')"""


def psql(sql: str) -> str:
    proc = subprocess.run(["docker", "exec", "-i", REAL_CONTAINER, "psql", "-U", "supabase_admin", "-d", "postgres",
                           "-XAtq", "-v", "ON_ERROR_STOP=1"], input=sql, capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.strip()


@pytest.mark.skipif(not REAL_CONTAINER or not shutil.which("docker"),
                    reason="HERMES_TEST_SUPABASE_DB_CONTAINER not set")
def test_real_pg_net_closed_to_app_logins_and_open_to_webhooks():
    # pg_net's own install (and upgrade) grants, as on a stock Supabase database.
    psql("CREATE EXTENSION IF NOT EXISTS pg_net;"
         " GRANT USAGE ON SCHEMA net TO PUBLIC; GRANT ALL ON ALL SEQUENCES IN SCHEMA net TO PUBLIC;"
         " GRANT ALL ON ALL TABLES IN SCHEMA net TO PUBLIC;"
         " DROP ROLE IF EXISTS lock_test_sandbox; CREATE ROLE lock_test_sandbox LOGIN NOINHERIT;")
    assert psql(f"SET ROLE lock_test_sandbox; {REACH};") == "2"
    for _ in range(2):  # idempotent
        proc = subprocess.run(["bash", str(SCRIPT), "--container", REAL_CONTAINER],
                              capture_output=True, text=True, check=False)
        assert proc.returncode == 0, proc.stderr
    assert "revoked" not in proc.stdout
    assert psql(f"SET ROLE lock_test_sandbox; {REACH};") == "0"
    assert psql("SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'net'::regnamespace"
                " AND has_function_privilege('lock_test_sandbox', p.oid, 'EXECUTE')") == "0"
    for role in ("anon", "authenticated"):
        assert psql(f"SELECT has_schema_privilege('{role}', 'net', 'USAGE')") == "f"
    # Database webhooks queue requests as supabase_functions_admin; postgres still reads results.
    assert psql("SET ROLE supabase_functions_admin; SELECT net.http_get('http://127.0.0.1:9/') > 0;") == "t"
    assert psql("SET ROLE postgres; SELECT count(*) >= 0 FROM net._http_response;") == "t"
    psql("DROP ROLE lock_test_sandbox;")
