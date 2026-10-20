"""Singers, their uploaded songs, and the clips sliced from them."""

from sqlalchemy import JSON, Boolean, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, new_id, utc_now


class Singer(Base):
    __tablename__ = "singers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120))
    consent_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    # no FK: checkpoints reference runs which reference singers; a cycle here would
    # force deferred constraints in SQLite. The service layer validates it instead.
    active_checkpoint_id: Mapped[str | None] = mapped_column(String(36))
    f0_median_hz: Mapped[float | None] = mapped_column(Float)
    f0_p05_hz: Mapped[float | None] = mapped_column(Float)
    f0_p95_hz: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)
    updated_at: Mapped[str] = mapped_column(String(32), default=utc_now, onupdate=utc_now)


class Song(Base):
    __tablename__ = "songs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    singer_id: Mapped[str] = mapped_column(ForeignKey("singers.id", ondelete="CASCADE"), index=True)
    original_filename: Mapped[str] = mapped_column(String(255))  # display only, never a path
    stored_path: Mapped[str] = mapped_column(String(512))
    duration_s: Mapped[float | None] = mapped_column(Float)
    codec: Mapped[str | None] = mapped_column(String(32))
    bitrate: Mapped[int | None] = mapped_column(Integer)
    era: Mapped[str] = mapped_column(String(16), default="unknown")
    fingerprint: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String(16), default="uploaded")
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)


class Clip(Base):
    __tablename__ = "clips"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    singer_id: Mapped[str] = mapped_column(ForeignKey("singers.id", ondelete="CASCADE"), index=True)
    song_id: Mapped[str] = mapped_column(ForeignKey("songs.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(String(512))
    start_s: Mapped[float] = mapped_column(Float)
    duration_s: Mapped[float] = mapped_column(Float)
    verdict: Mapped[str] = mapped_column(String(8), default="keep")
    reason: Mapped[str | None] = mapped_column(String(32))
    user_override: Mapped[bool] = mapped_column(Boolean, default=False)
    scores_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)
