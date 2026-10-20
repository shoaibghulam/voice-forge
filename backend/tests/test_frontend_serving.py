"""The API serves the built frontend, with a single-page-app fallback for deep links."""

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Engine

from app.config import Settings
from app.deps import get_engine
from app.main import create_app


@pytest.fixture
async def site(engine: Engine, settings: Settings, tmp_path: Path) -> AsyncIterator[AsyncClient]:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Music Trainer</title>")
    (dist / "assets" / "app.js").write_text("console.info('app')")
    app = create_app(settings.model_copy(update={"frontend_dist": dist}))
    app.dependency_overrides[get_engine] = lambda: engine
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1:8000"
    ) as client:
        yield client


async def test_root_serves_the_app(site: AsyncClient) -> None:
    response = await site.get("/")

    assert response.status_code == 200
    assert "Music Trainer" in response.text


async def test_deep_links_fall_back_to_the_app(site: AsyncClient) -> None:
    response = await site.get("/singers/abc/dataset")

    assert response.status_code == 200
    assert "Music Trainer" in response.text


async def test_static_assets_are_served(site: AsyncClient) -> None:
    response = await site.get("/assets/app.js")

    assert response.status_code == 200
    assert "app" in response.text


async def test_unknown_api_routes_stay_json_404(site: AsyncClient) -> None:
    response = await site.get("/api/nothing-here")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_paths_cannot_escape_the_dist_folder(site: AsyncClient) -> None:
    response = await site.get("/..%2F..%2Fsecret.txt")

    assert response.status_code == 200
    assert "Music Trainer" in response.text  # falls back to the app, never a file outside


async def test_without_a_build_the_root_explains_what_to_do(
    engine: Engine, settings: Settings, tmp_path: Path
) -> None:
    app = create_app(settings.model_copy(update={"frontend_dist": tmp_path / "not-built"}))
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1:8000"
    ) as client:
        response = await client.get("/")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "frontend_not_built"
