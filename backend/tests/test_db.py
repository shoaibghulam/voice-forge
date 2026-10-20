"""Database foundations: ids, timestamps, SQLite pragmas, and the Alembic migration."""

import time
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError

from app.db import make_engine, new_id, utc_now

BACKEND = Path(__file__).resolve().parents[1]
EXPECTED_TABLES = {
    "analyses",
    "users",
    "sessions",
    "singers",
    "songs",
    "clips",
    "jobs",
    "job_stages",
    "job_events",
    "runs",
    "checkpoints",
    "covers",
    "benchmarks",
}


def alembic_config(db_url: str) -> Config:
    config = Config(str(BACKEND / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND / "migrations"))
    config.set_main_option("sqlalchemy.url", db_url)
    return config


def test_new_id_is_uuid7() -> None:
    assert uuid.UUID(new_id()).version == 7


def test_new_ids_sort_by_creation_time() -> None:
    first = new_id()
    time.sleep(0.002)
    second = new_id()

    assert first < second


def test_utc_now_is_iso8601_with_z() -> None:
    stamp = utc_now()

    assert stamp.endswith("Z")
    assert "T" in stamp


def test_engine_sets_wal_busy_timeout_and_foreign_keys(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'app.db'}")

    with engine.connect() as conn:
        assert conn.execute(text("PRAGMA journal_mode")).scalar() == "wal"
        assert conn.execute(text("PRAGMA busy_timeout")).scalar() == 5000
        assert conn.execute(text("PRAGMA foreign_keys")).scalar() == 1


def test_migration_creates_every_table_and_downgrade_removes_them(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'app.db'}"
    config = alembic_config(url)

    command.upgrade(config, "head")
    tables = set(inspect(create_engine(url)).get_table_names())
    assert tables >= EXPECTED_TABLES

    command.downgrade(config, "base")
    remaining = set(inspect(create_engine(url)).get_table_names()) - {"alembic_version"}
    assert remaining == set()


def test_job_events_are_indexed_by_job_and_seq(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'app.db'}"
    command.upgrade(alembic_config(url), "head")

    indexes = inspect(create_engine(url)).get_indexes("job_events")

    assert any(ix["column_names"] == ["job_id", "seq"] for ix in indexes)


def test_foreign_keys_are_enforced(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'app.db'}"
    command.upgrade(alembic_config(url), "head")
    engine = make_engine(url)

    with pytest.raises(IntegrityError), engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO songs (id, singer_id, original_filename, stored_path, era,"
                " status, created_at) VALUES ('s1', 'no-such-singer', 'a.mp3', 'x', 'unknown',"
                " 'uploaded', '2026-10-19T00:00:00Z')"
            )
        )
