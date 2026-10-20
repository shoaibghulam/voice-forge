"""Covers: re-sing an uploaded song in a trained voice (docs/04 §9, docs/06 "Covers")."""

import shutil
from pathlib import Path

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError, not_found
from app.config import Settings
from app.models import Checkpoint, Cover, Job, Run, Singer
from app.schemas.pipeline import CoverAudio, CoverCreate, CoverOut
from app.services.storage import cover_dir, ready_upload, take_upload_name
from app.worker import job_queue
from app.worker.pipelines import stage_names

AUDIO_KINDS = ("mix", "mp3", "vocal", "backing", "original")


def _ready_upload(settings: Settings, upload_id: str) -> Path:
    upload = ready_upload(settings, upload_id)
    if upload is None:
        raise ApiError(404, "upload_not_found", "Upload the song first (purpose: cover).")
    take_upload_name(settings, upload_id)  # covers show no filename; don't leave it behind
    return upload


def _voice(session: Session, singer_id: str, checkpoint_id: str | None) -> Checkpoint:
    singer = session.get(Singer, singer_id)
    if singer is None:
        raise not_found("singer")
    chosen = checkpoint_id or singer.active_checkpoint_id
    ckpt = session.get(Checkpoint, chosen) if chosen else None
    run = session.get(Run, ckpt.run_id) if ckpt else None
    if ckpt is None or run is None or run.singer_id != singer_id:
        raise ApiError(422, "no_voice_model", "Train or import a voice for this singer first.")
    return ckpt


def _audio_paths(cover: Cover) -> dict[str, str | None]:
    return {
        "mix": cover.mix_path,
        "mp3": cover.mp3_path,
        "vocal": cover.vocal_path,
        "backing": cover.backing_path,
        "original": cover.input_song_path,
    }


def _cover_out(session: Session, cover: Cover) -> CoverOut:
    job = session.get(Job, cover.job_id) if cover.job_id else None
    urls = {
        kind: f"/api/covers/{cover.id}/audio/{kind}" if path and Path(path).is_file() else None
        for kind, path in _audio_paths(cover).items()
    }
    return CoverOut(
        id=cover.id,
        singer_id=cover.singer_id,
        checkpoint_id=cover.checkpoint_id,
        job_id=cover.job_id,
        status=job.status if job else "unknown",
        settings=cover.settings_json or {},
        created_at=cover.created_at,
        audio=CoverAudio(**urls),
    )


def create_cover(engine: Engine, settings: Settings, body: CoverCreate) -> CoverOut:
    upload = _ready_upload(settings, body.upload_id)
    with Session(engine) as session:
        ckpt = _voice(session, body.singer_id, body.checkpoint_id)
        cover = Cover(
            singer_id=body.singer_id,
            checkpoint_id=ckpt.id,
            input_song_path="",
            settings_json=body.settings.model_dump(),
        )
        session.add(cover)
        session.flush()
        folder = cover_dir(settings, cover.id)
        folder.mkdir(parents=True, exist_ok=True)
        song = folder / f"song{upload.suffix}"
        shutil.move(upload, song)
        cover.input_song_path = str(song)
        params: dict[str, object] = {
            "cover_id": cover.id,
            "singer_id": body.singer_id,
            "checkpoint_id": ckpt.id,
            "input_path": str(song),
            "settings": body.settings.model_dump(),
        }
        session.commit()
        cover_id = cover.id
    # Not limited to one job per singer: a cover may queue behind that singer's training.
    job_id = job_queue.enqueue(
        engine, "convert", stage_names("convert"), params=params, singer_id=body.singer_id
    )
    with Session(engine) as session:
        saved = session.get(Cover, cover_id)
        assert saved is not None  # noqa: S101 - created above in this request
        saved.job_id = job_id
        session.commit()
        return _cover_out(session, saved)


def list_covers(engine: Engine, singer_id: str | None) -> list[CoverOut]:
    query = select(Cover).order_by(Cover.created_at.desc()).limit(200)
    if singer_id:
        query = query.where(Cover.singer_id == singer_id)
    with Session(engine) as session:
        return [_cover_out(session, c) for c in session.scalars(query)]


def get_cover(engine: Engine, cover_id: str) -> CoverOut:
    with Session(engine) as session:
        cover = session.get(Cover, cover_id)
        if cover is None:
            raise not_found("cover")
        return _cover_out(session, cover)


def audio_file(engine: Engine, cover_id: str, kind: str) -> Path:
    if kind not in AUDIO_KINDS:
        raise ApiError(404, "not_found", f"Unknown audio kind '{kind}'.")
    with Session(engine) as session:
        cover = session.get(Cover, cover_id)
        if cover is None:
            raise not_found("cover")
        path = _audio_paths(cover)[kind]
    if not path or not Path(path).is_file():
        raise ApiError(404, "audio_missing", "This audio is not ready yet.")
    return Path(path)
