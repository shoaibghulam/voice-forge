"""Request and response models for singers and songs."""

from typing import Annotated, Literal

from pydantic import BaseModel, StringConstraints

Era = Literal["cassette", "vinyl", "studio", "live", "unknown"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class Consent(BaseModel):
    living_consent: bool = False
    estate_permission: bool = False
    notes: Annotated[str, StringConstraints(max_length=2000)] = ""


class SingerCreate(BaseModel):
    name: Name
    consent: Consent = Consent()


class SingerUpdate(BaseModel):
    name: Name | None = None
    consent: Consent | None = None


class SingerOut(BaseModel):
    id: str
    name: str
    consent: Consent
    song_count: int
    usable_minutes: float
    active_checkpoint_id: str | None
    active_voice_label: str | None  # e.g. "run 2 · epoch 40", or "imported · epoch 50"
    model_count: int  # training runs (incl. imports) that produced at least one voice
    f0_median_hz: float | None
    last_job_status: str | None
    created_at: str


class SongOut(BaseModel):
    id: str
    singer_id: str
    original_filename: str
    duration_s: float | None
    codec: str | None
    bitrate: int | None
    era: Era
    status: str
    created_at: str


class SongUpdate(BaseModel):
    era: Era
