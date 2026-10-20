"""Job queue: enqueue, atomic claim with a lease, crash recovery, cancel requests."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.db import Base, make_engine
from app.models import Job, JobStage
from app.worker.job_queue import (
    claim_next,
    enqueue,
    finish_job,
    is_cancel_requested,
    renew_lease,
    request_cancel,
    requeue_expired,
)

T0 = "2026-10-19T10:00:00.000Z"
T1 = "2026-10-19T10:00:30.000Z"
T2 = "2026-10-19T10:05:00.000Z"


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    engine = make_engine(f"sqlite:///{tmp_path / 'app.db'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def get_job(engine: Engine, job_id: str) -> Job:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        assert job is not None
        return job


def stages(engine: Engine, job_id: str) -> list[tuple[str, int, str]]:
    with Session(engine) as session:
        rows = session.scalars(
            select(JobStage).where(JobStage.job_id == job_id).order_by(JobStage.position)
        )
        return [(s.name, s.position, s.status) for s in rows]


def test_enqueue_creates_queued_job_with_pending_stages(engine: Engine) -> None:
    job_id = enqueue(engine, "train", ["preprocess", "extract", "train"], params={"epochs": 50})

    job = get_job(engine, job_id)
    assert job.status == "queued"
    assert job.params_json == {"epochs": 50}
    assert stages(engine, job_id) == [
        ("preprocess", 0, "pending"),
        ("extract", 1, "pending"),
        ("train", 2, "pending"),
    ]


def test_claim_takes_oldest_queued_job_and_sets_lease(engine: Engine) -> None:
    first = enqueue(engine, "train", ["a"])
    enqueue(engine, "convert", ["a"])

    claimed = claim_next(engine, worker_pid=4242, now=T0, lease_s=60)

    assert claimed == first
    job = get_job(engine, first)
    assert job.status == "running"
    assert job.worker_pid == 4242
    assert job.lease_until == "2026-10-19T10:01:00.000Z"
    assert job.started_at == T0


def test_claim_returns_none_when_queue_is_empty(engine: Engine) -> None:
    enqueue(engine, "train", ["a"])
    claim_next(engine, worker_pid=1, now=T0, lease_s=60)

    assert claim_next(engine, worker_pid=1, now=T0, lease_s=60) is None


def test_renew_lease_extends_it(engine: Engine) -> None:
    job_id = enqueue(engine, "train", ["a"])
    claim_next(engine, worker_pid=1, now=T0, lease_s=60)

    renew_lease(engine, job_id, now=T1, lease_s=60)

    assert get_job(engine, job_id).lease_until == "2026-10-19T10:01:30.000Z"


def test_requeue_expired_recovers_jobs_of_a_dead_worker(engine: Engine) -> None:
    job_id = enqueue(engine, "train", ["a"])
    claim_next(engine, worker_pid=1, now=T0, lease_s=60)

    recovered = requeue_expired(engine, now=T2)

    assert recovered == [job_id]
    job = get_job(engine, job_id)
    assert job.status == "queued"
    assert job.resume is True
    assert job.worker_pid is None


def test_requeue_leaves_live_leases_alone(engine: Engine) -> None:
    enqueue(engine, "train", ["a"])
    claim_next(engine, worker_pid=1, now=T0, lease_s=60)

    assert requeue_expired(engine, now=T1) == []


def test_cancel_request_on_queued_job_cancels_immediately(engine: Engine) -> None:
    job_id = enqueue(engine, "train", ["a"])

    request_cancel(engine, job_id)

    assert get_job(engine, job_id).status == "cancelled"


def test_cancel_request_on_running_job_is_flagged_for_the_worker(engine: Engine) -> None:
    job_id = enqueue(engine, "train", ["a"])
    claim_next(engine, worker_pid=1, now=T0, lease_s=60)

    request_cancel(engine, job_id)

    assert get_job(engine, job_id).status == "cancelling"
    assert is_cancel_requested(engine, job_id)


def test_finish_job_records_status_error_and_clears_lease(engine: Engine) -> None:
    job_id = enqueue(engine, "train", ["a"])
    claim_next(engine, worker_pid=1, now=T0, lease_s=60)

    finish_job(engine, job_id, "failed", now=T1, error_code="cuda_oom")

    job = get_job(engine, job_id)
    assert (job.status, job.error_code, job.finished_at) == ("failed", "cuda_oom", T1)
    assert job.lease_until is None
