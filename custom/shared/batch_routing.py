"""The routing step the legacy triage scripts run before triage (FG-03 P4).

Once per batch from a registry source, :func:`should_triage` asks
:func:`hermes_cli.triage_router.route_batch_sync` which of the source owner's
user-profiles the batch is for (``triage.router.mode`` in config.yaml):

* ``off``, or a batch with no ``source_id``: no call; triage as today.
* ``shadow`` (default): the decision is logged and stored; triage as today.
* ``enforce``: a decision that picks no user-profile means the batch is only
  stored. Anything else (picked profiles, or no decision because the registry
  is down) runs today's triage; per-profile triage is P5.

Routing never blocks or drops a batch: any failure means "triage as today".
"""

from typing import Any, Callable, Mapping, Optional


def _hermes_config() -> Mapping[str, Any]:
    from hermes_cli.config import load_config
    return load_config() or {}


def should_triage(kind: str, batch: Mapping[str, Any], *,
                  config: Optional[Mapping[str, Any]] = None,
                  log: Callable[[str], None] = print) -> bool:
    """False only when ``enforce`` mode's decision picked no user-profile."""
    source_id = batch.get("source_id")
    if not source_id:
        return True
    try:
        from hermes_cli import triage_router
        from hermes_cli.triage_batch_text import batch_text

        if config is None:
            config = _hermes_config()
        mode = triage_router.router_settings(config).get("mode")
        if mode not in ("shadow", "enforce"):
            return True
        decision = triage_router.route_batch_sync(
            source_id=source_id,
            batch_id=str(batch.get("batch_id") or ""),
            batch_text=batch_text(kind, batch),
            config=config,
        )
    except Exception as e:
        log(f"routing failed, triaging as usual: {e!r}")
        return True
    if decision is None:
        log(f"no routing decision for batch {batch.get('batch_id')} "
            f"(source {source_id}); triaging as usual")
        return True
    picked = list(decision.selected)
    reasons = "; ".join(f"{c.profile}: {c.reason}" for c in decision.choices if c.reason)
    log(f"router ({mode}) batch {batch.get('batch_id')} source {source_id}: "
        f"selected={picked or 'none'}"
        + (" fallback" if decision.fallback else "")
        + (f" ({reasons})" if reasons else ""))
    if mode == "enforce" and not picked:
        log(f"no user-profile picked batch {batch.get('batch_id')}; stored only")
        return False
    return True
