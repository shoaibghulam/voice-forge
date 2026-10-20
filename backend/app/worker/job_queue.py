"""The GPU job queue, kept in SQLite (docs/03 "Queue and leases").

One worker process claims one job at a time. A claim is a single atomic UPDATE of the
oldest queued row, so two workers (or a restarted one racing its predecessor) can never
take the same job. The claim carries a lease the worker renews while it runs; a lease
that expires means the worker died, and `requeue_expired` puts the job back with
`resume=True` so it restarts from its first unfinished stage.

Statuses: queued -> running -> done | failed | cancelled, with `cancelling` in between
when a cancel is requested while the worker is mid-stage (the worker owns the kill).
All timestamps are ISO-8601 UTC strings with a Z, which compare correctly as text.
"""

from collections.abc import Sequence
from datetime import datetime, timedelta

from sqlalchemy import Engine, insert, select, update

from app.db import new_id, utc_now
from app.models import Job, JobStage

TERMINAL = ("done", "failed", "cancelled", "paused")
RESUMABLE = ("failed", "cancelled", "paused")


def _plus_seconds(stamp: str, seconds: float) -> str:
    moment = datetime.fromisoformat(stamp) + timedelta(seconds=seconds)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def enqueue(
    engine: Engine,
    job_type: str,
    stage_names: Sequence[str],
    params: dict[str, object] | None = None,
    singer_id: str | None = None,
) -> str:
    job_id = new_id()
    stage_rows = [
        {
            "id": new_id(),
            "job_id": job_id,
            "name": name,
            "position": position,
            "status": "pending",
            "attempts": 0,
            "outputs_json": {},
        }
        for position, name in enumerate(stage_names)
    ]
    with engine.begin() as conn:
        conn.execute(
            insert(Job).values(
                id=job_id,
                type=job_type,
                singer_id=singer_id,
                status="queued",
                params_json=params or {},
                resume=False,
                created_at=utc_now(),
            )
        )
        conn.execute(insert(JobStage), stage_rows)
    return job_id


def claim_next(engine: Engine, worker_pid: int, now: str, lease_s: float) -> str | None:
    """Atomically take the oldest queued job; None when the queue is empty."""
    oldest = (
        select(Job.id)
        .where(Job.status == "queued")
        .order_by(Job.created_at, Job.id)
        .limit(1)
        .scalar_subquery()
    )
    statement = (
        update(Job)
        .where(Job.id == oldest, Job.status == "queued")
        .values(
            status="running",
            worker_pid=worker_pid,
            lease_until=_plus_seconds(now, lease_s),
            started_at=now,
        )
        .returning(Job.id)
    )
    with engine.begin() as conn:
        return conn.execute(statement).scalar_one_or_none()


def renew_lease(engine: Engine, job_id: str, now: str, lease_s: float) -> None:
    with engine.begin() as conn:
        conn.execute(
            update(Job)
            .where(Job.id == job_id, Job.status.in_(("running", "cancelling", "pausing")))
            .values(lease_until=_plus_seconds(now, lease_s))
        )


def requeue_expired(engine: Engine, now: str) -> list[str]:
    """Recover jobs whose worker stopped renewing its lease (crash, kill, sleep).

    A job that died while being cancelled is simply cancelled; a running one is queued
    again with resume=True.
    """
    with engine.begin() as conn:
        conn.execute(
            update(Job)
            .where(Job.status == "cancelling", Job.lease_until < now)
            .values(status="cancelled", lease_until=None, worker_pid=None, finished_at=now)
        )
        conn.execute(
            update(Job)
            .where(Job.status == "pausing", Job.lease_until < now)
            .values(status="paused", lease_until=None, worker_pid=None, finished_at=now)
        )
        recovered = conn.execute(
            update(Job)
            .where(Job.status == "running", Job.lease_until < now)
            .values(status="queued", resume=True, lease_until=None, worker_pid=None)
            .returning(Job.id)
        )
        return list(recovered.scalars())


def request_cancel(engine: Engine, job_id: str) -> None:
    """Queued jobs cancel at once; running ones are flagged and the worker kills them."""
    with engine.begin() as conn:
        conn.execute(
            update(Job)
            .where(Job.id == job_id, Job.status == "queued")
            .values(status="cancelled", finished_at=utc_now())
        )
        conn.execute(
            update(Job).where(Job.id == job_id, Job.status == "running").values(status="cancelling")
        )


def request_pause(engine: Engine, job_id: str) -> bool:
    """Flag a running job to stop after its next checkpoint; False if it is not running."""
    with engine.begin() as conn:
        result = conn.execute(
            update(Job).where(Job.id == job_id, Job.status == "running").values(status="pausing")
        )
    return result.rowcount == 1


def job_status(engine: Engine, job_id: str) -> str | None:
    with engine.connect() as conn:
        return conn.execute(select(Job.status).where(Job.id == job_id)).scalar_one_or_none()


def is_cancel_requested(engine: Engine, job_id: str) -> bool:
    return job_status(engine, job_id) == "cancelling"


def resume_job(engine: Engine, job_id: str) -> bool:
    """Queue a failed, cancelled or paused job again; finished stages are kept."""
    with engine.begin() as conn:
        result = conn.execute(
            update(Job)
            .where(Job.id == job_id, Job.status.in_(RESUMABLE))
            .values(status="queued", resume=True, error_code=None, finished_at=None)
        )
        if result.rowcount != 1:
            return False
        conn.execute(
            update(JobStage)
            .where(JobStage.job_id == job_id, JobStage.status != "done")
            .values(status="pending")
        )
    return True


def finish_job(
    engine: Engine, job_id: str, status: str, now: str, error_code: str | None = None
) -> None:
    if status not in TERMINAL:
        raise ValueError(f"not a terminal status: {status}")
    with engine.begin() as conn:
        conn.execute(
            update(Job)
            .where(Job.id == job_id)
            .values(
                status=status,
                error_code=error_code,
                finished_at=now,
                lease_until=None,
                worker_pid=None,
            )
        )
