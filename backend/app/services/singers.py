"""Singer and song operations. Returns API schemas; raises ApiError for expected failures."""

from sqlalchemy import Engine, delete, func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError, not_found
from app.config import Settings
from app.models import Checkpoint, Clip, Job, Run, Singer, Song
from app.schemas.library import Consent, SingerCreate, SingerOut, SingerUpdate, SongOut
from app.services.storage import remove_tree, singer_dir, stems_dir

ACTIVE_JOB = ("queued", "running", "cancelling")


def _model_count(session: Session, singer_id: str) -> int:
    runs_with_voice = (
        select(func.count(func.distinct(Run.id)))
        .join(Checkpoint, Checkpoint.run_id == Run.id)
        .where(Run.singer_id == singer_id)
    )
    return int(session.scalar(runs_with_voice) or 0)


def _voice_label(session: Session, singer: Singer) -> str | None:
    """'run 2 · epoch 40' - runs numbered in creation order; imports say 'imported'."""
    if not singer.active_checkpoint_id:
        return None
    ckpt = session.get(Checkpoint, singer.active_checkpoint_id)
    run = session.get(Run, ckpt.run_id) if ckpt else None
    if ckpt is None or run is None:
        return None
    if run.status == "imported":
        return f"imported · epoch {ckpt.epoch}"
    earlier = session.scalar(
        select(func.count()).where(Run.singer_id == singer.id, Run.created_at <= run.created_at)
    )
    return f"run {earlier or 1} · epoch {ckpt.epoch}"


def _singer_out(session: Session, singer: Singer) -> SingerOut:
    songs = session.scalar(select(func.count()).where(Song.singer_id == singer.id)) or 0
    kept = session.scalar(
        select(func.coalesce(func.sum(Clip.duration_s), 0)).where(
            Clip.singer_id == singer.id, Clip.verdict == "keep"
        )
    )
    last_status = session.scalar(
        select(Job.status).where(Job.singer_id == singer.id).order_by(Job.created_at.desc())
    )
    return SingerOut(
        id=singer.id,
        name=singer.name,
        consent=Consent.model_validate(singer.consent_json or {}),
        song_count=songs,
        usable_minutes=round(float(kept or 0) / 60, 2),
        active_checkpoint_id=singer.active_checkpoint_id,
        active_voice_label=_voice_label(session, singer),
        model_count=_model_count(session, singer.id),
        f0_median_hz=singer.f0_median_hz,
        last_job_status=last_status,
        created_at=singer.created_at,
    )


def _get(session: Session, singer_id: str) -> Singer:
    singer = session.get(Singer, singer_id)
    if singer is None:
        raise not_found("singer")
    return singer


def list_singers(engine: Engine) -> list[SingerOut]:
    with Session(engine) as session:
        singers = session.scalars(select(Singer).order_by(Singer.created_at.desc()))
        return [_singer_out(session, s) for s in singers]


def get_singer(engine: Engine, singer_id: str) -> SingerOut:
    with Session(engine) as session:
        return _singer_out(session, _get(session, singer_id))


def create_singer(engine: Engine, body: SingerCreate) -> SingerOut:
    with Session(engine) as session:
        singer = Singer(name=body.name, consent_json=body.consent.model_dump())
        session.add(singer)
        session.commit()
        return _singer_out(session, singer)


def update_singer(engine: Engine, singer_id: str, body: SingerUpdate) -> SingerOut:
    with Session(engine) as session:
        singer = _get(session, singer_id)
        if body.name is not None:
            singer.name = body.name
        if body.consent is not None:
            singer.consent_json = body.consent.model_dump()
        session.commit()
        return _singer_out(session, singer)


def delete_singer(engine: Engine, settings: Settings, singer_id: str) -> None:
    with Session(engine) as session:
        singer = _get(session, singer_id)
        busy = session.scalar(
            select(func.count()).where(Job.singer_id == singer_id, Job.status.in_(ACTIVE_JOB))
        )
        if busy:
            raise ApiError(409, "singer_busy", "A job is queued or running for this singer.")
        session.delete(singer)
        session.commit()
    remove_tree(singer_dir(settings, singer_id), settings)


def _song_out(song: Song) -> SongOut:
    return SongOut.model_validate(song, from_attributes=True)


def list_songs(engine: Engine, singer_id: str) -> list[SongOut]:
    with Session(engine) as session:
        _get(session, singer_id)
        songs = session.scalars(
            select(Song).where(Song.singer_id == singer_id).order_by(Song.created_at)
        )
        return [_song_out(s) for s in songs]


def update_song_era(engine: Engine, song_id: str, era: str) -> SongOut:
    with Session(engine) as session:
        song = session.get(Song, song_id)
        if song is None:
            raise not_found("song")
        song.era = era
        session.commit()
        return _song_out(song)


def delete_song(engine: Engine, settings: Settings, song_id: str) -> None:
    with Session(engine) as session:
        song = session.get(Song, song_id)
        if song is None:
            raise not_found("song")
        singer_id = song.singer_id
        session.execute(delete(Clip).where(Clip.song_id == song_id))
        session.delete(song)
        session.commit()
    remove_tree(stems_dir(settings, singer_id, song_id), settings)
    folder = singer_dir(settings, singer_id) / "songs"
    for file in folder.glob(f"{song_id}.*"):
        file.unlink(missing_ok=True)
