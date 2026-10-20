"""Analyses: lyrics and musical style of an uploaded song (docs/04 §12, docs/06 "Analyses").

Folder data/analyses/<id>/: input.<ext> (the upload), song.wav, vocals.wav,
accompaniment.wav, stems/accompaniment~{drums,bass,other,vocals}.wav. The result is
filled stage by stage in the analyses row; each stored part is re-validated when served,
so a corrupt part is dropped instead of breaking the page.
"""

import re
import shutil
from pathlib import Path
from typing import Any
from urllib.parse import quote

from pydantic import BaseModel, TypeAdapter, ValidationError
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError, not_found
from app.config import Settings
from app.models import Analysis, Job
from app.schemas.analysis import (
    AnalysisAudio,
    AnalysisCreate,
    AnalysisOut,
    AnalysisPatch,
    AnalysisResult,
    Lyrics,
    Section,
    Style,
)
from app.services.storage import analysis_dir, ready_upload, take_upload_name
from app.worker import job_queue
from app.worker.pipelines import stage_names

AUDIO_FILES = {"vocals": "vocals.wav", "accompaniment": "accompaniment.wav"}
_SECTIONS = TypeAdapter(list[Section])
_SAFE_NAME = re.compile(r"[^A-Za-z0-9 _().-]+")


def analysis_folder(settings: Settings, analysis_id: str) -> Path:
    return analysis_dir(settings, analysis_id)


def _part(model: type[BaseModel], raw: object) -> Any:
    if raw is None:
        return None
    try:
        return model.model_validate(raw)
    except ValidationError:
        return None


def _result(raw: dict[str, Any] | None) -> AnalysisResult:
    data = raw or {}
    try:
        sections = _SECTIONS.validate_python(data["sections"]) if data.get("sections") else None
    except ValidationError:
        sections = None
    duration = data.get("duration_s")
    return AnalysisResult(
        duration_s=float(duration) if isinstance(duration, int | float) else None,
        lyrics=_part(Lyrics, data.get("lyrics")),
        style=_part(Style, data.get("style")),
        sections=sections,
    )


def _audio_paths(row: Analysis) -> dict[str, Path]:
    original = Path(row.input_path)
    return {
        "original": original,
        **{kind: original.parent / name for kind, name in AUDIO_FILES.items()},
    }


def _out(session: Session, row: Analysis) -> AnalysisOut:
    job = session.get(Job, row.job_id) if row.job_id else None
    urls = {
        kind: f"/api/analyses/{row.id}/audio/{kind}" if path.is_file() else None
        for kind, path in _audio_paths(row).items()
    }
    return AnalysisOut(
        id=row.id,
        job_id=row.job_id,
        status=job.status if job else "unknown",
        original_filename=row.original_filename,
        created_at=row.created_at,
        language_hint=row.language_hint,
        result=_result(row.result_json),
        lyrics_text=row.lyrics_text,
        audio=AnalysisAudio(**urls),
    )


def create_analysis(engine: Engine, settings: Settings, body: AnalysisCreate) -> AnalysisOut:
    upload = ready_upload(settings, body.upload_id)
    if upload is None:
        raise ApiError(404, "upload_not_found", "Upload the song first (purpose: analysis).")
    filename = take_upload_name(settings, body.upload_id) or f"song{upload.suffix}"
    with Session(engine) as session:
        row = Analysis(original_filename=filename, input_path="", language_hint=body.language)
        session.add(row)
        session.flush()
        folder = analysis_dir(settings, row.id)
        folder.mkdir(parents=True, exist_ok=True)
        song = folder / f"input{upload.suffix}"
        shutil.move(upload, song)
        row.input_path = str(song)
        params: dict[str, object] = {
            "analysis_id": row.id,
            "input_path": str(song),
            "language": body.language,
        }
        session.commit()
        analysis_id = row.id
    job_id = job_queue.enqueue(engine, "analyze", stage_names("analyze"), params=params)
    with Session(engine) as session:
        saved = session.get(Analysis, analysis_id)
        assert saved is not None  # noqa: S101 - created above in this request
        saved.job_id = job_id
        session.commit()
        return _out(session, saved)


def _get(session: Session, analysis_id: str) -> Analysis:
    row = session.get(Analysis, analysis_id)
    if row is None:
        raise not_found("analysis")
    return row


def list_analyses(engine: Engine) -> list[AnalysisOut]:
    query = select(Analysis).order_by(Analysis.created_at.desc(), Analysis.id.desc()).limit(200)
    with Session(engine) as session:
        return [_out(session, row) for row in session.scalars(query)]


def get_analysis(engine: Engine, analysis_id: str) -> AnalysisOut:
    with Session(engine) as session:
        return _out(session, _get(session, analysis_id))


def update_lyrics(engine: Engine, analysis_id: str, body: AnalysisPatch) -> AnalysisOut:
    with Session(engine) as session:
        row = _get(session, analysis_id)
        row.lyrics_text = body.lyrics_text
        session.commit()
        return _out(session, row)


def audio_file(engine: Engine, analysis_id: str, kind: str) -> Path:
    with Session(engine) as session:
        paths = _audio_paths(_get(session, analysis_id))
    if kind not in paths:
        raise ApiError(404, "not_found", f"Unknown audio kind '{kind}'.")
    if not paths[kind].is_file():
        raise ApiError(404, "audio_missing", "This audio is not ready yet.")
    return paths[kind]


def _lyrics_text(analysis: AnalysisOut) -> str:
    if analysis.lyrics_text is not None:
        text = analysis.lyrics_text.rstrip()
    elif analysis.result.lyrics is not None:
        text = "\n".join(line.text for line in analysis.result.lyrics.segments)
    else:
        text = ""
    return f"{text}\n" if text else ""


def _disposition(original_filename: str, suffix: str) -> str:
    stem = Path(original_filename).stem or "analysis"
    ascii_name = _SAFE_NAME.sub("", stem).strip() or "analysis"
    return (
        f'attachment; filename="{ascii_name} {suffix}"; '
        f"filename*=UTF-8''{quote(f'{stem} {suffix}')}"
    )


def export(engine: Engine, analysis_id: str, fmt: str) -> tuple[str, str, str]:
    """(body, media type, Content-Disposition) for a download of the analysis."""
    analysis = get_analysis(engine, analysis_id)
    if fmt == "json":
        body = analysis.model_dump_json(indent=2)
        return body, "application/json", _disposition(analysis.original_filename, "analysis.json")
    disposition = _disposition(analysis.original_filename, "lyrics.txt")
    return _lyrics_text(analysis), "text/plain; charset=utf-8", disposition
