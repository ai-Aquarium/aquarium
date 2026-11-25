---
title: "fix(agent-home): graceful shutdown for agent-home restarts"
status: implemented
date: 2026-11-25
type: fix
target_repo: aquarium (agent-home deploy)
---

# Graceful shutdown for agent-home restarts

## Symptom

Every `systemctl restart agent-home` (deploy or `aquarium update`) took the
full 90 s `TimeoutStopSec` and ended in SIGKILL: journal showed
`State 'final-sigterm' timed out. Killing.` Any open page's fetches dropped
in that window — seen live as a bare Safari `TypeError("Load failed")` pill
in the chat (PR #1110 makes that message name the operation).

## Root cause

`next start` catches SIGTERM/SIGINT and calls `server.close()`
(`node_modules/next/dist/server/lib/start-server.js`). In **production** it
then *awaits* the close — the `closeAllConnections()` +
`closeUpgraded()` calls sit behind `if (isDev)`. `server.close()` stops new
connections but waits for existing ones, and a live chat's SSE stream
(plus keep-alive sockets held by Caddy) never finishes on its own.

## Fix

`agent-home` runs a small custom server instead of `next start`:

- `deploy/server.mjs` — `next({ dev: false })` + `app.getRequestHandler()`
  on an owned `http.Server` (HOST/PORT envs, same `localhost` binding;
  instrumentation still registers inside `app.prepare()`).
- `deploy/graceful-shutdown.mjs` — `installGracefulShutdown(server)`:
  tracks every socket (connection / secureConnection / upgrade), on
  SIGTERM/SIGINT stops accepting, closes idle keep-alives immediately
  (`closeIdleConnections`), gives in-flight requests a 10 s drain, then
  destroys what's left (streams, slow polls) and exits. A 15 s hard-exit
  covers `close()` never resolving. Duplicate signals count once.
- `deploy/start.sh` — `exec node deploy/server.mjs` (was
  `npm run start -- -H localhost -p $PORT`); probes `node` for the nvm
  fallback instead of `npm`.
- `agent-home.service` — `TimeoutStopSec=20s` backstop (above the 15 s
  hard deadline, below the 90 s default). **Needs `systemctl daemon-reload`
  + a fresh copy of the unit on the box** — the deploy script restarts but
  does not reinstall unit files.

## Verified

- `vitest deploy/` — 4 cases: clean exit + refuses new connections, a
  mid-request socket destroyed at the drain deadline then exit 0,
  hard-exit non-zero if `close()` never resolves, duplicate signals once.
- Live on the box (port 3199, hermes user): boots, `/login` → 200,
  `[instrumentation]` registers; a held unfinished request exits at
  **10.1 s** with `drain over, closing 1 socket(s)` → `clean` — vs the
  previous 90 s → SIGKILL.
- `tsc --noEmit` + eslint — clean.

## Not yet verified

- A real deploy/`aquarium update` end-to-end: watch
  `journalctl -u agent-home` — should show the `[graceful-shutdown]` lines
  and `Stopped` in ~10 s, not `final-sigterm timed out`.
- `TimeoutStopSec=20s` applied to the installed unit
  (`cp agent-home/deploy/agent-home.service /etc/systemd/system/ &&
  systemctl daemon-reload`).
