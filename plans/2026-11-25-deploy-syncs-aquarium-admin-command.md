# Deploy syncs the aquarium admin command

**Date:** 2026-11-25
**Scope:** `deploy/hermes-deploy.sh`, `docs/packaging/RELEASES.md`

## Problem

`deploy/aquarium.py` is installed to root-owned `/usr/local/sbin/aquarium` — the
only copy the web server can invoke (`sudo -n`) for every upgrade verb
(`status`, `releases`, `check`, `start`, `rollback`). `hermes-deploy.sh` only
updated the checkout, so the root copy drifted behind the deployed code:

- **HSD:** helper predated the pre-flight feature → `check` silently ignored
  `{"version": …}` → API returned empty check rows → the page showed four
  eternal "checking…" rows (real incident, this session).
- **Leo's box:** deploy warned `AQUARIUM ADMIN COMMAND STALE` for weeks; nobody
  acted because the warning lives in deploy output no one re-reads.

Warn-only is a reasonable default for root copies, but this one copy's drift
breaks a user-facing feature *silently* — the operator finds out only when the
upgrade page misbehaves.

## Change

`hermes-deploy.sh` now syncs `deploy/aquarium.py` → `/usr/local/sbin/aquarium`
(install `0755 root:root`) whenever the copy exists and differs; a missing copy
is still reported, not installed (a feature never set up stays off).

Why this is safe here:

- The script **aborts on release layouts** (`[ -L "$REPO" ]`) — it only ever
  runs on git checkouts. The release flow's verified-package copy install is
  untouched.
- Post-F13 the checkout is root-owned, so `deploy/aquarium.py` is not
  service-writable — copying it does not move untrusted content into a root
  path.
- The deploy already runs repo code as root every time
  (`./.venv/bin/python -I scripts/deploy_state.py`).

The other root copies (vpn/wa/tools/security helpers, sudoers rules, app
units) stay report-only; their staleness fails visibly, not silently.

## Verification

- `bash -n deploy/hermes-deploy.sh` — clean.
- Manual: installed fresh `aquarium.py` on both boxes this session; real
  `upgrade check` returns all 4 pre-flight rows in <1 s.
- Next deploy exercises the sync path live (both boxes currently match, so a
  no-op run is the expected first case; the sync branch is the same
  `install` invocation we ran by hand).
