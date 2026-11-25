---
title: "app-mcp: closing the UI-semantics gap"
status: proposed
date: 2026-11-25
type: design
target_repo: aquarium (agent-home + app-mcp)
---

# app-mcp: closing the UI-semantics gap

## Ask

In the 2026-11-25 incident (see
`plans/2026-11-25-context-length-learning-and-compression-loop.md`), the
user asked "What does the Snooze button do?" while on `/` with
`last active: button "Snooze"`. The agent had all the `mcp_app_*` tools
registered but fell back to **grepping the repo checkout 12 times** —
slow but correct — because no app-mcp tool encodes element *semantics*.

## Problem (verified against `origin/develop` @ 88961c2a6)

app-mcp gives **location, structure, control** — not meaning:

| Tool (`app-mcp/app_mcp/server.py`) | Answers |
|---|---|
| `app_state` (L287) | which page, last-touched element |
| `app_pages` (L295) | the route map (`pages.py::PAGES` L10–41) |
| `app_describe_page` (L324) | live DOM snapshot: id, role, accessible name, value, selector |
| `app_act` / `app_act_destructive` (L347/L365) | operate a control |
| `app_page_help` (L310) | hand-authored per-page guide (`help.py`) |

`app_describe_page` can report `button "Snooze"` — from
`snapshotElements` (`agent-home/src/lib/app-mcp/snapshot.ts` L201) via
`accessibleName` (L134) — but nothing says *what Snooze does* or *which
Snooze it is* when several exist.

The semantics layer that exists is `app-mcp/app_mcp/help.py`: a
hand-maintained `HELP` dict (L91) with `help_for` nearest-ancestor
fallback (L169–181). The `/` entry (L92–95) is a one-liner that says
nothing about suggested-task cards — exactly the drift class that caused
the incident. Element-level meaning lives nowhere.

**Anti-drift principle:** a Python manual cannot keep pace with a DOM it
never sees. Element semantics must live *on the elements* (or be derived
from the DOM), where the code author is already working.

## Design — three layers, ordered by maintenance cost

### Layer 1 — free context in the snapshot (zero maintenance)

Extend `AppMcpElement` (`snapshot.ts` L13–26) and `snapshotElements`
(L201) with a **`section`** field: the nearest *labelled ancestor* of
each interactive element — closest `[aria-label]`, `[data-component]`,
or heading (`h1`–`h4`) ancestor, string capped (~80 chars). The
conventions already exist: `data-component="SuggestedTaskCard"`
(`SuggestedTaskCard.tsx` L48), `data-component` shell chrome
(`LeadChatHost`/`CoralHost`, snapshot.ts L49–50), `data-action`
attributes on card buttons (`suggested-work` L97, `suggested-snooze`
L104, `suggested-dismiss` L137).

Effect: `button "Snooze"` reports as
`button "Snooze" · card "SuggestedTaskCard: Reply to Ada"` — instant
disambiguation between the card action and any other Snooze on the page,
with **no authored content to maintain**.

Also surface a **`hint`** field read from a `data-appmcp-hint`
attribute, falling back to `title`/`aria-description` when present
(fits the existing `data-appmcp-id`/`data-appmcp-deny` naming, L89–93).
Fields flow through the existing snapshot → `app_describe_page` response
(`server.py` L335–342) unchanged in shape; `elementRef` (L192) / the
`[app context: …]` line (`state.ts` L47–55) can add `section` to
`last active` the same way.

### Layer 2 — authored hints, drift-proof for new code

Convention: `data-appmcp-hint="one-line semantics"` on interactive
elements that aren't self-describing. PR authors write it next to the
component — same diff, same review — so it drifts only if the button
itself changes meaning (which is when it *should* be rewritten).

**Ratchet vitest:** scan key components' interactive elements —
new/changed elements without a `data-appmcp-hint` *or* an adequate
accessible name fail CI, with an allowlist so existing gaps ratchet
closed instead of breaking the build on day one. First consumers: the
suggested-task card buttons in `SuggestedTaskCard.tsx` —
`Work` / `Snooze for…` / `Dismiss` — the exact elements the incident
was about.

### Layer 3 — drift sweeper (bounded gap, ~24h)

For surfaces that predate the convention: the app-mcp service keeps a
**coverage ledger** — `(page, role, name) → hinted?` — of elements
observed via snapshots (append-only JSON under `$HERMES_HOME`). A
nightly cron agent — precedent: `deploy/hermes-review-pass.timer` —
diffs observed elements against `data-appmcp-hint` + `help.py`
coverage, drafts the missing hint lines / `HELP` entries, and opens a
small PR or files a to-do/Needs-You card (`needs_you.push_new`,
`hermes_cli/needs_you.py` L1162). Gap lifetime for pre-existing
surfaces: one sweep cycle.

### Boundary rule

`help.py` stays for **page-level** guides — how a screen is used end to
end, who can do what (the `PROJECTS_GUIDE` pattern, L12–89). The
immediate fix: extend the `/` entry (L92–95) with landing-page
suggested-tasks coverage — that's the guide the incident needed.
Element-level semantics live in `data-appmcp-hint`/DOM-derived
`section`, **not** in the Python manual — that's the anti-drift
boundary that keeps `help.py` from becoming the greppable-again layer.

## Self-test

- **Ratchet vitest** (Layer 2) — CI enforces the hint convention going
  forward.
- **pytest**: every route in `app_mcp/pages.py::PAGES` has a `help_for`
  entry (catches a new page shipping without a guide — the page-map
  already surfaces `has_help` in `app_pages`, `server.py` L303).
- **Snapshot unit tests** (jsdom, alongside the existing `snapshot.ts`
  tests): `section` resolves to nearest `aria-label`/`data-component`/
  heading ancestor; `hint` prefers `data-appmcp-hint` over
  `title`/`aria-description`; cap length honoured.

## Non-goals

- **No LLM-in-the-loop DOM summarization per snapshot** — too slow and
  too expensive to inject on every `app_describe_page`; semantics must
  be static strings or DOM-derived.
- **No server-side element registry** beyond the existing `PAGES` map —
  a second hand-maintained element list is the same drift class as
  `help.py` at finer grain.
- No change to `data-appmcp-deny`/guard semantics; `hint`/`section` are
  read-only annotations.

## Implementation plan (handoff)

Phases land in order A→D; Phase A is independently useful and is the
dependency for B's ratchet and C's ledger. Suggested as one PR per phase
(A+B may combine). Line refs verified against `origin/develop` @
`88961c2a6`; re-locate symbols if they drifted.

### Phase A — `section` + `hint` in the snapshot (zero-maintenance)

1. `agent-home/src/lib/app-mcp/snapshot.ts` — extend `AppMcpElement`
   (L13–26) with `section?: string` and `hint?: string`. In
   `snapshotElements` (L201): `section` = nearest labelled ancestor —
   closest `[aria-label]`, `[data-component]`, or `h1`–`h4` — capped at
   ~80 chars; `hint` = `data-appmcp-hint`, falling back to `title` /
   `aria-description`. Naming follows `data-appmcp-id` /
   `data-appmcp-deny` (L89–93).
2. `agent-home/src/lib/app-mcp/state.ts` (L47–55) — include `section`
   in the `[app context: …]` `last active` string when present.
3. `app-mcp/app_mcp/server.py` (L335–342) — confirm
   `app_describe_page` passes the new fields through; the snapshot
   payload should serialize as-is, but if the response shape filters
   keys, add them there.
4. jsdom unit tests alongside the existing `snapshot.ts` tests:
   nearest-ancestor resolution order (`aria-label` > `data-component` >
   heading), hint fallback chain, ~80-char cap.

### Phase B — authored hints + ratchet + `/` guide

5. First consumers — `SuggestedTaskCard.tsx`: `data-appmcp-hint` on
   `suggested-work` (L97), `suggested-snooze` (L104 — mention the
   1 min / 1 day / 1 week menu added by #1095), `suggested-dismiss`
   (L137); plus the `NeedsYouDetails.tsx` snooze button.
6. Ratchet vitest — crawl interactive elements of key components;
   new/changed elements without `data-appmcp-hint` or an adequate
   accessible name fail CI. Seed existing gaps into an allowlist so the
   build ratchets closed instead of breaking on day one.
7. `app-mcp/app_mcp/help.py` `/` entry (L92–95) — extend with
   landing-page suggested-tasks coverage (cards, Work / Snooze /
   Dismiss, snooze duration menu). Boundary rule holds: `help.py`
   stays page-level; element semantics live on the elements.

### Phase C — drift sweeper (bounded gap ~24h)

8. app-mcp coverage ledger — append-only JSON under `$HERMES_HOME`:
   `(page, role, name) → hinted?`, updated on each snapshot
   observation.
9. Nightly cron agent (precedent `deploy/hermes-review-pass.timer`) —
   diffs ledger vs `data-appmcp-hint` + `help.py` coverage, drafts the
   missing hint lines / `HELP` entries as a small PR or files a
   to-do / Needs-You card (`needs_you.push_new`,
   `hermes_cli/needs_you.py` L1162).

### Phase D — pytest guard

10. Every route in `app_mcp/pages.py::PAGES` (L10–41) has a `help_for`
    entry — catches a new page shipping guide-less; `app_pages`
    already surfaces `has_help` (`server.py` L303).

### Acceptance criteria

- `app_describe_page` on `/` returns `button "Snooze" · section
  "SuggestedTaskCard: <task title>"`; post-Phase-B it also carries a
  `hint` describing the duration menu — the incident question is
  answerable in ≤2 tool calls (describe or help), zero repo greps.
- The ratchet test fails on a new unhinted button and passes on
  allowlisted existing gaps.
- Ledger rows appear after any snapshot; the sweep produces a draft PR
  or a Needs-You card within one cycle.
