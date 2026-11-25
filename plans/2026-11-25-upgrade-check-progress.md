---
title: "fix(agent-home): pre-flight checks show progress and can't spin forever"
status: implemented
date: 2026-11-25
type: fix
target_repo: aquarium (deploy/aquarium.py, software_upgrade_api, agent-home upgrade page)
---

# Upgrade pre-flight checks: live progress + no eternal spinners

## Symptom (HSD, v0.2.13)

Settings → Software upgrade → pick v0.2.16: all four checks (Disk space,
Backup folder, Services, Release download) sat at "checking…" forever.

## Root cause (two bugs)

1. **One synchronous call.** `POST /api/software-upgrade/check` →
   `subprocess.run("sudo aquarium upgrade check", timeout=240)` runs
   `cached_releases(refresh)` (GitHub API) then `upgrade_preflight`
   (disk → backup write probe → every health probe → release verify:
   GitHub API again + 3 signature-file downloads ×120 s + cosign ≤180 s).
   The page renders every row pending until the single answer arrives —
   worst case ~9 min, and unreachable-but-slow endpoints (DNS hangs are
   not covered by urllib timeouts) burn past the 240 s cap.
2. **Swallowed timeout → eternal spinners.** On `TimeoutExpired` the API
   returned `{"ok": False, "error": "took too long"}` without `preflight`
   rows; `preflight_view` then emitted `checks: []`, and the page maps a
   missing row to "checking…" — the error never surfaced.

## Fix

- `deploy/aquarium.py`: `upgrade_preflight` (when given a version) now
  writes `/var/lib/aquarium/upgrade-check.json` incrementally — each row
  appears `status:"running"` first, then `ok`/`fail`, with plain-language
  sub-notes inside the release check ("Downloading SHA256SUMS…",
  "Verifying the release's signature."). `upgrade_public_status` serves
  it as `"check"`. The `upgrade start` path (`version=None`) does not
  write it.
- `software_upgrade_api.py`: `check_view` shapes those rows into every
  status/job answer; when the helper returns no `preflight` (timeout,
  crash), `upgrade_check` now puts the helper's error into
  `preflight.error` so the page shows *why*.
- `SoftwareUpgradeView`: while the check POST is in flight it polls
  `/api/software-upgrade/job` every 2 s and merges live rows under the
  finished answer (which always wins); `preflight.error` renders as the
  alert alongside any partial rows.
- Old helpers (e.g. HSD's v0.2.13) simply never write the file — the
  page behaves exactly as before for them, except the timeout error now
  surfaces instead of spinning forever.

## Verified

- vitest `SoftwareUpgradeView.test.tsx` — 25 pass incl. live-row merge +
  error-surface cases.
- `test_software_upgrade_api.py` — 49 pass incl. timeout-error +
  `check_view` filtering; `test_aquarium_upgrade.py` — progress file +
  `status` serves it (4 unrelated failures are `gpg is not installed` on
  this Mac; CI has gpg).
- `tsc --noEmit` + eslint clean.

## Not yet verified

- Real stalled check on HSD showing which row is actually stuck
  (suspect: "Release download" — the asset CDN — or a DNS-hung GitHub
  API call). HSD is a git checkout; it needs the checkout updated on the
  box itself to get this fix — the UI upgrade flow can't deliver it while
  its own check is the thing that hangs.
