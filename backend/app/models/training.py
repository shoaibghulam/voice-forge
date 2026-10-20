"""Training runs, their checkpoints, conversions (covers), and benchmark results."""

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, new_id, utc_now


class Run(Base):
    __tablename__ = "runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    singer_id: Mapped[str] = mapped_column(ForeignKey("singers.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    config_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    applio_commit: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(16), default="queued")
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)


class Checkpoint(Base):
    __tablename__ = "checkpoints"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    epoch: Mapped[int] = mapped_column(Integer)
    step: Mapped[int] = mapped_column(Integer)
    model_path: Mapped[str] = mapped_column(String(512))
    sample_path: Mapped[str | None] = mapped_column(String(512))
    mel_loss: Mapped[float | None] = mapped_column(Float)
    similarity: Mapped[float | None] = mapped_column(Float)
    f0_rmse_cents: Mapped[float | None] = mapped_column(Float)
    recommended: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)


class Cover(Base):
    __tablename__ = "covers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    singer_id: Mapped[str] = mapped_column(ForeignKey("singers.id", ondelete="CASCADE"), index=True)
    checkpoint_id: Mapped[str | None] = mapped_column(
        ForeignKey("checkpoints.id", ondelete="SET NULL")
    )
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    input_song_path: Mapped[str] = mapped_column(String(512))
    settings_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    mix_path: Mapped[str | None] = mapped_column(String(512))
    mp3_path: Mapped[str | None] = mapped_column(String(512))
    vocal_path: Mapped[str | None] = mapped_column(String(512))
    backing_path: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)


class Benchmark(Base):
    __tablename__ = "benchmarks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    item: Mapped[str] = mapped_column(String(120))
    settings_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    peak_vram_mb: Mapped[int] = mapped_column(Integer)
    seconds: Mapped[float] = mapped_column(Float)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)
