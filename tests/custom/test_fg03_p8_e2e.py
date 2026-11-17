"""FG-03 P8 E2E: the whole multi-user / multi-profile triage design, end to end.

John and Mary in CFO and CMO over a tmp hermes root and real Postgres. Each
scenario starts where production does — the email batcher, the WhatsApp
batcher and the Telegram capture writer emit a batch — and runs the real
triage scripts, registry, router, layered skills, profile-agent turn,
handlers, Needs You, memory inbox, HTTP APIs and reply-account send path.
The only stand-in is the model, faked at the HTTP boundary by a local
OpenAI-compatible server that counts every request, so ``route_batch``'s
auxiliary client and the seeded triage session run for real.
"""
import asyncio
import itertools
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "custom"))

import tests.custom.test_fg03_profile_triage_e2e as p5  # noqa: E402
from hermes_cli import source_registry as registry  # noqa: E402
from hermes_cli import telegram_triage  # noqa: E402
from hermes_cli import todo_outbound  # noqa: E402
from hermes_cli import triage_skills as tsk  # noqa: E402
from hermes_cli.access import PrincipalStore  # noqa: E402
from hermes_cli.console_scope import _scoped_to  # noqa: E402
from hermes_cli.consent import ConsentPolicy  # noqa: E402
from hermes_cli.datastore import get_store  # noqa: E402
from hermes_cli.human_comms import NotificationStore  # noqa: E402
from hermes_cli.inbound_registry import InboundRegistry  # noqa: E402
from hermes_cli.todo_store import TodoStore  # noqa: E402
from tests.custom.test_fg03_batch_routing import _exec, credit  # noqa: E402,F401
from tests.custom.test_fg03_profile_triage_e2e import (  # noqa: E402
    JOHN_CHAT,
    LEGACY,
    NOTHING,
    _arrival_entries,
    _decisions,
    _profile_rows,
    _stores,
)
from tests.custom.test_fg03_telegram_triage_e2e import Telegram  # noqa: E402
from tests.hermes_cli._pg_fixture import hermes_root, pg_config, postgres_dsn  # noqa: E402,F401
from tests.hermes_cli.test_fg03_reply_accounts_e2e import (  # noqa: E402,F401 — pytest fixture
    JOHN_BOT,
    JOHN_BOT_TOKEN,
    JOHN_MAIL,
    JOHN_WA,
    JOHN_WA_PORT,
    MARY_MAIL,
    world,
)
from tests.hermes_cli.test_source_registry_e2e import (  # noqa: E402,F401 — pytest fixture
    _box,
    _client,
    _seed,
    _session_as,
    box,
)

EMAIL_BATCHER = ROOT / "custom" / "email" / "email_batcher.py"
WA_BATCHER = ROOT / "custom" / "whatsapp" / "batcher.py"
ROUTER_MODEL, AGENT_MODEL = "stub-router", "stub-agent"
KEYWORDS = {"cfo": "invoice", "cmo": "launch"}
TEXT = {
    "invoice": "Invoice INV-77 is overdue",           # CFO only
    "launch": "Launch plan and the agency invoice",   # CFO and CMO
    "chat": "Are we on for Friday?",                  # nobody
}
CHANNELS = ["email", "whatsapp", "telegram"]
SENDER = {"email": "ann@supplier.example", "whatsapp": "85290000000", "telegram": "9001"}
TG_CHAT = "-100555"
CARE = re.compile(r"\b(John|Mary)@(CFO|CMO)\b")


# --- the model, at the HTTP boundary ---------------------------------------

class ModelStub:
    """A local OpenAI-compatible server: routes by keyword, triages per
    user-profile (read from the care section in the prompt), answers the
    legacy DeepSeek call, and records every request."""

    def __init__(self):
        self.requests = []
        self.router_fails = False
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):  # model listing probes
                self._json(200, {"object": "list", "data": [
                    {"id": m, "object": "model"} for m in (ROUTER_MODEL, AGENT_MODEL)]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if "messages" not in body:
                    return self._json(404, {"error": {"message": "unsupported"}})
                status, content = stub.answer(body)
                if status != 200:
                    return self._json(status, {"error": {"message": content}})
                choice = {"index": 0, "finish_reason": "stop",
                          "message": {"role": "assistant", "content": content}}
                usage = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                if body.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for delta, finish, extra in (({"role": "assistant", "content": content}, None, {}),
                                                 ({}, "stop", {"usage": usage})):
                        chunk = {"id": "c", "object": "chat.completion.chunk", "created": 0,
                                 "model": body.get("model"),
                                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                                 **extra}
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                    return
                self._json(200, {"id": "c", "object": "chat.completion", "created": 0,
                                 "model": body.get("model"), "choices": [choice], "usage": usage})

            def _json(self, status, payload):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @staticmethod
    def _text(body):
        out = []
        for m in body["messages"]:
            c = m.get("content")
            out.append(c if isinstance(c, str) else json.dumps(c))
        return "\n".join(out)

    def answer(self, body):
        model, text = body.get("model"), self._text(body)
        if model == ROUTER_MODEL:
            self.requests.append(("router", text))
            if self.router_fails:  # unusable, not an HTTP error: no SDK-level retry
                return 200, "I think the CFO should look at this."
            names = json.loads("[" + text.split("Profile names: ", 1)[1].split("\n", 1)[0].rstrip(".") + "]")
            batch = body["messages"][-1]["content"].lower()
            return 200, json.dumps({"routes": [
                {"profile": p, "selected": KEYWORDS.get(p, "-") in batch,
                 "reason": f"mentions {KEYWORDS[p]}" if KEYWORDS.get(p, "-") in batch else "not relevant"}
                for p in names]})
        if model == AGENT_MODEL:
            found = sorted(set(CARE.findall(text)))
            self.requests.append(("turn", text, found))
            who = "+".join(f"{u}@{p}" for u, p in found) or "nobody"
            return 200, "```json\n" + json.dumps({
                "classification": "agent", "summary": f"{who} verdict",
                "escalate": True, "escalation_reason": "invoice", "escalation_priority": "high",
                "tasks": [{"description": f"pay INV-77 ({who})"}],
                "todos": [{"title": f"Pay INV-77 ({who})", "priority": "high", "notify": True}],
                "memory_facts": [{"fact": f"INV-77 is overdue ({who})", "category": "work"}],
            }) + "\n```"
        self.requests.append(("legacy", text))
        return 200, json.dumps(LEGACY)

    def kinds(self):
        return [r[0] for r in self.requests]

    def turns(self):
        return [r[2] for r in self.requests if r[0] == "turn"]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def model():
    stub = ModelStub()
    yield stub
    stub.close()


def _configure(hermes_root, model, router="enforce", agent="agent"):  # noqa: F811
    path = hermes_root / "config.yaml"
    config = yaml.safe_load(path.read_text()) if path.exists() else {}
    config = config or {}
    config["model"] = {"provider": "custom", "base_url": model.url, "default": AGENT_MODEL,
                       "api_key": "stub"}
    config["auxiliary"] = {"triage_router": {"provider": "custom", "base_url": model.url,
                                             "model": ROUTER_MODEL, "api_key": "stub"}}
    config["triage"] = {"router": {"mode": router, "retry_delay_seconds": 0},
                        "agent": {c: agent for c in CHANNELS}}
    path.write_text(yaml.safe_dump(config))
    # The profile agent's turn runs in the profile, on that profile's model.
    for home in Path(hermes_root, "profiles").iterdir():
        path = home / "config.yaml"
        config = (yaml.safe_load(path.read_text()) if path.exists() else None) or {}
        config["model"] = {"provider": "custom", "base_url": model.url, "default": AGENT_MODEL,
                           "api_key": "stub"}
        path.write_text(yaml.safe_dump(config))


# --- the people, their sources and the producers ----------------------------

def _source_ids(box):  # noqa: F811
    async def read(c):
        return {(s.channel, s.owner_user_id, s.address): s.source_id
                for s in await registry.list_sources(c)}
    return _box(box["dsn"], read)


def _people(box):  # noqa: F811
    """John and Mary in CFO and CMO, each with their own care in each. John's
    mailbox, bridge and bot are routed to CFO and CMO; Mary's mailbox to CFO."""
    homes = box["homes"]
    asyncio.run(_seed(homes["cmo"], box["dsn"], [("mary", "member", True)]))
    for profile in ("cfo", "cmo"):
        for user in ("john", "mary"):
            for kind in CHANNELS:
                tsk.write_care(kind, f"{user.title()}@{profile.upper()}: invoices and launches",
                               layer="user", home=homes[profile], user_id=user, author=user)
    ids = _source_ids(box)
    john = {"email": ids[("email", "john", JOHN_MAIL)],
            "whatsapp": ids[("whatsapp", "john", registry.normalize_address("whatsapp", f"+{JOHN_WA}"))],
            "telegram": ids[("telegram", "john", registry.normalize_address("telegram", f"tgbot:{JOHN_BOT}"))]}
    mary = ids[("email", "mary", MARY_MAIL)]

    async def routes(c):
        for source_id in john.values():
            for profile in ("cfo", "cmo"):
                await registry.set_route(c, source_id=source_id, profile_slug=profile,
                                         enabled=True, actor_user_id="john")
        await registry.set_route(c, source_id=mary, profile_slug="cfo", enabled=True,
                                 actor_user_id="mary")
    _box(box["dsn"], routes)
    return john, mary


def _keeping_deepseek(path, replace, name):
    module = _exec(path, replace, name)
    module._real_call_deepseek = module.call_deepseek
    return module


class Pipeline:
    """One channel as deployed: its batch producer and its triage script.
    The legacy DeepSeek call is real too, pointed at the stub."""

    def __init__(self, kind, tmp_path, monkeypatch, model):
        self.kind = kind
        if kind == "telegram":
            self.tg = Telegram(tmp_path, None)
            return
        monkeypatch.setattr(p5, "_exec", _keeping_deepseek)
        self.ch = p5.Channel(kind, tmp_path, monkeypatch)
        module = self.ch.module
        monkeypatch.setattr(module, "call_deepseek", module._real_call_deepseek)
        monkeypatch.setattr(module, "DEEPSEEK_BASE_URL", f"{model.url}/chat/completions")
        # Credit tracking is out of scope; the call it wraps must still happen.
        monkeypatch.setattr(module, "track_inference", lambda _label, call, *a, **k: call())
        if kind == "email":
            self.batcher = _exec(EMAIL_BATCHER, {"/opt/data/email-messages":
                                                 str(tmp_path / "email-messages")}, "_p8_email_batcher")
            self.batcher.BATCH_DIR = self.ch.batch_dir
        else:
            p5._sqlite(self.ch.messaging, "CREATE TABLE messages (id TEXT PRIMARY KEY, batch_id TEXT);")
            self.batcher = _exec(WA_BATCHER, {"/opt/data/whatsapp-messages":
                                              str(tmp_path / "whatsapp-messages")}, "_p8_wa_batcher")
            self.batcher.BATCH_OUTPUT_DIR = self.ch.batch_dir

    _seq = itertools.count(1)

    def arrive(self, name, source_id, owner="john", account=None):
        """The producer's batch for one message of ``TEXT[name]``; returns its batch id."""
        n = next(self._seq)
        text, ref = TEXT[name], f"{name}-{n}"
        if self.kind == "email":
            path = self.batcher.write_batch("k", [{
                "id": ref, "from_addr": SENDER["email"], "from_name": "Ann",
                "account_id": account or JOHN_MAIL, "source_id": source_id,
                "owner_user_id": owner, "subject": "INV-77", "body_text": text,
                "message_id": f"<{ref}@supplier.example>", "received_at": "2026-11-16T08:00:00Z",
            }], f"b-{ref}")
            return json.loads(Path(path).read_text())["batch_id"]
        if self.kind == "whatsapp":
            key = self.batcher.batch_key(SENDER["whatsapp"], account or JOHN_WA, source_id, owner)
            self.batcher._pending_batches[key] = {
                "batch_id": f"b-{ref}", "sender_phone": SENDER["whatsapp"],
                "source_phone": account or JOHN_WA, "source_id": source_id,
                "owner_user_id": owner, "started_at": "2026-11-16T08:00:00Z", "timer": None,
                "messages": [{"msg_id": ref, "text": text, "media_type": None,
                              "timestamp": "2026-11-16T08:00:00Z", "sender_name": "Ann",
                              "chat_id": f"{SENDER['whatsapp']}@s.whatsapp.net", "is_group": False}],
            }
            self.batcher.flush_batch(key)
            return f"b-{ref}"
        first = str(1000 + n)
        batch_id = telegram_triage.batch_id_for(JOHN_BOT, TG_CHAT, first)
        telegram_triage.write_batch({
            "batch_id": batch_id, "channel": "telegram", "source_id": source_id,
            "owner_user_id": owner, "account_id": f"{telegram_triage.ACCOUNT_PREFIX}{JOHN_BOT}",
            "chat_id": TG_CHAT, "chat_type": "group", "chat_title": "Suppliers",
            "created_at": "2026-11-16T08:00:00Z",
            "messages": [{"message_id": first, "sender_id": SENDER["telegram"], "sender_name": "Ann",
                          "sender_username": "ann", "text": text,
                          "timestamp": "2026-11-16T08:00:00Z", "media": []}],
        }, batch_dir=self.tg.batch_dir)
        return batch_id

    def triage(self):
        """One pass of the channel's triage script over every pending batch."""
        if self.kind == "telegram":
            return self.tg.run()
        for path in sorted(Path(self.ch.batch_dir).glob("*.json")):
            self.ch.run(path)

    def pending(self):
        d = self.tg.batch_dir if self.kind == "telegram" else Path(self.ch.batch_dir)
        return sorted(p.name for p in Path(d).glob("*.json"))


@pytest.fixture
def design(world, box, hermes_root, tmp_path, monkeypatch, model, credit):  # noqa: F811
    """``design(kind, router=, agent=)`` -> (pipeline, John's source ids, Mary's mailbox id)."""
    _stores(box, monkeypatch)
    john, mary = _people(box)

    def make(kind, router="enforce", agent="agent"):
        _configure(hermes_root, model, router, agent)
        return Pipeline(kind, tmp_path, monkeypatch, model), john, mary

    return make


def _memory(box, profile, user):  # noqa: F811
    path = box["homes"][profile] / "memories" / "users" / user / "INBOX_FACTS.md"
    return path.read_text() if path.exists() else ""


def _api(monkeypatch, user, path, method="get", **kwargs):
    _session_as(monkeypatch, user)
    return getattr(_client(user), method)(path, **kwargs)


def _why(monkeypatch, user, source_id, batch_id):  # noqa: F811
    """The "Why this profile?" decisions the agent-home API shows ``user``."""
    return _api(monkeypatch, user, "/api/sources/decisions",
                params={"source_id": source_id, "batch_id": batch_id}).json()["decisions"]


def _care_seen(monkeypatch, user, kind, profile):
    body = _api(monkeypatch, user, "/api/triage/layers",
                params={"kind": kind, "profile": profile}).json()
    return CARE.findall(json.dumps(body["care"]))


def _routers(model):
    return [r for r in model.requests if r[0] == "router"]


def _nothing_for_mary(box, monkeypatch):  # noqa: F811
    rows = _profile_rows(box)
    for profile in ("default", "cfo", "cmo"):
        assert all(owner != "mary" for owner, _ in rows[profile]["todos"])
        assert all(owner != "mary" for owner, _ in rows[profile]["notifications"])
        assert _memory(box, profile, "mary") == ""
        assert p5._todo_dicts(box, profile, "mary") == []
    assert _arrival_entries(monkeypatch, "mary") == []


def _propose_reply(world, profile, user, todo_id):
    """``user`` drafts a reply on the to-do's arrival, under standing consent."""
    async def run():
        with _scoped_to(world["homes"][profile]):
            app = get_store("supabase-app", "prod", config=world["config"])
            principal = await PrincipalStore(app).get(user)
            todos = TodoStore(app)
            todo = await todos.get(principal, todo_id)
            item = await InboundRegistry(app).get(principal, todo.source_ref)
            action = todo_outbound.parse_action({"body": "Yes, paid today."}, arrival=item.as_dict())
            notifications = NotificationStore(app, config=world["config"],
                                              policy=ConsentPolicy(auto_approve_reversible=True))
            return await todo_outbound.propose(todos, notifications, principal, todo, action)

    return asyncio.run(run())


def _outbound(world, profile, user, todo_id):
    async def run():
        with _scoped_to(world["homes"][profile]):
            app = get_store("supabase-app", "prod", config=world["config"])
            principal = await PrincipalStore(app).get(user)
            return sorted(e["event"] for e in await TodoStore(app).list_outbound(principal, todo_id))

    return asyncio.run(run())


def _left_through_receiving_account(kind, sent):
    if kind == "email":
        return (sent["platform"], sent["from"], sent["chat_id"], sent["smtp"][2]) == (
            "email", JOHN_MAIL, SENDER["email"], JOHN_MAIL)
    if kind == "whatsapp":
        return (sent["platform"], sent["extra"].get("bridge_port")) == ("whatsapp", JOHN_WA_PORT)
    return (sent["platform"], sent["chat_id"], sent["token"]) == ("telegram", TG_CHAT, JOHN_BOT_TOKEN)


# --- scenarios ----------------------------------------------------------------

@pytest.mark.parametrize("kind", CHANNELS)
def test_one_profile_end_to_end(design, model, box, world, monkeypatch, kind):  # noqa: F811
    """Batch -> one router call -> John@CFO only -> to-do, alert, memory ->
    "Why this profile?" -> approved reply through the receiving account."""
    pipe, john, _mary = design(kind)
    source_id = john[kind]
    batch_id = pipe.arrive("invoice", source_id)
    pipe.triage()

    assert pipe.pending() == []
    assert model.kinds() == ["router", "turn"]  # exactly one routing call
    [(_, router_prompt)] = _routers(model)
    assert CARE.findall(router_prompt) == [("John", "CFO"), ("John", "CMO")]  # the owner's care only
    assert model.turns() == [[("John", "CFO")]]  # John's own CFO skills, nobody else's
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77 (John@CFO)")]
    assert {owner for owner, _ in rows["cfo"]["notifications"]} == {"john"}
    assert rows["cmo"] == NOTHING and rows["default"] == NOTHING  # John@CMO was not routed
    sender = {"email": SENDER["email"], "whatsapp": SENDER["whatsapp"], "telegram": "@ann"}[kind]
    assert f"from {sender}] INV-77 is overdue (John@CFO)" in _memory(box, "cfo", "john")
    assert _memory(box, "cmo", "john") == "" and _memory(box, "default", "john") == ""
    _nothing_for_mary(box, monkeypatch)

    [entry] = _arrival_entries(monkeypatch, "john")
    assert entry["context"]["profiles"] == ["cfo"]
    [todo] = p5._todo_dicts(box, "cfo", "john")
    assert (todo["routing_source_id"], todo["routing_batch_id"]) == (source_id, batch_id)
    [why] = _why(monkeypatch, "john", source_id, batch_id)
    assert why["selected"] == ["cfo"] and not why["fallback"]
    assert "mentions invoice" in json.dumps(why)
    assert _why(monkeypatch, "mary", source_id, batch_id) == []  # owner-only
    assert _care_seen(monkeypatch, "mary", kind, "cfo") == [("Mary", "CFO")]
    assert _care_seen(monkeypatch, "john", kind, "cmo") == [("John", "CMO")]

    proposal = _propose_reply(world, "cfo", "john", todo["id"])
    assert proposal.auto_approved is False and world["sent"] == []  # never auto-sent
    refused = _api(monkeypatch, "mary",
                   f"/api/comms/notifications/{proposal.notification_id}/answer?profile=cfo",
                   method="post", json={"answer": "approved"})
    assert refused.status_code >= 400 and world["sent"] == []  # not Mary's to approve
    assert _outbound(world, "cfo", "john", todo["id"]) == ["proposed"]

    approved = _api(monkeypatch, "john",
                    f"/api/comms/notifications/{proposal.notification_id}/answer?profile=cfo",
                    method="post", json={"answer": "approved"})
    assert approved.status_code == 200, approved.text
    assert approved.json()["action"]["event"] == "sent"
    [sent] = world["sent"]
    assert _left_through_receiving_account(kind, sent), sent
    assert _outbound(world, "cfo", "john", todo["id"]) == ["proposed", "sent"]
    assert model.kinds() == ["router", "turn"]  # approving and sending call no model


@pytest.mark.parametrize("kind", CHANNELS)
def test_both_profiles(design, model, box, monkeypatch, kind):  # noqa: F811
    pipe, john, _mary = design(kind)
    batch_id = pipe.arrive("launch", john[kind])
    pipe.triage()

    assert pipe.pending() == [] and len(_routers(model)) == 1
    assert sorted(model.turns()) == [[("John", "CFO")], [("John", "CMO")]]
    rows = _profile_rows(box)
    assert rows["cfo"]["todos"] == [("john", "Pay INV-77 (John@CFO)")]
    assert rows["cmo"]["todos"] == [("john", "Pay INV-77 (John@CMO)")]
    assert rows["default"] == NOTHING
    for profile in ("cfo", "cmo"):
        assert f"(John@{profile.upper()})" in _memory(box, profile, "john")
    _nothing_for_mary(box, monkeypatch)
    [entry] = _arrival_entries(monkeypatch, "john")  # one Needs You entry
    assert entry["context"]["profiles"] == ["cfo", "cmo"]
    [why] = _why(monkeypatch, "john", john[kind], batch_id)
    assert why["selected"] == ["cfo", "cmo"] and not why["fallback"]


@pytest.mark.parametrize("kind", CHANNELS)
def test_no_profile(design, model, box, monkeypatch, kind):  # noqa: F811
    pipe, john, _mary = design(kind)
    batch_id = pipe.arrive("chat", john[kind])
    pipe.triage()

    assert pipe.pending() == [] and model.kinds() == ["router"]  # stored only
    rows = _profile_rows(box)
    assert all(rows[p] == NOTHING for p in rows)
    assert all(_memory(box, p, u) == "" for p in ("cfo", "cmo") for u in ("john", "mary"))
    assert _arrival_entries(monkeypatch, "john") == []
    [why] = _why(monkeypatch, "john", john[kind], batch_id)
    assert why["selected"] == [] and not why["fallback"]


@pytest.mark.parametrize("kind", CHANNELS)
def test_router_failure_falls_back_to_every_routed_profile(design, model, box, monkeypatch, kind):  # noqa: F811
    pipe, john, _mary = design(kind)
    model.router_fails = True
    batch_id = pipe.arrive("chat", john[kind])  # would route nowhere
    pipe.triage()

    attempts = len(_routers(model))
    assert attempts == 1 + 3  # one call, retried 3 times
    assert sorted(model.turns()) == [[("John", "CFO")], [("John", "CMO")]]
    rows = _profile_rows(box)
    assert [o for o, _ in rows["cfo"]["todos"]] == ["john"] == [o for o, _ in rows["cmo"]["todos"]]
    assert rows["default"] == NOTHING
    _nothing_for_mary(box, monkeypatch)
    [why] = _why(monkeypatch, "john", john[kind], batch_id)
    assert why["selected"] == ["cfo", "cmo"] and why["fallback"]

    pipe.triage()  # a later pass never re-routes the batch
    assert len(_routers(model)) == attempts


def test_mary_and_john_never_see_each_other(design, model, box, world, monkeypatch):  # noqa: F811
    pipe, john, mary = design("email")
    johns = pipe.arrive("launch", john["email"])
    marys = pipe.arrive("invoice", mary, owner="mary", account=MARY_MAIL)
    pipe.triage()

    assert pipe.pending() == []
    routers = _routers(model)
    assert len(routers) == 2  # one per batch
    cares = sorted(CARE.findall(r[1]) for r in routers)
    assert cares == [[("John", "CFO"), ("John", "CMO")], [("Mary", "CFO")]]  # Mary's source: CFO only
    assert sorted(model.turns()) == [[("John", "CFO")], [("John", "CMO")], [("Mary", "CFO")]]
    rows = _profile_rows(box)
    assert sorted(rows["cfo"]["todos"]) == [("john", "Pay INV-77 (John@CFO)"),
                                            ("mary", "Pay INV-77 (Mary@CFO)")]
    assert rows["cmo"]["todos"] == [("john", "Pay INV-77 (John@CMO)")]
    assert [t["title"] for t in p5._todo_dicts(box, "cfo", "john")] == ["Pay INV-77 (John@CFO)"]
    assert [t["title"] for t in p5._todo_dicts(box, "cfo", "mary")] == ["Pay INV-77 (Mary@CFO)"]
    assert p5._todo_dicts(box, "cmo", "mary") == []
    assert "Mary" not in _memory(box, "cfo", "john") + _memory(box, "cmo", "john")
    assert "John" not in _memory(box, "cfo", "mary") + _memory(box, "cmo", "mary")
    assert "(Mary@CFO)" in _memory(box, "cfo", "mary")

    [j] = _arrival_entries(monkeypatch, "john")
    [m] = _arrival_entries(monkeypatch, "mary")
    assert j["context"]["profiles"] == ["cfo", "cmo"] and m["context"]["profiles"] == ["cfo"]
    assert [d["batch_id"] for d in _api(monkeypatch, "john", "/api/sources/decisions").json()[
        "decisions"]] == [johns]
    assert [d["batch_id"] for d in _api(monkeypatch, "mary", "/api/sources/decisions").json()[
        "decisions"]] == [marys]
    assert _why(monkeypatch, "john", mary, marys) == [] and _why(monkeypatch, "mary", john["email"], johns) == []
    assert _api(monkeypatch, "mary", "/api/sources/decisions", params={"all": 1}).status_code == 403
    mine = {s["address"] for s in _api(monkeypatch, "mary", "/api/sources").json()["sources"]}
    assert mine == {MARY_MAIL}

    # Mary's reply leaves through her mailbox; John's to-do is not hers to answer.
    [todo] = p5._todo_dicts(box, "cfo", "mary")
    proposal = _propose_reply(world, "cfo", "mary", todo["id"])
    assert world["sent"] == []
    assert _api(monkeypatch, "mary",
                f"/api/comms/notifications/{proposal.notification_id}/answer?profile=cfo",
                method="post", json={"answer": "approved"}).json()["action"]["event"] == "sent"
    [sent] = world["sent"]
    assert (sent["from"], sent["chat_id"]) == (MARY_MAIL, SENDER["email"])


@pytest.mark.parametrize("kind", CHANNELS)
def test_a_source_has_one_owner(design, model, box, monkeypatch, kind):  # noqa: F811
    pipe, john, _mary = design(kind)
    address = {"email": JOHN_MAIL, "whatsapp": f"+{JOHN_WA}", "telegram": f"tgbot:{JOHN_BOT}"}[kind]
    claim = _api(monkeypatch, "mary", "/api/sources", method="post",
                 json={"channel": kind, "address": address})
    assert claim.status_code == 409, claim.text
    assert "john" not in claim.json()["detail"].lower().replace(JOHN_MAIL, "")
    assert _source_ids(box)[(kind, "john", registry.normalize_address(kind, address))] == john[kind]
    assert all(owner != "mary" or a == MARY_MAIL for (_c, owner, a) in _source_ids(box))

    # The refused claim changes nothing: John's batch still routes to John only.
    pipe.arrive("invoice", john[kind])
    pipe.triage()
    assert model.turns() == [[("John", "CFO")]]
    _nothing_for_mary(box, monkeypatch)


@pytest.mark.parametrize("kind", ["email", "whatsapp"])
def test_shadow_router_with_legacy_triage_is_unchanged(design, model, box, monkeypatch, kind):  # noqa: F811
    """Today's default: the router only records; the legacy triage acts, box-wide."""
    pipe, john, _mary = design(kind, router="shadow", agent="legacy")
    batch_id = pipe.arrive("invoice", john[kind])
    pipe.triage()

    assert pipe.pending() == [] and model.kinds() == ["router", "legacy"]
    assert pipe.ch.box_rows()["escalations"] == ["legacy verdict"]
    rows = _profile_rows(box)
    assert [t for _, t in rows["default"]["todos"]] == ["Legacy to-do"]
    assert rows["cfo"] == NOTHING and rows["cmo"] == NOTHING
    [why] = _why(monkeypatch, "john", john[kind], batch_id)
    assert why["selected"] == ["cfo"]  # recorded, not acted on
