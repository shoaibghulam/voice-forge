"""Analyses: request bodies, the stored/served result, and the engine output contract.

The same models validate what the engine scripts print (never trusted as-is: bounds,
enums, list sizes) and what the API serves back from the stored JSON.
"""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

LanguageHint = Literal["auto", "bal", "ur", "fa", "en"]
Language = Literal["bal", "ur", "fa", "en"]
Note = Literal["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
SectionLabel = Literal["intro", "verse", "chorus", "instrumental", "outro"]
AudioKind = Literal["original", "vocals", "accompaniment"]

Seconds = Annotated[float, Field(ge=0, le=24 * 3600)]
Share = Annotated[float, Field(ge=0, le=1)]
Percent = Annotated[float, Field(ge=0, le=100)]
Db = Annotated[float, Field(ge=-200, le=20)]
MAX_LYRICS_CHARS = 50_000


class Strict(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False, extra="ignore")


# --- requests ------------------------------------------------------------------------


class AnalysisCreate(BaseModel):
    upload_id: Annotated[str, Field(pattern=r"^[A-Za-z0-9-]{1,64}$")]
    language: LanguageHint = "auto"


class AnalysisPatch(BaseModel):
    lyrics_text: Annotated[str, Field(max_length=MAX_LYRICS_CHARS)] | None


# --- result parts --------------------------------------------------------------------


class LyricLine(Strict):
    start: Seconds
    end: Seconds
    text: Annotated[str, Field(min_length=1, max_length=500)]


class Lyrics(Strict):
    language: Language | None
    language_probability: Share | None = None
    approximate: bool = False
    device: Literal["cuda", "cpu"] | None = None
    fallback: Annotated[str, Field(max_length=500)] | None = None  # why the GPU was not used
    note: Literal["no_singing"] | None = None
    segments: Annotated[list[LyricLine], Field(max_length=2000)]


class TagScore(Strict):
    label: Annotated[str, Field(min_length=1, max_length=60)]
    score: Share


Tags = Annotated[list[TagScore], Field(max_length=20)]


class Instruments(Strict):
    stems: dict[Literal["vocals", "drums", "bass", "other"], Percent]
    tags: Tags


class Style(Strict):
    tempo_bpm: Annotated[float, Field(ge=20, le=400)]
    tempo_confidence: Share
    key: Note
    scale: Literal["major", "minor"]
    key_confidence: Share
    loudness_dbfs: Db
    loudness_lufs: Db | None = None
    instruments: Instruments
    genre: Tags
    mood: Tags


class EngineStyle(Strict):
    """What style.py prints (flat); turned into Style by the stage."""

    tempo_bpm: Annotated[float, Field(ge=20, le=400)]
    tempo_confidence: Share
    key: Note
    scale: Literal["major", "minor"]
    key_confidence: Share
    loudness_dbfs: Db
    stems: dict[Literal["vocals", "drums", "bass", "other"], Percent]
    instrument_tags: Tags
    genre: Tags
    mood: Tags


class Section(Strict):
    start: Seconds
    end: Seconds
    label: SectionLabel
    has_vocals: bool
    vocal_share: Share = 0.0

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if self.end <= self.start:
            raise ValueError("a section must end after it starts")
        return self


class EngineSections(Strict):
    duration: Seconds
    sections: Annotated[list[Section], Field(max_length=200)]


class AnalysisResult(BaseModel):
    duration_s: float | None = None
    lyrics: Lyrics | None = None
    style: Style | None = None
    sections: list[Section] | None = None


# --- response ------------------------------------------------------------------------


class AnalysisAudio(BaseModel):
    original: str | None
    vocals: str | None
    accompaniment: str | None


class AnalysisOut(BaseModel):
    id: str
    job_id: str | None
    status: str
    original_filename: str
    created_at: str
    language_hint: str
    result: AnalysisResult
    lyrics_text: str | None
    audio: AnalysisAudio
