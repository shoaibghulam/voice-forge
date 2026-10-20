"""Running a claimed job's stages: order, resume, failure, cancel, and the events emitted."""

import threading
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.db import Base, make_engine
from app.models import Job, JobEvent, JobStage
from app.worker.events import EventWriter
from app.worker.job_queue import claim_next, enqueue
from app.worker.stage_runner import Pipeline, StageContext, StageError, run_job

NOW = "2026-10-19T10:00:00.000Z"
StageFn = Callable[[StageContext], dict[str, object]]


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    engine = make_engine(f"sqlite:///{tmp_path / 'app.db'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def start(engine: Engine, job_type: str, names: list[str]) -> str:
    job_id = enqueue(engine, job_type, names)
    claim_next(engine, worker_pid=1, now=NOW, lease_s=60)
    return job_id


def run(
    engine: Engine, job_id: str, pipeline: Pipeline, cancel: threading.Event | None = None
) -> str:
    return run_job(
        engine, job_id, pipeline, EventWriter(engine, job_id), cancel or threading.Event()
    )


def recorder(calls: list[str], name: str) -> StageFn:
    def fn(ctx: StageContext) -> dict[str, object]:
        calls.append(name)
        return {"files": 3}

    return fn


def event_types(engine: Engine, job_id: str) -> list[str]:
    with Session(engine) as session:
        rows = session.scalars(
            select(JobEvent.type).where(JobEvent.job_id == job_id).order_by(JobEvent.seq)
        )
        return list(rows)


def stage_statuses(engine: Engine, job_id: str) -> dict[str, str]:
    with Session(engine) as session:
        rows = session.scalars(select(JobStage).where(JobStage.job_id == job_id))
        return {row.name: row.status for row in rows}


def job_row(engine: Engine, job_id: str) -> Job:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        assert job is not None
        return job


def test_runs_every_stage_in_order_and_finishes_done(engine: Engine) -> None:
    calls: list[str] = []
    job_id = start(engine, "t", ["a", "b"])
    pipeline = {"t": [("a", recorder(calls, "a")), ("b", recorder(calls, "b"))]}

    assert run(engine, job_id, pipeline) == "done"
    assert calls == ["a", "b"]
    assert stage_statuses(engine, job_id) == {"a": "done", "b": "done"}
    assert job_row(engine, job_id).status == "done"
    assert event_types(engine, job_id) == [
        "job.status",
        "stage.started",
        "stage.completed",
        "stage.started",
        "stage.completed",
        "job.status",
    ]


def test_resume_skips_stages_already_done(engine: Engine) -> None:
    calls: list[str] = []
    job_id = start(engine, "t", ["a", "b"])
    with Session(engine) as session:
        stage_a = session.scalars(select(JobStage).where(JobStage.name == "a")).one()
        stage_a.status = "done"
        session.commit()
    pipeline = {"t": [("a", recorder(calls, "a")), ("b", recorder(calls, "b"))]}

    assert run(engine, job_id, pipeline) == "done"
    assert calls == ["b"]
    assert "stage.skipped" in event_types(engine, job_id)


def test_stage_error_fails_job_and_stops_later_stages(engine: Engine) -> None:
    calls: list[str] = []

    def broken(ctx: StageContext) -> dict[str, object]:
        raise StageError("empty_filelist", "No clips were extracted.", hint="Is rmvpe.pt present?")

    job_id = start(engine, "t", ["a", "b"])
    pipeline = {"t": [("a", broken), ("b", recorder(calls, "b"))]}

    assert run(engine, job_id, pipeline) == "failed"
    assert calls == []
    assert stage_statuses(engine, job_id) == {"a": "failed", "b": "pending"}
    assert job_row(engine, job_id).error_code == "empty_filelist"
    with Session(engine) as session:
        failed = session.scalars(select(JobEvent).where(JobEvent.type == "stage.failed")).one()
    assert failed.payload_json["hint"] == "Is rmvpe.pt present?"


def test_unexpected_exception_fails_with_internal_error(engine: Engine) -> None:
    def crash(ctx: StageContext) -> dict[str, object]:
        raise ZeroDivisionError

    job_id = start(engine, "t", ["a"])

    assert run(engine, job_id, {"t": [("a", crash)]}) == "failed"
    assert job_row(engine, job_id).error_code == "internal_error"


def test_cancel_during_a_stage_stops_before_the_next(engine: Engine) -> None:
    cancel = threading.Event()
    calls: list[str] = []

    def first(ctx: StageContext) -> dict[str, object]:
        cancel.set()  # as the heartbeat would after the user pressed Cancel
        return {}

    job_id = start(engine, "t", ["a", "b"])
    pipeline = {"t": [("a", first), ("b", recorder(calls, "b"))]}

    assert run(engine, job_id, pipeline, cancel) == "cancelled"
    assert calls == []
    assert job_row(engine, job_id).status == "cancelled"


def test_unknown_job_type_fails_cleanly(engine: Engine) -> None:
    job_id = start(engine, "mystery", ["a"])

    assert run(engine, job_id, {}) == "failed"
    assert job_row(engine, job_id).error_code == "unknown_job_type"


def test_stage_attempts_and_times_are_recorded(engine: Engine) -> None:
    job_id = start(engine, "t", ["a"])

    run(engine, job_id, {"t": [("a", recorder([], "a"))]})

    with Session(engine) as session:
        stage = session.scalars(select(JobStage).where(JobStage.job_id == job_id)).one()
    assert stage.attempts == 1
    assert stage.started_at is not None
    assert stage.finished_at is not None
    assert stage.outputs_json == {"files": 3}
