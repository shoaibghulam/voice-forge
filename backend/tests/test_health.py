"""Smoke tests proving the toolchain is wired up. Replace with real behaviour tests."""

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.fixture
async def client() -> AsyncClient:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://127.0.0.1:8000") as ac:
        yield ac


async def test_health_returns_ok(client: AsyncClient) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


async def test_unknown_route_returns_404(client: AsyncClient) -> None:
    # Non-API paths are the web app's (SPA fallback); unknown API paths are 404s.
    response = await client.get("/api/does-not-exist")

    assert response.status_code == 404
