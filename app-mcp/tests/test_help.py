import asyncio
import json
from pathlib import Path

import pytest
from mcp.shared.memory import create_connected_server_and_client_session

from app_mcp import server
from app_mcp.help import HELP, help_for
from app_mcp.pages import PAGES

APP_DIR = Path(__file__).resolve().parents[2] / "agent-home" / "src" / "app"

# agent-home routes with no page guide yet: public token/entry pages the agent
# never explains, plus existing screens to be covered. Shrinks only — a new
# route must ship with a guide (a HELP entry or an ancestor that has one).
UNGUIDED_ROUTES = {
    "/activate/[...link]", "/aquarium", "/bridge", "/chats",
    "/data", "/data/[id]", "/data/[id]/review", "/data/new",
    "/default-profile-only", "/fb/[token]", "/go/[ref]", "/login", "/models",
    "/not-available", "/profiles", "/profiles/[name]/triage", "/secret/[token]",
    "/setup", "/sites", "/sites/[id]", "/sites/new", "/skills", "/skills/[name]",
    "/skills/[name]/edit", "/survey/[token]", "/system", "/view/[id]",
}


def test_every_page_has_a_guide():
    for page in PAGES:
        assert help_for(page["path"]), page["path"]


def test_subpages_inherit_the_feature_guide():
    assert help_for("/projects/[slug]/runs/[runNo]") == HELP["/projects"]
    assert help_for("/projects/acme-launch/cards/42") == HELP["/projects"]
    assert help_for("/todos/[id]") == HELP["/todos"]


def test_unknown_and_empty_paths():
    assert help_for(None) is None
    assert help_for("") is None
    assert help_for("/no-such-page") is None


def test_projects_guide_covers_the_lifecycle_and_axes():
    guide = help_for("/projects")
    for word in ("Create", "readiness", "Activate", "Run now", "Board", "Accept",
                 "Summarise", "Archive", "One-off", "Repeatable", "Standing",
                 "Manual", "Supervised", "Autonomous"):
        assert word.lower() in guide.lower(), word


def test_app_pages_reports_a_guide_for_every_page():
    async def run():
        async with create_connected_server_and_client_session(server.mcp) as client:
            result = await client.call_tool("app_pages", {})
        return json.loads(result.content[0].text)

    pages = asyncio.run(run())["pages"]
    assert {p["path"] for p in pages} == {p["path"] for p in PAGES}
    assert all(p["has_help"] for p in pages), [p["path"] for p in pages if not p["has_help"]]


def _app_routes() -> set[str]:
    routes = set()
    for page in APP_DIR.rglob("page.tsx"):
        parts = [p for p in page.parent.relative_to(APP_DIR).parts
                 if not (p.startswith("(") and p.endswith(")")) and not p.startswith("@")]
        routes.add("/" + "/".join(parts))
    return routes


@pytest.mark.skipif(not APP_DIR.is_dir(), reason="agent-home checkout not alongside app-mcp")
def test_every_agent_home_route_has_a_guide():
    routes = _app_routes()
    missing = sorted(r for r in routes if help_for(r) is None and r not in UNGUIDED_ROUTES)
    assert not missing, f"New agent-home pages need a guide in app_mcp/help.py: {missing}"


@pytest.mark.skipif(not APP_DIR.is_dir(), reason="agent-home checkout not alongside app-mcp")
def test_unguided_allowlist_only_shrinks():
    routes = _app_routes()
    stale = sorted(r for r in UNGUIDED_ROUTES if r not in routes or help_for(r) is not None)
    assert not stale, f"Remove from UNGUIDED_ROUTES (gone or now guided): {stale}"


def test_home_guide_covers_suggested_tasks():
    guide = help_for("/").lower()
    for word in ("needs you", "suggested tasks", "work on this", "snooze", "1 min", "1 day",
                 "1 week", "dismiss"):
        assert word in guide, word


def test_guides_stay_page_level():
    """Element semantics live on elements (data-appmcp-hint), not in HELP."""
    template_paths = {p["path"] for p in PAGES}
    assert set(HELP) <= template_paths
