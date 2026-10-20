"""Jobs, their stages, and the append-only event log the SSE stream replays."""

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, new_id, utc_now


class Job(Base):
    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    type: Mapped[str] = mapped_column(String(24))
    singer_id: Mapped[str | None] = mapped_column(
        ForeignKey("singers.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="queued", index=True)
    params_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    resume: Mapped[bool] = mapped_column(Boolean, default=False)
    lease_until: Mapped[str | None] = mapped_column(String(32))
    worker_pid: Mapped[int | None] = mapped_column(Integer)
    error_code: Mapped[str | None] = mapped_column(String(48))
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)
    started_at: Mapped[str | None] = mapped_column(String(32))
    finished_at: Mapped[str | None] = mapped_column(String(32))


class JobStage(Base):
    __tablename__ = "job_stages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(32))
    position: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    started_at: Mapped[str | None] = mapped_column(String(32))
    finished_at: Mapped[str | None] = mapped_column(String(32))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    outputs_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)


class JobEvent(Base):
    """One SSE event. `seq` is the SSE id; the browser resumes with Last-Event-ID."""

    __tablename__ = "job_events"
    __table_args__ = (Index("ix_job_events_job_id_seq", "job_id", "seq"),)

    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    ts: Mapped[str] = mapped_column(String(32), default=utc_now)
    type: Mapped[str] = mapped_column(String(32))
    stage: Mapped[str | None] = mapped_column(String(32))
    payload_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
