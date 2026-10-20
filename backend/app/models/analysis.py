"""Song analyses: lyrics, musical style and the song's timeline (docs/04 §12)."""

from sqlalchemy import JSON, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, new_id, utc_now


class Analysis(Base):
    __tablename__ = "analyses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    job_id: Mapped[str | None] = mapped_column(ForeignKey("jobs.id", ondelete="SET NULL"))
    original_filename: Mapped[str] = mapped_column(String(255))  # display only, never a path
    input_path: Mapped[str] = mapped_column(String(512))
    language_hint: Mapped[str] = mapped_column(String(8), default="auto")
    # Filled stage by stage: duration_s, lyrics, style, sections (schemas/analysis.py).
    result_json: Mapped[dict[str, object]] = mapped_column(JSON, default=dict)
    lyrics_text: Mapped[str | None] = mapped_column(Text)  # the user's corrected lyrics
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now)
