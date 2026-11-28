# Fleet page: all Aquarium instances + per-box layout switch, only on Leo's box

A new **Settings → Fleet** page that lists the Aquarium boxes this server
manages and lets the owner switch each box between its two install layouts:

- **software upgrade** (release layout): `/opt/data/hermes-agent` is a symlink
  into `/opt/aquarium/current`; updates install verified releases —
  `aquarium update` / the Software upgrade page.
- **direct deploy** (git layout): a real checkout at `/opt/data/hermes-agent`;
  deploys run `deploy-hermes.sh` — incremental (warm .venv/npm cache), much
  faster than a cold release build on slow boxes.

Motivation: HSD's release build takes 30–60 min, so weekends/hotfixes want
direct deploy while normal operation wants the signed-release path. The switch
in both directions is already supported by `install-aquarium.sh --from-branch`
(release→git) and `aquarium migrate-layout` (git→release); this page automates
them remotely.

## Config gate — the feature exists only where it's set up

Everything keys off `/etc/aquarium/fleet.json` (root:root 0600, never shipped):

```json
{
  "schema": 1,
  "ssh": { "user": "root", "identity": "/etc/aquarium/fleet_id_ed25519", "connect_timeout": 8 },
  "boxes": [
    { "name": "leo", "label": "Leo's box", "self": true, "branch": "develop" },
    { "name": "hsd", "label": "HSD", "host": "<box-host>", "branch": "develop" }
  ]
}
```

No file → `GET /api/fleet` answers `available: false` and the Settings tile
stays hidden. Hosts and the SSH key never leave the helper: rows carry only
`name`, `label`, `self`, reachability and the installed picture. `self: true`
boxes are answered locally (no SSH). Hosts/IPs belong in
`ai-Aquarium/aquarium-ops` PRODUCTION.md, not this repo.

## Pieces

**`aquarium fleet <verb>` in `deploy/aquarium.py`** (root, JSON in/out):

- `fleet probe` — `{available}` only; the Settings index's cheap check (no SSH).
- `fleet status` — one row per box: `name/label/self/reachable/installed/job/
  switch/error`. Remote rows are the box's own `aquarium upgrade status` over
  `ssh -o BatchMode=yes -i <identity>`; probes run in parallel so a hung box
  costs one connect-timeout, not N.
- `fleet job` — the recorded switch jobs, merged with the target box's
  `aquarium-fleet-switch` unit state (`systemctl show` + `journalctl` tail).
- `fleet switch` — stdin `{box, layout, by}`; refuses unknown boxes, the
  layout the box already has, unreachable boxes and a running switch; pushes
  a small script over SSH and starts it as transient unit
  `aquarium-fleet-switch` (`systemd-run --collect`), then records the job in
  `/var/lib/aquarium/fleet-jobs.json` (root 0600, flock-guarded).

The switch script on the target box does exactly the manual runbook:

- → `git`: refuse unless `/opt/data/hermes-agent` is a symlink, remove it,
  fetch `install-aquarium.sh` from the box's branch, run
  `--from-branch <branch> --yes`.
- → `release`: `aquarium migrate-layout --yes` (seals the running checkout as
  `git-<sha>`, no rebuild), then set `INSTALL_SOURCE=release` in
  `aquarium.conf`.

**`deploy/sudoers.d/aquarium-fleet`** — whitelists exactly `probe`, `status`,
`job`, `switch` for the hermes user; added to `ROOT_COPIES` so upgrades carry
it. The dashboard cannot read the fleet key or reach a box any other way.

**`hermes_cli/fleet_api.py`** (`/api/fleet`, `dependencies=OWNER` everywhere):

- `GET /available` → `probe`; `GET ""` → status; `GET /job` → job.
- `POST /switch {box, layout, password}` — re-checks the owner's own password
  with the login provider (same pattern as software upgrade), then `fleet
  switch`. Helper text is scrubbed of absolute paths and `key=value`-shaped
  secrets before it leaves the server.

**agent-home:**

- `FleetView` (`settings/fleet/`): one card per box — label, layout chip,
  what runs, running upgrade job note, switch progress with journal tail —
  and a "Switch to direct deploy / software upgrade" button per box (disabled
  while unreachable, mid-upgrade or mid-switch) opening a password-confirm
  dialog. Polls `/api/fleet/job` while a switch runs.
- BFF routes `api/fleet{,/available,/job,/switch}` — `requireMemberOwner`.
- `sections.ts`: `"fleet"` section → `/settings/fleet`, in ADMIN_ENTRIES,
  gated by `isOwner && hasFleet`; the settings index probes
  `/api/fleet/available` (only for the owner).
- route-roles.json `"owner"` entries; i18n `fleet.json` + `entry.fleet*` in
  en and zh-Hant.

## Ops setup (one-time, on the managing box — not committed here)

```bash
ssh-keygen -t ed25519 -f /etc/aquarium/fleet_id_ed25519 -N ""   # root
# append the .pub to each managed box's /root/.ssh/authorized_keys
install -m 0600 /dev/null /etc/aquarium/fleet.json               # write the JSON above
install -m 0440 deploy/sudoers.d/aquarium-fleet /etc/sudoers.d/  # + visudo -cf
systemctl restart hermes-dashboard
```

The box inventory (names, labels, hosts, branches) lives in aquarium-ops.

## Manual runbook (fallback — what the switch automates)

release → git on a box:

```bash
sudo rm /opt/data/hermes-agent          # it is a symlink on the release layout
curl -fsSL -o /root/install-aquarium.sh \
  https://raw.githubusercontent.com/ai-Aquarium/aquarium/develop/install-aquarium.sh
bash /root/install-aquarium.sh --from-branch develop --yes
```

git → release:

```bash
sudo aquarium migrate-layout --yes      # seals the running checkout, no rebuild
sudo sed -i 's/^INSTALL_SOURCE=.*/INSTALL_SOURCE=release/' /etc/aquarium/aquarium.conf
# then one `sudo aquarium update` before the UI offers upgrades again
```

## Tests

- `tests/deploy/test_aquarium_fleet.py` — fake box + fake ssh/systemctl/
  journalctl: probe/status rows, unreachable marking, both switch scripts,
  the refusals (same layout, unknown box, bad layout, unreachable, busy),
  job/unit merge, self-box local unit.
- `tests/hermes_cli/test_fleet_api.py` — owner gating (admin/member/viewer
  403, helper never called), `available: false`, scrubbing, switch
  validation ordering, password re-check, real helper on an empty fake root.
- vitest: `FleetView.test.tsx` (cards, chips, disabled switch, progress),
  `sections.test.ts` (fleet gating), plus the route-roles and hint-ratchet
  suites.
