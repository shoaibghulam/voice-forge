"""Read side of the job event log, used by the SSE stream."""

from dataclasses import dataclass

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.models import Job, JobEvent

TERMINAL_STATUSES = frozenset({"done", "failed", "cancelled"})
EVENT_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class EventEnvelope:
    seq: int
    type: str
    body: dict[str, object]  # the full v1 envelope sent as SSE data


def job_status(engine: Engine, job_id: str) -> str | None:
    """The job's status, or None when there is no such job."""
    with Session(engine) as session:
        return session.scalar(select(Job.status).where(Job.id == job_id))


def events_after(
    engine: Engine, job_id: str, after_seq: int, limit: int = 500
) -> list[EventEnvelope]:
    with Session(engine) as session:
        rows = session.scalars(
            select(JobEvent)
            .where(JobEvent.job_id == job_id, JobEvent.seq > after_seq)
            .order_by(JobEvent.seq)
            .limit(limit)
        ).all()
        return [
            EventEnvelope(
                seq=row.seq,
                type=row.type,
                body={
                    "v": EVENT_SCHEMA_VERSION,
                    "seq": row.seq,
                    "job_id": row.job_id,
                    "ts": row.ts,
                    "type": row.type,
                    "stage": row.stage,
                    "data": row.payload_json,
                },
            )
            for row in rows
        ]
