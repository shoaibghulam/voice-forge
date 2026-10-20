"""Shared fixtures: a throwaway database and data folder, and an API client bound to them.

Test files that define their own `engine` fixture override this one.
"""

import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Engine

from app.config import Settings
from app.db import Base, make_engine
from app.deps import get_engine
from app.main import create_app
from app.worker.stages import common

CSRF = {"X-Requested-With": "music-trainer"}


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    engine = make_engine(f"sqlite:///{tmp_path / 'app.db'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(data_dir=tmp_path / "data")


@pytest.fixture
def fake_settings(settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Settings:
    """The test interpreter plays the engine venv; scripts in a temp folder play the engine
    scripts (each test writes the ones it needs). No GPU sampling."""
    scripts = tmp_path / "engine_scripts"
    scripts.mkdir()
    configured = settings.model_copy(
        update={
            "engine_python": Path(sys.executable),
            "engine_scripts_dir": scripts,
            "applio_root": tmp_path,
        }
    )
    monkeypatch.setattr(common, "get_settings", lambda: configured)
    monkeypatch.setattr(common, "gpu_reader", lambda: None)
    return configured


@pytest.fixture
async def api(engine: Engine, settings: Settings) -> AsyncIterator[AsyncClient]:
    """Client that sends the CSRF header, like the real frontend."""
    app = create_app(settings)
    app.dependency_overrides[get_engine] = lambda: engine
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://127.0.0.1:8000", headers=CSRF
    ) as ac:
        yield ac
    app.dependency_overrides.clear()
