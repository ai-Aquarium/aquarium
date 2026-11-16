"""Route a batch, then triage it per ``triage.agent.<channel>`` (FG-03 P5).

The email and WhatsApp triage scripts hand every batch that needs a model
here (their newsletter / seminar-survey / media-only shortcuts never do).
One router call per attempt (:func:`shared.batch_routing.route`; a retried
batch reuses the stored decision), then:

* ``legacy``: today's DeepSeek triage, exactly as before P5.
* ``shadow``: legacy triage acts; then each picked user-profile's agent
  triages the same batch and its result is only stored next to the legacy
  one (``hermes source comparisons``). Shadow failures never touch legacy.
* ``agent``: each picked user-profile's agent triages the batch and its
  result is acted on in that profile, for the batch's owner. The box-wide
  SQLite channel rows (tasks, notes, escalations) are written once per
  batch, by the first profile that succeeds. No pick means stored only.
  Legacy triage runs instead when routing is off, the batch has no source,
  or there is no decision (registry down).

A profile whose turn fails is retried on the next pass; the batch file keeps
``_profiles_done`` so a retry runs only the failed ones. After
``MAX_AGENT_ATTEMPTS`` failed passes the batch falls back to legacy triage.

A channel with no legacy triage (Telegram, FG-03 P6) passes
``legacy_triage=None``: only ``agent`` acts. With no routing decision
(router off, registry down) the batch stays for the next pass; after
``MAX_AGENT_ATTEMPTS`` failed passes of either kind it is stored as processed
and the owner gets one in-app notification that it could not be triaged
(never a Telegram push).
"""

import copy
import json
import os
from typing import Any, Callable, Mapping, Optional

from shared import batch_routing

MAX_AGENT_ATTEMPTS = 3
DONE_KEY = "_profiles_done"
ATTEMPTS_KEY = "_agent_attempts"
BOX_KEY = "_box_writes_done"
_TRACKING = (DONE_KEY, ATTEMPTS_KEY, BOX_KEY)


def _agent_mode(kind: str, config: Mapping[str, Any], log) -> str:
    try:
        from hermes_cli import triage_agent
        return triage_agent.agent_mode(kind, config)
    except Exception as e:
        log(f"triage.agent.{kind} unreadable, using legacy: {e!r}")
        return "legacy"


def _write_json(path: str, batch: Mapping[str, Any]) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w") as f:
        json.dump(batch, f)
    os.replace(tmp, path)


def _finish(batch_path: str, processed_dir: str,
            batch: Optional[Mapping[str, Any]] = None) -> None:
    if batch is not None:
        _write_json(batch_path, batch)
    os.rename(batch_path, os.path.join(processed_dir, os.path.basename(batch_path)))


def _clean(batch: Mapping[str, Any]) -> dict:
    return {k: copy.deepcopy(v) for k, v in batch.items() if k not in _TRACKING}


def triage_routed(kind: str, batch: dict, batch_path: str, *,
                  legacy_triage: Optional[Callable[[dict], Optional[dict]]],
                  legacy_act: Optional[Callable[[dict, dict], None]],
                  get_db: Callable[[], Any],
                  processed_dir: str,
                  config: Optional[Mapping[str, Any]] = None,
                  log: Callable[[str], None] = print) -> None:
    """Route ``batch`` once, then triage and act on it; see the module doc."""
    if config is None:
        try:
            config = batch_routing._hermes_config()
        except Exception as e:
            log(f"routing failed, triaging as usual: {e!r}")
            config = None
    if config is None:
        outcome, mode = batch_routing.Outcome(True), "legacy"
    else:
        outcome = batch_routing.route(kind, batch, config=config, log=log)
        mode = _agent_mode(kind, config, log)

    if legacy_triage is None:
        if mode == "agent" and outcome.mode != "off" and outcome.decision is not None:
            _agent(kind, batch, batch_path, outcome.decision, legacy_triage=None,
                   legacy_act=None, get_db=get_db, processed_dir=processed_dir,
                   config=config, log=log)
        else:
            _not_routed(kind, batch, batch_path, processed_dir=processed_dir,
                        why="no routing decision" if mode == "agent" else
                        f"triage.agent.{kind} is not agent", log=log)
        return

    if mode == "agent" and outcome.mode != "off" and outcome.decision is not None:
        _agent(kind, batch, batch_path, outcome.decision, legacy_triage=legacy_triage,
               legacy_act=legacy_act, get_db=get_db, processed_dir=processed_dir,
               config=config, log=log)
        return
    if mode == "agent":
        log(f"agent triage needs a routing decision; legacy triage for batch "
            f"{batch.get('batch_id')}")

    if not outcome.triage:
        _finish(batch_path, processed_dir)
        return
    shadow_batch = _clean(batch) if mode == "shadow" else None
    result = legacy_triage(batch)
    if not result:
        log("Failed to triage batch, will retry later")
        return
    legacy_result = copy.deepcopy(result)
    legacy_act(batch, result)
    _finish(batch_path, processed_dir)
    if shadow_batch is not None:
        _shadow(kind, shadow_batch, legacy_result, outcome.decision, config=config, log=log)


def _owner(batch: Mapping[str, Any], decision: Any) -> str:
    return str(batch.get("owner_user_id") or getattr(decision, "owner_user_id", "") or "")


def _shadow(kind, batch, legacy_result, decision, *, config, log) -> None:
    if decision is None or not decision.selected:
        return
    try:
        from hermes_cli import triage_agent

        owner = _owner(batch, decision)
        runs = triage_agent.triage_selected(kind, batch, list(decision.selected),
                                            owner_user_id=owner, config=config)
        stored = triage_agent.record_comparisons_sync(
            source_id=str(batch.get("source_id") or decision.source_id),
            batch_id=str(batch.get("batch_id") or decision.batch_id),
            channel=kind, owner_user_id=owner,
            legacy_result=legacy_result, agents=runs)
        log(f"shadow agent triage batch {batch.get('batch_id')}: "
            + ", ".join(f"{r.profile}={'ok' if r.ok else r.error}" for r in runs)
            + ("" if stored else " (comparisons not stored)"))
    except Exception as e:
        log(f"shadow agent triage failed (legacy unaffected): {e!r}")


def _act_in_profile(kind, batch, run, *, owner, get_db, box_writes) -> None:
    from shared.triage_handlers import process_result

    target = copy.deepcopy(batch)
    target["_channel"] = kind
    db = get_db()
    try:
        process_result(run.result, target, db, profile_home=run.home,
                       owner_user_id=owner, box_writes=box_writes)
        db.commit()
    finally:
        db.close()


def _profile_home(profile: str):
    """The profile's Hermes home, resolved as ``triage_agent.run_profile_triage`` does."""
    from pathlib import Path

    from hermes_cli.profiles import get_profile_dir, profile_exists

    if not profile or not profile_exists(profile):
        return None
    return Path(get_profile_dir(profile))


UNTRIAGED_TITLE = "A {label} message couldn't be triaged"
_LABELS = {"telegram": "Telegram", "whatsapp": "WhatsApp", "email": "email"}


def _not_routed(kind, batch, batch_path, *, processed_dir, why, log) -> None:
    """No legacy to fall back to: keep the batch, give up after the cap."""
    attempts = int(batch.get(ATTEMPTS_KEY) or 0) + 1
    batch[ATTEMPTS_KEY] = attempts
    if attempts >= MAX_AGENT_ATTEMPTS:
        log(f"{why} for batch {batch.get('batch_id')} after {attempts} passes; stored only")
        _give_up(kind, batch, batch_path, profiles=[], owner=_owner(batch, None),
                 processed_dir=processed_dir, log=log)
        return
    _write_json(batch_path, batch)
    log(f"{why} for batch {batch.get('batch_id')}; will retry later")


def _give_up(kind, batch, batch_path, *, profiles, owner, processed_dir, log) -> None:
    """Store the batch as processed and tell its owner, once, in the app."""
    _finish(batch_path, processed_dir, batch)
    try:
        if not _notify_untriaged(kind, batch, profiles, owner, log):
            log(f"could not notify {owner or 'the owner'} that batch "
                f"{batch.get('batch_id')} was not triaged")
    except Exception as e:
        log(f"could not notify {owner} that batch {batch.get('batch_id')} "
            f"was not triaged: {e!r}")


def _notify_untriaged(kind, batch, profiles, owner, log) -> bool:
    """One in-app notification for ``owner``: in the first of ``profiles`` where
    they are an active person, else in this process's own profile."""
    if not owner:
        return False
    import asyncio
    from contextlib import nullcontext

    from agent.profile_runtime import profile_runtime_scope
    from hermes_cli.needs_you import TRIAGE_FAILED
    from shared import owner_routing
    from shared.inbound_registration import resolve_person

    label = _LABELS.get(kind, kind)
    who = batch.get("chat_title") or batch.get("sender_name") or batch.get("sender") or label
    title = UNTRIAGED_TITLE.format(label=label)
    text = (f"Messages from {who} could not be triaged after "
            f"{MAX_AGENT_ATTEMPTS} tries. They are stored; nothing was done with them.")
    key = f"{TRIAGE_FAILED}:{kind}:{batch.get('batch_id')}"
    scopes = []
    for profile in profiles:
        try:
            home = _profile_home(profile)
        except Exception as e:
            log(f"cannot resolve profile {profile}: {e!r}")
            home = None
        if home is not None:
            scopes.append(home)
    for home in scopes + [None]:
        with profile_runtime_scope(home) if home is not None else nullcontext():
            person = asyncio.run(resolve_person(owner))
            if person is not None and owner_routing.notify_in_app(
                    person, title=title, text=text, dedupe_key=key):
                log(f"told {owner} that batch {batch.get('batch_id')} was not triaged")
                return True
    return False


def _legacy_fallback(kind, batch, batch_path, *, missing, owner, legacy_triage, legacy_act,
                     get_db, processed_dir, box_done, log) -> None:
    """Legacy triage for the profiles whose agent never succeeded, acted on in
    each of them as the batch owner; ``legacy_act`` only when no profile
    succeeded and none of them resolves. No legacy: stored, owner told."""
    if legacy_triage is None:
        _give_up(kind, batch, batch_path, profiles=missing, owner=owner,
                 processed_dir=processed_dir, log=log)
        return
    clean = _clean(batch)
    result = legacy_triage(clean)
    if not result:
        log("Failed to triage batch, will retry later")
        return
    homes = []
    for profile in missing if owner else []:
        try:
            home = _profile_home(profile)
        except Exception as e:
            log(f"cannot resolve profile {profile}: {e!r}")
            home = None
        if home is None:
            log(f"profile {profile} not found; legacy result not applied there")
            continue
        homes.append((profile, home))
    if not homes:
        if not box_done:
            legacy_act(clean, result)
        _finish(batch_path, processed_dir, batch)
        return
    from shared.triage_handlers import process_result

    for profile, home in homes:
        target = copy.deepcopy(clean)
        target["_channel"] = kind
        db = get_db()
        try:
            process_result(result, target, db, profile_home=home, owner_user_id=owner,
                           box_writes=not box_done)
            db.commit()
        except Exception as e:
            log(f"acting on the legacy triage in {profile} failed: {e!r}")
            continue
        finally:
            db.close()
        box_done = True
        log(f"legacy triage applied in {profile} for {owner}")
    _finish(batch_path, processed_dir, batch)


def _agent(kind, batch, batch_path, decision, *, legacy_triage, legacy_act, get_db,
           processed_dir, config, log) -> None:
    batch_id = batch.get("batch_id")
    selected = list(decision.selected)
    if not selected:
        log(f"no user-profile picked batch {batch_id}; stored only")
        _finish(batch_path, processed_dir)
        return
    done = [p for p in batch.get(DONE_KEY) or [] if isinstance(p, str)]
    box_done = bool(batch.get(BOX_KEY))
    attempts = int(batch.get(ATTEMPTS_KEY) or 0)
    if attempts >= MAX_AGENT_ATTEMPTS:
        log(f"agent triage of batch {batch_id} failed {attempts} times; "
            + ("legacy triage" if legacy_triage else "stored only"))
        _legacy_fallback(kind, batch, batch_path,
                         missing=[p for p in selected if p not in done],
                         owner=_owner(batch, decision), legacy_triage=legacy_triage,
                         legacy_act=legacy_act, get_db=get_db, processed_dir=processed_dir,
                         box_done=box_done, log=log)
        return

    owner = _owner(batch, decision)
    clean = _clean(batch)
    todo = [p for p in selected if p not in done]
    try:
        from hermes_cli import triage_agent
        runs = triage_agent.triage_selected(kind, clean, todo, owner_user_id=owner,
                                            config=config)
    except Exception as e:
        log(f"agent triage of batch {batch_id} failed: {e!r}")
        runs = []
    for run in runs:
        if run.profile not in todo or run.profile in done:
            continue
        if not run.ok:
            log(f"agent triage {run.profile} failed for batch {batch_id}: {run.error}")
            continue
        try:
            _act_in_profile(kind, clean, run, owner=owner, get_db=get_db,
                            box_writes=not box_done)
        except Exception as e:
            log(f"acting on {run.profile}'s triage of batch {batch_id} failed: {e!r}")
            continue
        box_done = True
        done.append(run.profile)
        result = run.result or {}
        log(f"agent triage {run.profile} batch {batch_id}: class={result.get('classification')}, "
            f"escalate={result.get('escalate')}")

    batch[DONE_KEY], batch[BOX_KEY] = done, box_done
    missing = [p for p in selected if p not in done]
    if not missing:
        _finish(batch_path, processed_dir, batch)
        return
    batch[ATTEMPTS_KEY] = attempts + 1
    _write_json(batch_path, batch)
    if batch[ATTEMPTS_KEY] >= MAX_AGENT_ATTEMPTS:
        log(f"agent triage of batch {batch_id} failed {batch[ATTEMPTS_KEY]} times "
            f"({', '.join(missing)}); "
            + ("legacy triage" if legacy_triage else "stored only"))
        _legacy_fallback(kind, batch, batch_path, missing=missing, owner=owner,
                         legacy_triage=legacy_triage,
                         legacy_act=legacy_act, get_db=get_db, processed_dir=processed_dir,
                         box_done=box_done, log=log)
        return
    log(f"agent triage pending for {', '.join(missing)} on batch {batch_id}; will retry later")
