"""Worker main loop: claim-and-run, crash recovery on start, heartbeat and cancel."""

import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.db import Base, make_engine
from app.models import Job
from app.worker.job_queue import claim_next, enqueue, request_cancel
from app.worker.loop import Heartbeat, recover, run_once
from app.worker.stage_runner import StageContext

PAST = "2026-01-01T00:00:00.000Z"


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    engine = make_engine(f"sqlite:///{tmp_path / 'app.db'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def status(engine: Engine, job_id: str) -> str:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        assert job is not None
        return job.status


def test_run_once_returns_none_on_an_empty_queue(engine: Engine) -> None:
    assert run_once(engine, {}) is None


def test_run_once_claims_and_runs_the_oldest_job(engine: Engine) -> None:
    job_id = enqueue(engine, "t", ["a"])

    assert run_once(engine, {"t": [("a", lambda ctx: {})]}) == job_id
    assert status(engine, job_id) == "done"


def test_recover_requeues_a_job_left_running_by_a_dead_worker(engine: Engine) -> None:
    job_id = enqueue(engine, "t", ["a"])
    claim_next(engine, worker_pid=999, now=PAST, lease_s=60)

    assert recover(engine) == [job_id]
    assert status(engine, job_id) == "queued"


def test_tick_recovers_a_job_whose_worker_died_after_this_worker_started(
    engine: Engine,
) -> None:
    """A worker restarted while a job ran: at startup the dead worker's lease had not
    expired yet, so startup recovery missed it. Every pass must look again."""
    from app.worker.loop import tick

    job_id = enqueue(engine, "t", ["a"])
    claim_next(engine, worker_pid=999, now=PAST, lease_s=60)  # lease long expired

    assert tick(engine, {"t": [("a", lambda ctx: {})]}) == job_id
    assert status(engine, job_id) == "done"


def test_heartbeat_sets_cancel_when_user_requests_it(engine: Engine) -> None:
    job_id = enqueue(engine, "t", ["a"])
    claim_next(engine, worker_pid=1, now=PAST, lease_s=3600)
    cancel = threading.Event()

    with Heartbeat(engine, job_id, cancel, interval_s=0.02):
        request_cancel(engine, job_id)
        assert cancel.wait(timeout=2)


def test_cancel_reaches_a_running_stage(engine: Engine) -> None:
    """End to end: a long stage watches ctx.cancel; the user's cancel ends the job."""

    def long_stage(ctx: StageContext) -> dict[str, object]:
        ctx.cancel.wait(timeout=10)
        return {}

    job_id = enqueue(engine, "t", ["slow", "never"])
    result: list[str | None] = []
    pipeline = {"t": [("slow", long_stage), ("never", lambda ctx: {})]}
    worker = threading.Thread(
        target=lambda: result.append(run_once(engine, pipeline, heartbeat_s=0.02))
    )
    worker.start()
    deadline = time.monotonic() + 5
    while status(engine, job_id) != "running" and time.monotonic() < deadline:
        time.sleep(0.01)
    request_cancel(engine, job_id)
    worker.join(timeout=10)

    assert result == [job_id]
    assert status(engine, job_id) == "cancelled"
