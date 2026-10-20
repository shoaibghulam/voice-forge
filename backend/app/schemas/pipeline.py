"""Request and response models for datasets, training runs, checkpoints and covers."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.schemas.jobs import JobOut

Preset = Literal["cassette", "studio", "live"]
Verdict = Literal["keep", "reject"]
Reverb = Literal["none", "light", "medium", "heavy"]


class PrepareBody(BaseModel):
    preset: Preset = "cassette"


class ClipOut(BaseModel):
    id: str
    song_id: str
    start_s: float
    duration_s: float
    verdict: Verdict
    reason: str | None
    user_override: bool
    scores: dict[str, object]
    audio_url: str


class ClipVerdictBody(BaseModel):
    verdict: Verdict


class F0Profile(BaseModel):
    median_hz: float | None
    p05_hz: float | None
    p95_hz: float | None


class DatasetSummary(BaseModel):
    usable_minutes: float
    kept_clips: int
    rejected_clips: int
    rejected: dict[str, int]
    era_minutes: dict[str, float]
    era_warning: bool
    gate: str | None
    f0: F0Profile
    no_voice_songs: list[str]


class TrainBody(BaseModel):
    epochs: Annotated[int, Field(ge=5, le=1000)] = 100
    batch_size: Annotated[int, Field(ge=1, le=16)] = 4
    save_every: Annotated[int, Field(ge=1, le=50)] = 5
    sample_rate: Literal[32000, 40000, 48000] = 40000
    vocoder: Literal["HiFi-GAN", "RefineGAN", "MRF HiFi-GAN"] = "HiFi-GAN"


class RunOut(BaseModel):
    id: str
    singer_id: str
    job_id: str | None
    status: str
    config: dict[str, object]
    applio_commit: str
    created_at: str
    checkpoint_count: int


class CheckpointOut(BaseModel):
    id: str
    run_id: str
    epoch: int
    step: int
    mel_loss: float | None
    similarity: float | None
    recommended: bool
    has_sample: bool
    sample_url: str | None
    active: bool
    created_at: str


class TrainStarted(BaseModel):
    job: JobOut
    run: RunOut


class ImportedVoice(BaseModel):
    run: RunOut
    checkpoint: CheckpointOut


class CoverSettings(BaseModel):
    octave_auto: bool = True
    semitones: Annotated[int, Field(ge=-24, le=24)] = 0
    timbre_strength: Annotated[float, Field(ge=0, le=1)] = 0.4
    protect: Annotated[float, Field(ge=0, le=0.5)] = 0.4
    vocal_level: Annotated[float, Field(ge=0, le=2)] = 1.0
    reverb: Reverb = "light"


class CoverCreate(BaseModel):
    upload_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9-]{1,64}$")]
    singer_id: str
    checkpoint_id: str | None = None
    settings: CoverSettings = CoverSettings()


class CoverAudio(BaseModel):
    mix: str | None
    mp3: str | None
    vocal: str | None
    backing: str | None
    original: str | None


class CoverOut(BaseModel):
    id: str
    singer_id: str
    checkpoint_id: str | None
    job_id: str | None
    status: str
    settings: dict[str, object]
    created_at: str
    audio: CoverAudio
