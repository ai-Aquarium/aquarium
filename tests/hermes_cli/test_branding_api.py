"""Box branding: entity name + logo, public reads and owner-only writes."""

from __future__ import annotations

import base64
from types import SimpleNamespace

import pytest

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
OWNER = SimpleNamespace(user_id="root", display="Owner", role="owner", is_owner=True)
ADMIN = SimpleNamespace(user_id="ann", display="Ann", role="admin", is_owner=False)


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


@pytest.fixture
def root(tmp_path, monkeypatch):
    home = tmp_path / "root"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    return home


@pytest.fixture
def acting(monkeypatch):
    from hermes_cli import web_server

    state = {"as": OWNER, "subject": "owner-session"}

    async def _fake(request, *, allow_as=False):
        return state["as"]

    monkeypatch.setattr(web_server, "_comms_resolve_principal", _fake)
    monkeypatch.setattr(web_server, "_comms_session_subject", lambda request: state["subject"])
    return state


@pytest.fixture
def client(root, acting):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import _SESSION_HEADER_NAME, _SESSION_TOKEN, app

    c = TestClient(app, raise_server_exceptions=False)
    c.headers[_SESSION_HEADER_NAME] = _SESSION_TOKEN
    return c


@pytest.fixture
def anonymous(root):
    from starlette.testclient import TestClient

    from hermes_cli.web_server import app

    return TestClient(app, raise_server_exceptions=False)


def test_sniff_image_accepts_only_raster_formats():
    from hermes_cli.branding_api import sniff_image

    assert sniff_image(PNG) == "image/png"
    assert sniff_image(JPEG) == "image/jpeg"
    assert sniff_image(b"GIF89a....") == "image/gif"
    assert sniff_image(b"RIFF\x00\x00\x00\x00WEBPVP8 ") == "image/webp"
    assert sniff_image(b"<svg xmlns='http://www.w3.org/2000/svg'/>") is None


def test_normalize_name_strips_controls_and_limits_length():
    from hermes_cli.branding_api import NAME_MAX, normalize_name

    assert normalize_name("  Hang\u202eSeng\x07Dev ") == "HangSengDev"
    with pytest.raises(ValueError):
        normalize_name("x" * (NAME_MAX + 1))
    with pytest.raises(ValueError):
        normalize_name(42)


def test_reads_are_public_and_empty_by_default(anonymous):
    assert anonymous.get("/api/branding").json() == {"name": None, "logo": None}
    assert anonymous.get("/api/branding/logo").status_code == 404


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("PUT", "/api/settings/branding", {"name": "Leo Lau"}),
        ("PUT", "/api/settings/branding/logo", {"data": _b64(PNG)}),
        ("DELETE", "/api/settings/branding/logo", None),
    ],
)
def test_writes_need_sign_in(anonymous, method, path, body):
    assert anonymous.request(method, path, json=body).status_code == 401


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("PUT", "/api/settings/branding", {"name": "Leo Lau"}),
        ("PUT", "/api/settings/branding/logo", {"data": _b64(PNG)}),
        ("DELETE", "/api/settings/branding/logo", None),
    ],
)
def test_an_admin_cannot_change_the_branding(client, acting, method, path, body):
    acting["as"] = ADMIN
    acting["subject"] = "ann-session"
    assert client.request(method, path, json=body).status_code == 403
    assert client.get("/api/branding").json() == {"name": None, "logo": None}


def test_owner_sets_and_clears_the_name(client):
    r = client.put("/api/settings/branding", json={"name": "  Leo Lau "})
    assert r.status_code == 200
    assert r.json() == {"name": "Leo Lau", "logo": None}
    assert client.get("/api/branding").json()["name"] == "Leo Lau"
    assert client.put("/api/settings/branding", json={"name": ""}).json()["name"] is None
    assert client.put("/api/settings/branding", json={}).status_code == 400
    assert client.put("/api/settings/branding", json={"name": "x" * 61}).status_code == 400


def test_owner_uploads_serves_and_resets_the_logo(client, anonymous, root):
    r = client.put("/api/settings/branding/logo", json={"data": _b64(PNG)})
    assert r.status_code == 200
    logo = r.json()["logo"]
    assert logo["content_type"] == "image/png" and len(logo["version"]) == 16

    served = anonymous.get("/api/branding/logo")
    assert served.status_code == 200
    assert served.content == PNG
    assert served.headers["content-type"] == "image/png"
    assert served.headers["x-content-type-options"] == "nosniff"
    assert anonymous.get("/api/branding").json()["logo"] == logo

    replaced = client.put("/api/settings/branding/logo", json={"data": _b64(JPEG)}).json()["logo"]
    assert replaced["content_type"] == "image/jpeg" and replaced["version"] != logo["version"]

    assert client.delete("/api/settings/branding/logo").json()["logo"] is None
    assert anonymous.get("/api/branding/logo").status_code == 404
    assert not (root / "branding" / "logo").exists()


@pytest.mark.parametrize(
    "body,status",
    [
        ({}, 400),
        ({"data": "not base64!"}, 400),
        ({"data": _b64(b"<svg/>")}, 400),
        ({"data": _b64(PNG + b"\x00" * (1024 * 1024))}, 413),
    ],
)
def test_bad_logos_are_refused_and_nothing_is_saved(client, body, status):
    assert client.put("/api/settings/branding/logo", json=body).status_code == status
    assert client.get("/api/branding").json()["logo"] is None
