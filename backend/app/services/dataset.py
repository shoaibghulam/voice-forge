"""Dataset preparation and QC review (docs/04 §1-4, docs/06 "Dataset")."""

from pathlib import Path

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError, not_found
from app.models import Clip, Singer, Song
from app.schemas.jobs import JobOut
from app.schemas.pipeline import ClipOut, DatasetSummary, F0Profile
from app.services.jobs import start_job
from app.worker.stages.logic import usable_gate

VERDICT_ALIASES = {"keep": "keep", "kept": "keep", "reject": "reject", "rejected": "reject"}
ERA_DOMINANCE = 0.7
MAX_PAGE = 500


def _singer(session: Session, singer_id: str) -> Singer:
    singer = session.get(Singer, singer_id)
    if singer is None:
        raise not_found("singer")
    return singer


def prepare(engine: Engine, singer_id: str, preset: str) -> JobOut:
    with Session(engine) as session:
        _singer(session, singer_id)
        songs = session.scalar(
            select(func.count()).where(
                Song.singer_id == singer_id, Song.status.in_(("uploaded", "ready"))
            )
        )
    if not songs:
        raise ApiError(422, "no_songs", "Upload songs for this singer first.")
    return start_job(
        engine, "prepare_dataset", singer_id, {"singer_id": singer_id, "preset": preset}
    )


def kept_minutes(session: Session, singer_id: str) -> float:
    seconds = session.scalar(
        select(func.coalesce(func.sum(Clip.duration_s), 0)).where(
            Clip.singer_id == singer_id, Clip.verdict == "keep"
        )
    )
    return round(float(seconds or 0) / 60, 2)


def summary(engine: Engine, singer_id: str) -> DatasetSummary:
    with Session(engine) as session:
        singer = _singer(session, singer_id)
        rows = session.execute(
            select(Clip.verdict, Clip.reason, Clip.duration_s, Song.era)
            .join(Song, Song.id == Clip.song_id)
            .where(Clip.singer_id == singer_id)
        ).all()
        no_voice = list(
            session.scalars(
                select(Song.id).where(Song.singer_id == singer_id, Song.status == "no_voice")
            )
        )
        f0 = F0Profile(
            median_hz=singer.f0_median_hz, p05_hz=singer.f0_p05_hz, p95_hz=singer.f0_p95_hz
        )
    rejected: dict[str, int] = {}
    era_seconds: dict[str, float] = {}
    for verdict, reason, duration, era in rows:
        if verdict == "keep":
            era_seconds[era] = era_seconds.get(era, 0.0) + duration
        else:
            rejected[reason or "unknown"] = rejected.get(reason or "unknown", 0) + 1
    total = sum(era_seconds.values())
    minutes = round(total / 60, 2)
    dominant = max(era_seconds.values(), default=0.0)
    return DatasetSummary(
        usable_minutes=minutes,
        kept_clips=sum(1 for r in rows if r[0] == "keep"),
        rejected_clips=sum(1 for r in rows if r[0] != "keep"),
        rejected=rejected,
        era_minutes={era: round(s / 60, 2) for era, s in era_seconds.items()},
        era_warning=len(era_seconds) > 1 and total > 0 and dominant / total > ERA_DOMINANCE,
        gate=usable_gate(minutes),
        f0=f0,
        no_voice_songs=no_voice,
    )


def _clip_out(clip: Clip) -> ClipOut:
    return ClipOut(
        id=clip.id,
        song_id=clip.song_id,
        start_s=clip.start_s,
        duration_s=clip.duration_s,
        verdict="keep" if clip.verdict == "keep" else "reject",
        reason=clip.reason,
        user_override=clip.user_override,
        scores=clip.scores_json or {},
        audio_url=f"/api/clips/{clip.id}/audio",
    )


def list_clips(
    engine: Engine,
    singer_id: str,
    verdict: str | None,
    reason: str | None,
    limit: int,
    offset: int,
) -> list[ClipOut]:
    query = select(Clip).where(Clip.singer_id == singer_id)
    if verdict:
        if verdict not in VERDICT_ALIASES:
            raise ApiError(422, "invalid_request", "verdict must be keep or reject.")
        query = query.where(Clip.verdict == VERDICT_ALIASES[verdict])
    if reason:
        query = query.where(Clip.reason == reason)
    query = query.order_by(Clip.song_id, Clip.start_s).limit(min(limit, MAX_PAGE)).offset(offset)
    with Session(engine) as session:
        _singer(session, singer_id)
        return [_clip_out(c) for c in session.scalars(query)]


def set_verdict(engine: Engine, clip_id: str, verdict: str) -> ClipOut:
    with Session(engine) as session:
        clip = session.get(Clip, clip_id)
        if clip is None:
            raise not_found("clip")
        clip.verdict = verdict
        clip.user_override = True
        if verdict == "keep":
            clip.reason = None
        else:
            clip.reason = clip.reason or "user"
        session.commit()
        return _clip_out(clip)


def clip_file(engine: Engine, clip_id: str) -> Path:
    """Clip paths are written only by the worker, never taken from a request."""
    with Session(engine) as session:
        clip = session.get(Clip, clip_id)
        if clip is None:
            raise not_found("clip")
        path = Path(clip.path)
    if not path.is_file():
        raise ApiError(404, "audio_missing", "The clip's audio file is missing on disk.")
    return path
