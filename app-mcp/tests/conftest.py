import pytest

from app_mcp import server
from app_mcp.ledger import CoverageLedger


@pytest.fixture(autouse=True)
def _no_real_ledger(monkeypatch):
    """Tests never write to the developer's real $HERMES_HOME."""
    monkeypatch.setattr(server, "ledger", CoverageLedger(None))
