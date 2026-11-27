# New Aquarium instance: ProxyAdvisor on Hetzner CX43

Provisioned a second Hetzner CX43 (same spec as the `hermes` prod box) in a new
Hetzner Cloud project `ProxyAdvisor`, and installed Aquarium v0.2.18 via the
signed-release installer — the same release-install + `aquarium update`
software-upgrade path HSD uses, never a direct deploy.

## What was created

| | |
|---|---|
| Hetzner project | `ProxyAdvisor` (new; hcloud context `proxyadvisor` in `~/.config/hcloud/cli.toml`) |
| Server | `proxyadvisor` (ID `177859272`), type **CX43** — 8 vCPU / 16 GB / 160 GB NVMe, shared x86 |
| Location | `nbg1` (Nuremberg) |
| IPv4 / IPv6 | `46.224.198.234` / `2a01:4f8:1c19:d78e::/64` |
| OS | Ubuntu 24.04.4 LTS |
| Firewall | `proxyadvisor-fw` (ID 12178833): inbound TCP 22, 80, 443 only |
| SSH key | `aquarium-admin` (ID 133135974) ↔ local `~/.ssh/hetzner_aquarium_ed25519` (fresh pair, separate from the hermes prod key) |
| Aquarium | **v0.2.18**, signed release (cosign + SHA256SUMS verified by installer) |
| Org name | `ProxyAdvisor` |
| DNS | none yet — domain-less install; the org adds its own two A records later |

**Cost:** CX43 €18.49/mo (€0.0296/hr cap) + ~€0.60/mo IPv4 ≈ **€19.1/mo (~US$21)**.
Leo's `hermes` box bills at the grandfathered €15.99; CX43 is EU-only and the
cheapest 8 vCPU/16 GB option (CAX31 ARM €24.99, CPX41 €37.99).

## How it was installed

Same release path as HSD — no git checkout on the box, updates via
`sudo aquarium update` (never `deploy-hermes.sh` / direct deploy):

```bash
curl -fsSL -o /root/install-aquarium.sh \
  https://raw.githubusercontent.com/leolau/aquarium/develop/install-aquarium.sh
/root/install-aquarium.sh --channel stable --yes --org-name "ProxyAdvisor"
```

> **Gotcha hit (worth remembering):** the documented `curl … | bash -s` pipe
> truncated the script after the DB-roles stage — a command consumed the rest
> of the script on stdin and it exited 0 looking "done" but with no services
> installed. Fix: download the script to a file first, then run it (as above).
> Re-runs are safe/idempotent and reuse `/etc/aquarium/aquarium.conf`.

Also applied: `PasswordAuthentication no` via
`/etc/ssh/sshd_config.d/00-aquarium-no-password.conf` (installer's own
preflight warning; root login was already key-only).

## Access

- SSH: `ssh -i ~/.ssh/hetzner_aquarium_ed25519 root@46.224.198.234`
- App (SSH tunnel): `ssh -L 3100:127.0.0.1:3100 -L 9119:127.0.0.1:9119 root@46.224.198.234`
  → `http://localhost:3100` (agent-home); dashboard API via tunneled 9119
- Owner setup link (24 h, regenerable): printed at end of
  `/root/install-aquarium-rerun.log`; regenerate with the `hermes setup-link`
  command shown there
- Settings `/etc/aquarium/aquarium.conf`; secrets `/opt/data/aquarium-secrets.env`,
  `/etc/aquarium/*.env` (root only)

## Verification (all green at install time)

- `aquarium doctor`: services active, supabase healthy, DB ok, agent-home HTTP 200,
  dashboard 302, embed 200
- Expected warnings: no domain (certs pending), no model key (needs provider
  key → `/opt/data/hermes-home/.env` + restart `hermes-gateway hermes-dashboard`),
  no backups yet
- Ports: only 22 open publicly (ufw + Hetzner fw); 80/443 open on the fw ready
  for the future domain

## Remaining handover items

- [ ] Owner completes setup link (email + password) — 24 h validity
- [ ] Model provider API key(s) in `/opt/data/hermes-home/.env`, restart services
- [ ] Later: org's domain → two A records → re-run installer with
      `--home-domain`/`--dashboard-domain` (or first-run setup page "Web address");
      if Cloudflare free, records must be DNS-only (grey cloud)
- [ ] `sudo aquarium backup` once configured; copy backup + `/etc/aquarium/backup.key` off-box
- [ ] Decide if the box stays billed under this Hetzner account or moves to the org's own
