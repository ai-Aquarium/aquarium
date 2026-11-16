#!/usr/bin/env python3
"""
Triage Handler Registry

A dispatch table that maps JSON response field names to handler functions.
Each triage agent (WhatsApp, email, calendar) calls process_result() with the
LLM's JSON response, and the dispatcher routes each field to its registered
handler.

Handlers are channel-aware: the batch dict carries a `_channel` key
('whatsapp', 'email', 'calendar', 'telegram') that determines which SQLite
table and columns to use. Telegram (FG-03 P6) has no box-wide channel tables:
its results act only in the chosen user-profiles.

Adding a new output type (e.g., 'deadlines') requires:
1. Adding the field to response-schema.md (no deploy — LLM starts returning it)
2. Adding a @register('deadlines') handler here (deploy required)
Step 1 alone is safe: the dispatcher logs "no handler for deadlines — ignoring."
"""

import json
import os
import uuid
from datetime import datetime, timezone


_HANDLERS = {}
#: Fields whose handler writes only the box-wide channel SQLite (one copy per
#: machine). Under profile-scoped triage they run once per batch, for the call
#: made with ``box_writes=True``.
_BOX_FIELDS = set()
#: Where a profile-scoped call keeps its scope on the (copied) batch.
_SCOPE = '_profile_scope'


def register(key, *, box=False):
    """Decorator to register a handler for a JSON response field.

    ``box``: the handler writes only the box-wide channel SQLite.
    """
    def deco(fn):
        _HANDLERS[key] = fn
        if box:
            _BOX_FIELDS.add(key)
        return fn
    return deco


def _scope_owner(batch):
    """The owner a profile-scoped call acts for, or ``None`` (legacy)."""
    scope = batch.get(_SCOPE)
    return scope['owner_user_id'] if scope else None


def _arrival_key(arrival):
    if not arrival:
        return None
    try:
        from hermes_cli.needs_you import arrival_key
    except ImportError:
        return None
    return arrival_key(*arrival)


# ---------------------------------------------------------------------------
# Shared handler — memory_facts (all channels)
# ---------------------------------------------------------------------------

@register('memory_facts')
def _handle_memory_facts(facts, batch, db):
    """Push facts to Hermes long-term memory via memory_bridge."""
    if not facts or not isinstance(facts, list):
        return
    try:
        from shared.memory_bridge import remember_facts
        channel = batch.get('_channel', 'unknown')
        sender = (batch.get('sender_phone') or batch.get('sender')
                  or batch.get('organizer_email', ''))
        owner = _scope_owner(batch)
        memory_dir = None
        if owner:
            # Runs inside the profile scope: the owner's own inbox there.
            from tools.memory_tool import get_memory_dir
            memory_dir = get_memory_dir(owner)
        remembered = remember_facts(facts, source=channel, sender=sender,
                                    memory_dir=memory_dir)
        if remembered:
            print(f"[triage] Remembered {remembered} fact(s) to long-term memory")
    except ImportError:
        pass  # memory_bridge not available
    except Exception as e:
        print(f"[triage] Memory bridge error: {e}")


# ---------------------------------------------------------------------------
# WhatsApp handlers
# ---------------------------------------------------------------------------

@register('tasks', box=True)
def _handle_tasks(tasks, batch, db):
    """Write tasks to the appropriate SQLite table based on channel."""
    if not tasks:
        return
    channel = batch.get('_channel', 'whatsapp')
    now = datetime.now(timezone.utc).isoformat()

    if channel == 'whatsapp':
        source_phone = batch.get('source_phone', '')
        msg_id = batch['messages'][0]['msg_id'] if batch.get('messages') else ''
        for task in tasks:
            try:
                db.execute(
                    """INSERT INTO wa_tasks (id, source_phone, source_msg_id, description, due_date, status, priority, created_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                    (str(uuid.uuid4()), source_phone, msg_id,
                     task.get('description', ''), task.get('due_date'),
                     task.get('priority', 'medium'), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting task: {e}")

    elif channel == 'email':
        account_id = batch.get('account_id', '')
        first_email_id = batch['emails'][0]['id'] if batch.get('emails') else None
        for task in tasks:
            try:
                db.execute(
                    """INSERT INTO email_tasks (id, account_id, source_email_id, description, due_date, status, priority, created_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                    (str(uuid.uuid4()), account_id, first_email_id,
                     task.get('description', ''), task.get('due_date'),
                     task.get('priority', 'medium'), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting task: {e}")


@register('todos')
def _handle_todos(todos, batch, db):
    """Stage what this batch implies the user may want to do about it.

    Distinct from `tasks` above, and deliberately so: `tasks` is the pipeline's
    own extraction, it stays in SQLite, and it fires for almost every batch.
    A to-do is a judgement — this is worth the user's attention — and it lands
    in the shared store behind the /todos page. Most arrive `staged` and say
    nothing; only `notify` promotes one to `open`, where step 3 announces it.

    Best-effort by construction. The SQLite writes above already happened, so
    a registry outage costs a nudge, never the pipeline's record.
    """
    if not todos or not isinstance(todos, list):
        return
    try:
        from shared.todo_registration import register_todo, select_candidates
    except ImportError:
        return

    channel = batch.get('_channel', 'whatsapp')
    arrivals = _triaged_arrivals(batch)
    surface, account_id, external_id = (
        arrivals[0] if arrivals else (channel, '', '')
    )
    summary = batch.get('summary', '')
    owner = _scope_owner(batch)
    scoped = {'owner_user_id': owner,
              'arrival_key': _arrival_key(arrivals[0] if arrivals else None)} if owner else {}

    for candidate in select_candidates(
        [t for t in todos if isinstance(t, dict)]
    ):
        title = (candidate.get('title') or candidate.get('description')
                 or '').strip()
        if not title:
            continue
        detail = candidate.get('detail') or candidate.get('reason') or summary
        recorded = register_todo(
            title=title,
            description=detail or '',
            priority=candidate.get('priority', 'medium'),
            due_date=candidate.get('due_date'),
            notify=bool(candidate.get('notify')),
            surface=surface,
            account_id=account_id,
            external_id=external_id,
            actor=f'skill:{channel}-triage',
            **scoped,
        )
        if recorded and arrivals:
            # Read by stamp_inbox_importance: a to-do linked to an arrival is
            # one of the reasons it shows in the landing Incomings tab.
            batch.setdefault('_todo_arrivals', []).append(
                (surface, account_id, external_id,
                 candidate.get('priority', 'medium'))
            )
        if recorded and recorded.get('created'):
            print(f"[triage] Staged to-do ({recorded['stage']}): {title}")



@register('work_request')
def _handle_work_request(request, batch, db):
    """Turn a skill's "this needs real work" verdict into a to-do — and start it.

    Distinct from `todos`: a `todos` entry asks the *user* to do something; a
    `work_request` asks the *agent* to produce something — a quotation, a
    drafted reply, research. The to-do carries the skill's `instructions` and
    `deliverable` in its description so the work session can act without the
    prompt that produced them.

    `auto_start` is a two-key door: the skill asks AND the channel's
    `config.json` allows (`triage.auto_work`). Either side saying no leaves a
    normal open to-do waiting for "Work on this". At most one request per
    batch may auto-start — the second-most-important thing can still wait for
    a human to see it.
    """
    if not request:
        return
    candidates = request if isinstance(request, list) else [request]
    candidates = [c for c in candidates if isinstance(c, dict)]
    if not candidates:
        return
    try:
        from shared.todo_registration import (
            MAX_TODOS_PER_BATCH, register_todo, select_candidates,
        )
    except ImportError:
        return

    channel = batch.get('_channel', 'whatsapp')
    arrivals = _triaged_arrivals(batch)
    surface, account_id, external_id = (
        arrivals[0] if arrivals else (channel, '', '')
    )
    auto_work = _auto_work_enabled(channel)
    auto_started = False
    owner = _scope_owner(batch)
    scoped = {'owner_user_id': owner,
              'arrival_key': _arrival_key(arrivals[0] if arrivals else None)} if owner else {}

    ranked = select_candidates(
        [{**c, "notify": True} for c in candidates],
        limit=MAX_TODOS_PER_BATCH,
    )
    for candidate in ranked:
        title = (candidate.get('title') or '').strip()
        if not title:
            continue
        parts = [str(candidate.get('instructions') or '').strip()]
        deliverable = str(candidate.get('deliverable') or '').strip()
        if deliverable:
            parts.append(f"Deliverable: {deliverable}")
        recorded = register_todo(
            title=title,
            description="\n\n".join(p for p in parts if p),
            priority=candidate.get('priority', 'high'),
            due_date=candidate.get('due_date'),
            notify=True,
            surface=surface,
            account_id=account_id,
            external_id=external_id,
            actor=f'skill:{channel}-triage',
            origin='triage',
            **scoped,
        )
        if not recorded:
            continue
        print(f"[triage] Work request to-do ({recorded['stage']}): {title}")
        if (
            candidate.get('auto_start')
            and auto_work
            and recorded.get('created')
            and not auto_started
        ):
            if _auto_start(recorded['id'], channel, scope=batch.get(_SCOPE)):
                auto_started = True
                print(f"[triage] Auto-started work session for: {title}")
            else:
                print(f"[triage] Auto-start failed for: {title} — to-do left open")


def _auto_work_enabled(channel):
    """The channel's `triage.auto_work` flag, read fresh each batch.

    Same hot-reload posture as the skill files: flipping the config takes
    effect on the next batch with no restart.
    """
    paths = {
        'whatsapp': os.environ.get(
            'WHATSAPP_CONFIG_PATH', '/opt/data/whatsapp-messages/config.json'
        ),
        'email': os.environ.get(
            'EMAIL_CONFIG_PATH', '/opt/data/email-messages/config.json'
        ),
        'calendar': os.environ.get(
            'CALENDAR_CONFIG_PATH', '/opt/data/calendar/config.json'
        ),
    }
    path = paths.get(channel)
    if not path:
        return False
    try:
        with open(path) as f:
            cfg = json.load(f)
        return bool((cfg.get('triage') or {}).get('auto_work'))
    except Exception:
        return False


def _auto_start(todo_id, channel, scope=None):
    """Move a fresh work to-do to ``working`` and launch its session.

    Mirrors what ``POST /todos/{id}/start {session:true}`` does from the page,
    with the skill as the actor. Sync callers wrap the async store calls in
    ``asyncio.run`` — the same shape ``register_todo`` uses. Returns False on
    any failure so a broken launcher never costs the to-do itself.

    ``scope`` (profile-scoped triage): the to-do is the scope owner's in the
    scope's profile, and the work session runs in that profile's home.
    """
    try:
        from shared.todo_registration import resolve_owner
        from shared.inbound_registration import resolve_person
        from hermes_cli.todo_store import default_store
        from hermes_cli.todo_work import launch_todo_work
    except ImportError as exc:
        print(f"[triage] auto-start unavailable: {exc}")
        return False

    import asyncio

    async def _do():
        if scope:
            principal = await resolve_person(scope['owner_user_id'])
        else:
            principal = await resolve_owner()
        if principal is None:
            return False
        store = default_store("prod")
        todo = await store.get(principal, todo_id)
        if todo is None or not todo.is_live or todo.stage == 'working':
            return False
        actor = f'skill:{channel}-triage'
        await store.set_stage(principal, todo_id, 'working', actor=actor)
        if scope:
            launch_todo_work(store, principal, todo, actor=actor,
                             profile_home=scope['home'])
        else:
            launch_todo_work(store, principal, todo, actor=actor)
        return True

    try:
        return asyncio.run(_do())
    except Exception as exc:
        print(f"[triage] auto-start error for {todo_id}: {exc}")
        return False

@register('notes', box=True)
def _handle_notes(notes, batch, db):
    """Write notes to the appropriate SQLite table based on channel."""
    if not notes:
        return
    channel = batch.get('_channel', 'whatsapp')
    now = datetime.now(timezone.utc).isoformat()

    if channel == 'whatsapp':
        source_phone = batch.get('source_phone', '')
        msg_id = batch['messages'][0]['msg_id'] if batch.get('messages') else ''
        for note in notes:
            try:
                db.execute(
                    """INSERT INTO wa_notes (id, source_phone, source_msg_id, content, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), source_phone, msg_id,
                     note.get('content', ''), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting note: {e}")

    elif channel == 'email':
        account_id = batch.get('account_id', '')
        first_email_id = batch['emails'][0]['id'] if batch.get('emails') else None
        for note in notes:
            try:
                db.execute(
                    """INSERT INTO email_notes (id, account_id, source_email_id, content, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (str(uuid.uuid4()), account_id, first_email_id,
                     note.get('content', ''), now)
                )
            except Exception as e:
                print(f"[triage] Error inserting note: {e}")


@register('escalate', box=True)
def _handle_escalate(should_escalate, batch, db):
    """Create an escalation record if flagged."""
    if not should_escalate:
        return
    channel = batch.get('_channel', 'whatsapp')
    now = datetime.now(timezone.utc).isoformat()

    if channel == 'whatsapp':
        source_phone = batch.get('source_phone', '')
        msg_id = batch['messages'][0]['msg_id'] if batch.get('messages') else ''
        sender_phone = batch.get('sender_phone', '')
        try:
            db.execute(
                """INSERT INTO escalations (id, source_phone, source_msg_id, sender_phone, reason, summary, priority, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)""",
                (str(uuid.uuid4()), source_phone, msg_id, sender_phone,
                 batch.get('escalation_reason', 'unknown'),
                 batch.get('summary', ''),
                 batch.get('escalation_priority', 'medium'), now)
            )
        except Exception as e:
            print(f"[triage] Error inserting escalation: {e}")

    elif channel == 'email':
        account_id = batch.get('account_id', '')
        first_email_id = batch['emails'][0]['id'] if batch.get('emails') else None
        sender_email = batch.get('sender', '')
        sender_name = batch.get('sender_name', '')

        # Look up contact_id
        contact_id = None
        try:
            handle = db.execute(
                "SELECT contact_id FROM contact_handles WHERE handle_type = 'email' AND handle_value = ?",
                (sender_email,)
            ).fetchone()
            if handle:
                contact_id = handle['contact_id']
        except Exception:
            pass

        try:
            db.execute(
                """INSERT INTO escalations (id, source_phone, source_msg_id, sender_phone,
                   reason, summary, priority, status, created_at,
                   channel, sender_email, sender_name, contact_id)
                   VALUES (?, ?, ?, NULL, ?, ?, ?, 'pending', ?, 'email', ?, ?, ?)""",
                (str(uuid.uuid4()), account_id, first_email_id,
                 batch.get('escalation_reason', 'unknown'),
                 batch.get('summary', ''),
                 batch.get('escalation_priority', 'medium'), now,
                 sender_email, sender_name, contact_id)
            )
        except Exception as e:
            print(f"[triage] Error inserting escalation: {e}")


# ---------------------------------------------------------------------------
# Calendar handlers
# ---------------------------------------------------------------------------

@register('importance', box=True)
def _handle_importance(importance, batch, db):
    """Update the calendar event's importance and triage status."""
    event_id = batch.get('event_id', '')
    if not event_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "UPDATE calendar_events SET importance = ?, triaged = 1, updated_at = ? WHERE id = ?",
            (importance, now, event_id)
        )
    except Exception as e:
        print(f"[calendar-triage] Error updating importance: {e}")


@register('importance_reason', box=True)
def _handle_importance_reason(reason, batch, db):
    """Store the importance classification reason."""
    event_id = batch.get('event_id', '')
    if not event_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "UPDATE calendar_events SET importance_reason = ?, updated_at = ? WHERE id = ?",
            (reason, now, event_id)
        )
    except Exception as e:
        print(f"[calendar-triage] Error updating importance_reason: {e}")


@register('prep_notes', box=True)
def _handle_prep_notes(prep_notes, batch, db):
    """Store preparation notes for the event."""
    event_id = batch.get('event_id', '')
    if not event_id:
        return
    now = datetime.now(timezone.utc).isoformat()
    try:
        db.execute(
            "UPDATE calendar_events SET prep_notes = ?, updated_at = ? WHERE id = ?",
            (prep_notes, now, event_id)
        )
    except Exception as e:
        print(f"[calendar-triage] Error updating prep_notes: {e}")


# ---------------------------------------------------------------------------
# Inbox projection
# ---------------------------------------------------------------------------

def _triage_importance(result):
    """The one verdict the Inbox shows, out of three channels' vocabularies.

    An escalation outranks anything else: the escalation pusher already
    decided a human must look, and the Inbox filter should agree with the
    Telegram alert rather than describe the same message as 'informational'.
    """
    if result.get('escalate'):
        return result.get('escalation_priority') or 'urgent'
    return result.get('importance') or result.get('classification') or ''


def _triaged_arrivals(batch):
    """`(surface, account_id, external_id)` for everything this verdict covers.

    The ids are the channel's own — the same ones the pollers registered with
    — because triage runs in a separate process that never saw the registry's
    row ids.
    """
    channel = batch.get('_channel', 'whatsapp')
    if channel == 'whatsapp':
        account = batch.get('source_phone', '')
        return [
            ('whatsapp', account, m['msg_id'])
            for m in batch.get('messages', [])
            if m.get('msg_id')
        ]
    if channel == 'email':
        account = batch.get('account_id', '')
        return [
            ('email', account, em['message_id'])
            for em in batch.get('emails', [])
            if em.get('message_id')
        ]
    if channel == 'telegram':
        # The receiving bot and chat: todo_outbound.target_from_arrival() turns
        # them into the reply route (that bot, that chat).
        account = batch.get('account_id', '')
        chat = str(batch.get('chat_id') or '')
        return [
            ('telegram', account, f"{chat}:{m['message_id']}")
            for m in batch.get('messages', [])
            if chat and m.get('message_id') not in (None, '')
        ]
    if channel == 'calendar' and batch.get('google_event_id'):
        return [
            ('calendar', batch.get('account_id', ''), batch['google_event_id'])
        ]
    return []


_ATTENTION_PRIORITY = {
    'urgent': 'urgent', 'critical': 'urgent', 'high': 'high',
    'medium': 'medium', 'normal': 'medium', 'low': 'low',
}
_ATTENTION_PRIORITY_RANK = {'urgent': 4, 'high': 3, 'medium': 2, 'low': 1}


def _attention_priority(value, default=None):
    return _ATTENTION_PRIORITY.get(str(value or '').strip().lower(), default)


def _triage_attention(result, batch, arrival):
    """`(reason, priority)` when this verdict means the user must look, else None.

    One rule for the landing Incomings tab: escalated, a critical calendar
    event, or a to-do created for the arrival. Everything else (informational
    chatter, newsletters) is in the Inbox but does not ask for the user. The
    registry keeps the highest verdict, so returning the strongest one here
    is enough.
    """
    if result.get('escalate'):
        return 'escalated', _attention_priority(
            result.get('escalation_priority'), 'urgent')
    if (batch.get('_channel') == 'calendar'
            and str(result.get('importance') or '').lower() == 'critical'):
        return 'critical_event', 'urgent'
    priorities = [
        _attention_priority(priority, 'medium')
        for surface, account_id, external_id, priority
        in batch.get('_todo_arrivals') or []
        if (surface, account_id, external_id) == arrival
    ]
    if priorities:
        return 'todo', max(
            priorities, key=lambda p: _ATTENTION_PRIORITY_RANK.get(p, 0))
    return None


def stamp_inbox_importance(result, batch, owner_user_id=None):
    """Mirror the triage verdict onto the arrivals in the shared registry.

    Best-effort and never fatal: the SQLite triage tables remain the pipeline's
    source of truth, and an unstamped row still shows in the Inbox — just
    without the urgency filter finding it. ``owner_user_id`` stamps only that
    person's copy in the current profile scope.
    """
    importance = _triage_importance(result)
    arrivals = _triaged_arrivals(batch)
    attention = {arrival: _triage_attention(result, batch, arrival)
                 for arrival in arrivals}
    if not importance and not any(attention.values()):
        return
    try:
        from shared.inbound_registration import mark_importance
    except ImportError:
        return
    for arrival in arrivals:
        surface, account_id, external_id = arrival
        reason, priority = attention[arrival] or (None, None)
        if not importance and reason is None:
            continue
        mark_importance(
            surface=surface,
            external_id=external_id,
            account_id=account_id,
            importance=importance,
            attention_reason=reason,
            attention_priority=priority,
            **({'owner_user_id': owner_user_id} if owner_user_id else {}),
        )


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def _arrival_fields(batch, arrival):
    """What the batch says about one arrival, for its profile registry row."""
    channel = batch.get('_channel', 'whatsapp')
    _surface, _account, external_id = arrival
    if channel == 'email':
        em = next((e for e in batch.get('emails', [])
                   if e.get('message_id') == external_id), {})
        return {
            'conversation': batch.get('sender'),
            'sender_id': em.get('from_addr') or batch.get('sender'),
            'sender_name': em.get('from_name') or batch.get('sender_name'),
            'subject': em.get('subject'),
            'body': em.get('body_text') or em.get('body') or '',
            'occurred_at': em.get('received_at') or em.get('date'),
            'has_attachments': bool(em.get('attachments')),
        }
    if channel == 'whatsapp':
        m = next((m for m in batch.get('messages', [])
                  if m.get('msg_id') == external_id), {})
        return {
            'conversation': m.get('chat_id'),
            'sender_id': m.get('sender_phone') or batch.get('sender_phone'),
            'sender_name': m.get('sender_name') or batch.get('sender_name'),
            'body': m.get('text') or '',
            'occurred_at': m.get('received_at'),
        }
    if channel == 'telegram':
        m = next((m for m in batch.get('messages', [])
                  if f"{batch.get('chat_id')}:{m.get('message_id')}" == external_id), {})
        return {
            'conversation': str(batch.get('chat_id') or ''),
            'conversation_name': batch.get('chat_title'),
            'sender_id': m.get('sender_id'),
            'sender_name': m.get('sender_name') or m.get('sender_username'),
            'body': m.get('text') or '',
            'occurred_at': m.get('timestamp'),
            'has_attachments': bool(m.get('media')),
        }
    return {
        'kind': 'event',
        'subject': batch.get('summary') or batch.get('title'),
        'body': batch.get('description') or '',
        'sender_id': batch.get('organizer_email'),
        'occurred_at': batch.get('start_time') or batch.get('start'),
        'ends_at': batch.get('end_time') or batch.get('end'),
    }


def _register_profile_arrivals(batch, owner_user_id):
    """File the batch's arrivals as ``owner_user_id``'s in the current profile.

    The pollers register an arrival once, in their own (box) profile; a
    user-profile triaging it needs its own copy for the to-do link, the
    importance stamp and its Inbox. Upsert, so a rerun rewrites nothing new.
    """
    try:
        from shared.inbound_registration import register_item
    except ImportError:
        return
    for arrival in _triaged_arrivals(batch):
        surface, account_id, external_id = arrival
        register_item(surface=surface, account_id=account_id,
                      external_id=external_id, owner_user_id=owner_user_id,
                      **_arrival_fields(batch, arrival))


def _raise_profile_alert(result, batch, owner_user_id):
    """An escalated arrival as an in-app alert for the owner in this profile.

    Keyed by the arrival, so the same escalation from several of the owner's
    profiles is one "Needs you" entry. The Telegram push stays with the
    box-wide escalation row (written once per batch, delivered by the
    escalation pusher), so the person is buzzed once.
    """
    arrivals = _triaged_arrivals(batch)
    key = _arrival_key(arrivals[0] if arrivals else None)
    if not key:
        return
    from hermes_cli.needs_you import TRIAGE_ALERT, with_arrival
    from shared import owner_routing
    from shared.inbound_registration import resolve_person
    import asyncio

    person = asyncio.run(resolve_person(owner_user_id))
    if person is None:
        return
    channel = batch.get('_channel', 'whatsapp')
    who = (batch.get('sender_name') or batch.get('sender')
           or batch.get('sender_phone') or batch.get('organizer_email')
           or batch.get('chat_title') or channel)
    title = f"Needs your attention: {who}"
    text = " — ".join(str(p) for p in (result.get('escalation_reason'),
                                        result.get('summary')) if p)
    owner_routing.notify_in_app(person, title=title, text=text or title,
                                dedupe_key=with_arrival(TRIAGE_ALERT, key))


def _profile_person_active(owner_user_id):
    try:
        import asyncio
        from shared.inbound_registration import resolve_person
        return asyncio.run(resolve_person(owner_user_id)) is not None
    except Exception as e:
        print(f"[triage] Could not resolve {owner_user_id} in the profile: {e}")
        return False


def _dispatch(result, batch, db, box_writes):
    for key, value in result.items():
        handler = _HANDLERS.get(key)
        if handler is None or (key in _BOX_FIELDS and not box_writes):
            # Unhandled fields (e.g. classification, summary) are ignored.
            continue
        try:
            handler(value, batch, db)
        except Exception as e:
            print(f"[triage] Handler error for field '{key}': {e}")


def process_result(result, batch, db, *, profile_home=None, owner_user_id=None,
                   box_writes=True):
    """Generic dispatcher — handles whatever fields the LLM returned.

    Iterates over every key in the JSON response and calls the registered
    handler. Unregistered fields are logged and safely ignored.

    The batch dict must contain '_channel' ('whatsapp', 'email', 'calendar')
    so handlers know which SQLite tables and columns to use.

    The result dict is also merged into the batch dict so escalation handlers
    can access escalation_reason, escalation_priority, and summary from the
    LLM response.

    **Legacy** (``profile_home`` and ``owner_user_id`` both None): exactly the
    box-wide behaviour — every write as the install owner in this process's
    HERMES_HOME / ``supabase-app`` prod schema, and ``batch`` is updated in
    place.

    **Profile-scoped** (FG-03 P5; both set, else ``ValueError``): one chosen
    user-profile's result. Everything below runs inside
    ``profile_runtime_scope(profile_home)``, so ``get_store('supabase-app',
    'prod')`` is that profile's schema, and acts for ``owner_user_id`` (the
    source owner) as that profile's principal, never ``resolve_owner()``:

    * the arrivals are registered in the profile as the owner's, then
      stamped with the verdict (``inbound_registration``);
    * to-dos / work requests are filed for the owner (``register_todo``),
      their announcement and push tagged with the arrival key; a Telegram
      push goes to the owner's own linked chat only, never the box chat,
      and at most once per arrival per person across profiles;
    * auto-start launches the work session in ``profile_home``;
    * an escalation raises an in-app alert for the owner, keyed by the
      arrival (one "Needs you" entry across profiles);
    * memory facts go to the owner's untrusted inbox in that profile,
      ``memories/users/<uid>/INBOX_FACTS.md`` (see ``memory_bridge``).

    If the owner is not an active person in the profile, none of those
    writes happen. ``batch`` is copied, not updated, so one batch dict can
    be processed for several profiles.

    ``box_writes``: the box-wide channel SQLite rows (tasks, notes, the
    escalation row, calendar importance/prep notes) are written only when
    True. A caller processing one batch for N profiles passes True for
    exactly one of them (the first that succeeds) and False for the rest;
    the escalation row it writes is what the escalation pusher delivers,
    once.
    """
    if (profile_home is None) != (owner_user_id is None):
        raise ValueError("profile_home and owner_user_id must be given together")
    if batch.get('_channel') == 'telegram':
        box_writes = False  # no box-wide Telegram channel SQLite

    if profile_home is None:
        # Merge result fields into batch so escalation handler can access them
        for key, value in result.items():
            batch[key] = value
        _dispatch(result, batch, db, box_writes)
        # After the SQLite writes, so a registry blip cannot cost the pipeline
        # its own record of the verdict.
        try:
            stamp_inbox_importance(result, batch)
        except Exception as e:
            print(f"[triage] Could not stamp inbox importance: {e}")
        return

    from agent.profile_runtime import profile_runtime_scope

    batch = {k: v for k, v in batch.items() if k not in ('_todo_arrivals', _SCOPE)}
    batch.update(result)
    with profile_runtime_scope(profile_home):
        if not _profile_person_active(owner_user_id):
            print(f"[triage] {owner_user_id} is not an active person in "
                  f"{profile_home}; only box-wide writes")
            _dispatch({k: v for k, v in result.items() if k in _BOX_FIELDS},
                      batch, db, box_writes)
            return
        batch[_SCOPE] = {'home': str(profile_home), 'owner_user_id': owner_user_id}
        try:
            _register_profile_arrivals(batch, owner_user_id)
        except Exception as e:
            print(f"[triage] Could not register arrivals in the profile: {e}")
        _dispatch(result, batch, db, box_writes)
        try:
            stamp_inbox_importance(result, batch, owner_user_id=owner_user_id)
        except Exception as e:
            print(f"[triage] Could not stamp inbox importance: {e}")
        if result.get('escalate'):
            try:
                _raise_profile_alert(result, batch, owner_user_id)
            except Exception as e:
                print(f"[triage] Could not raise the profile alert: {e}")
