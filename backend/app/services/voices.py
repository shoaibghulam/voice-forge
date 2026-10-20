"""Training runs, checkpoints, and voice zips (docs/04 §6-8, docs/06 "Training and models")."""

import io
import json
import re
import shutil
import zipfile
from pathlib import Path, PurePosixPath, PureWindowsPath

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError, not_found
from app.config import Settings
from app.models import Checkpoint, Clip, Run, Singer
from app.schemas.library import SingerOut
from app.schemas.pipeline import CheckpointOut, ImportedVoice, RunOut, TrainBody, TrainStarted
from app.services import singers as singer_service
from app.services.dataset import kept_minutes
from app.services.jobs import start_job
from app.services.storage import run_dir
from app.worker.stages.logic import usable_gate

MAX_VOICE_FILE = 600 * 2**20
CHECKPOINT_NAME = re.compile(r"_(\d+)e_(\d+)s\.pth$")


def _run_out(session: Session, run: Run) -> RunOut:
    count = session.scalar(select(func.count()).where(Checkpoint.run_id == run.id)) or 0
    return RunOut(
        id=run.id,
        singer_id=run.singer_id,
        job_id=run.job_id,
        status=run.status,
        config=run.config_json or {},
        applio_commit=run.applio_commit,
        created_at=run.created_at,
        checkpoint_count=count,
    )


def _ckpt_out(ckpt: Checkpoint, active_id: str | None) -> CheckpointOut:
    has_sample = bool(ckpt.sample_path) and Path(str(ckpt.sample_path)).is_file()
    return CheckpointOut(
        id=ckpt.id,
        run_id=ckpt.run_id,
        epoch=ckpt.epoch,
        step=ckpt.step,
        mel_loss=ckpt.mel_loss,
        similarity=ckpt.similarity,
        recommended=ckpt.recommended,
        has_sample=has_sample,
        sample_url=f"/api/checkpoints/{ckpt.id}/sample" if has_sample else None,
        active=ckpt.id == active_id,
        created_at=ckpt.created_at,
    )


def _singer(session: Session, singer_id: str) -> Singer:
    singer = session.get(Singer, singer_id)
    if singer is None:
        raise not_found("singer")
    return singer


def start_training(engine: Engine, singer_id: str, body: TrainBody) -> TrainStarted:
    with Session(engine) as session:
        _singer(session, singer_id)
        has_clips = session.scalar(select(func.count()).where(Clip.singer_id == singer_id))
        minutes = kept_minutes(session, singer_id)
        if not has_clips:
            raise ApiError(422, "dataset_not_prepared", "Prepare the dataset before training.")
        if usable_gate(minutes) == "dataset_too_small":
            raise ApiError(
                422,
                "dataset_too_small",
                f"Only {minutes} minutes of usable singing; at least 5 are needed.",
                {"usable_minutes": minutes},
            )
        run = Run(singer_id=singer_id, config_json=body.model_dump(), applio_commit="pending")
        session.add(run)
        session.commit()
        run_id = run.id
    try:
        job = start_job(
            engine,
            "train",
            singer_id,
            {"singer_id": singer_id, "run_id": run_id, **body.model_dump()},
        )
    except ApiError:
        with Session(engine) as session:
            session.delete(session.get(Run, run_id))
            session.commit()
        raise
    with Session(engine) as session:
        saved = session.get(Run, run_id)
        assert saved is not None  # noqa: S101 - created above in this request
        saved.job_id = job.id
        session.commit()
        return TrainStarted(job=job, run=_run_out(session, saved))


def list_runs(engine: Engine, singer_id: str) -> list[RunOut]:
    with Session(engine) as session:
        _singer(session, singer_id)
        runs = session.scalars(
            select(Run).where(Run.singer_id == singer_id).order_by(Run.created_at.desc())
        )
        return [_run_out(session, r) for r in runs]


def get_run(engine: Engine, run_id: str) -> RunOut:
    with Session(engine) as session:
        run = session.get(Run, run_id)
        if run is None:
            raise not_found("run")
        return _run_out(session, run)


def list_checkpoints(engine: Engine, run_id: str) -> list[CheckpointOut]:
    with Session(engine) as session:
        run = session.get(Run, run_id)
        if run is None:
            raise not_found("run")
        active = _singer(session, run.singer_id).active_checkpoint_id
        ckpts = session.scalars(
            select(Checkpoint).where(Checkpoint.run_id == run_id).order_by(Checkpoint.epoch)
        )
        return [_ckpt_out(c, active) for c in ckpts]


def _checkpoint(session: Session, checkpoint_id: str) -> Checkpoint:
    ckpt = session.get(Checkpoint, checkpoint_id)
    if ckpt is None:
        raise not_found("checkpoint")
    return ckpt


def select_checkpoint(engine: Engine, checkpoint_id: str) -> SingerOut:
    with Session(engine) as session:
        ckpt = _checkpoint(session, checkpoint_id)
        run = session.get(Run, ckpt.run_id)
        if run is None:
            raise not_found("run")
        singer = _singer(session, run.singer_id)
        singer.active_checkpoint_id = ckpt.id
        session.commit()
        singer_id = singer.id
    return singer_service.get_singer(engine, singer_id)


def sample_file(engine: Engine, checkpoint_id: str) -> Path:
    with Session(engine) as session:
        path = _checkpoint(session, checkpoint_id).sample_path
    if not path or not Path(path).is_file():
        raise ApiError(404, "audio_missing", "This checkpoint has no audio sample.")
    return Path(path)


def export_zip(engine: Engine, checkpoint_id: str) -> tuple[bytes, str]:
    """The voice as a zip: the exported .pth, its .index, and profile.json."""
    with Session(engine) as session:
        ckpt = _checkpoint(session, checkpoint_id)
        run = session.get(Run, ckpt.run_id)
        singer = _singer(session, run.singer_id) if run else None
        model = Path(ckpt.model_path)
        fallback = {
            "f0_median_hz": singer.f0_median_hz if singer else None,
            "epochs": ckpt.epoch,
            "sample_rate": (run.config_json or {}).get("sample_rate", 40000) if run else 40000,
        }
        name = re.sub(r"[^A-Za-z0-9_-]+", "_", singer.name if singer else "voice").strip("_")
    if not model.is_file():
        raise ApiError(404, "model_missing", "The voice file is missing on disk.")
    profile_file = model.parent.parent.parent / "profile.json"
    profile = (
        profile_file.read_text(encoding="utf-8")
        if profile_file.is_file()
        else json.dumps(fallback, indent=2)
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.write(model, model.name)
        for index in model.parent.glob("*.index"):
            archive.write(index, index.name)
        archive.writestr("profile.json", profile)
    return buffer.getvalue(), f"{name or 'voice'}_e{ckpt.epoch}_voice.zip"


MAX_MEMBERS = 8
MAX_TOTAL_UNCOMPRESSED = 1536 * 2**20
UNSAFE_CHARS = ("\\", ":", "\x00")  # backslash, drive colon, NUL


def _safe_members(archive: zipfile.ZipFile) -> dict[str, zipfile.ZipInfo]:
    """Member name -> info, refusing traversal, odd characters, and zip bombs.

    Names are only ever used to classify members; nothing is written under them.
    """
    infos = [info for info in archive.infolist() if not info.is_dir()]
    if len(infos) > MAX_MEMBERS:
        raise ApiError(422, "invalid_voice_zip", f"A voice zip holds at most {MAX_MEMBERS} files.")
    if sum(info.file_size for info in infos) > MAX_TOTAL_UNCOMPRESSED:
        raise ApiError(422, "invalid_voice_zip", "The zip unpacks to more than 1.5 GB.")
    members: dict[str, zipfile.ZipInfo] = {}
    for info in infos:
        name = info.filename
        posix = PurePosixPath(name)
        unsafe = any(c in name for c in UNSAFE_CHARS) or ".." in posix.parts
        if unsafe or posix.is_absolute() or PureWindowsPath(name).drive:
            raise ApiError(422, "invalid_voice_zip", "The zip contains unsafe paths.")
        if info.file_size > MAX_VOICE_FILE:
            raise ApiError(422, "invalid_voice_zip", f"{posix.name} is too large.")
        members[posix.name] = info
    return members


def _classify(members: dict[str, zipfile.ZipInfo]) -> tuple[str, list[str]]:
    models = [n for n in members if n.lower().endswith(".pth") and not n.startswith(("G_", "D_"))]
    indexes = sorted(n for n in members if n.lower().endswith(".index"))
    if not models or not indexes:
        raise ApiError(422, "invalid_voice_zip", "A voice zip needs a .pth and an .index file.")
    return sorted(models)[-1], indexes


def _read_profile(
    archive: zipfile.ZipFile, members: dict[str, zipfile.ZipInfo]
) -> dict[str, object]:
    if "profile.json" not in members or members["profile.json"].file_size > 2**20:
        return {}
    try:
        return dict(json.loads(archive.read(members["profile.json"])))
    except (ValueError, TypeError):
        return {}


def _extract(archive: zipfile.ZipFile, info: zipfile.ZipInfo, target: Path) -> None:
    """Stream one member to a server-chosen path (never to the member's own name)."""
    with archive.open(info) as source, target.open("wb") as sink:
        shutil.copyfileobj(source, sink, length=2**20)


def import_zip(engine: Engine, settings: Settings, singer_id: str, data: bytes) -> ImportedVoice:
    with Session(engine) as session:
        _singer(session, singer_id)  # before anything is written to disk
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ApiError(422, "invalid_voice_zip", "This is not a zip file.") from error
    with archive, Session(engine) as session:
        members = _safe_members(archive)
        model_name, index_names = _classify(members)
        profile = _read_profile(archive, members)
        match = CHECKPOINT_NAME.search(model_name)
        epoch, step = (int(match.group(1)), int(match.group(2))) if match else (0, 0)
        run = Run(
            singer_id=singer_id,
            status="imported",
            config_json={"imported": True},
            applio_commit=str(profile.get("applio_commit", "imported"))[:40],
        )
        session.add(run)
        session.flush()
        folder = run_dir(settings, singer_id, run.id) / "applio" / "voice"
        try:
            folder.mkdir(parents=True, exist_ok=True)
            model_path = folder / f"voice_{epoch}e_{step}s.pth"
            _extract(archive, members[model_name], model_path)
            for n, name in enumerate(index_names):
                _extract(archive, members[name], folder / f"voice_{n}.index")
            (folder.parent.parent / "profile.json").write_text(json.dumps(profile, indent=2))
            ckpt = Checkpoint(run_id=run.id, epoch=epoch, step=step, model_path=str(model_path))
            session.add(ckpt)
            session.flush()
            singer = _singer(session, singer_id)
            singer.active_checkpoint_id = ckpt.id
            median = profile.get("f0_median_hz")
            if isinstance(median, int | float) and singer.f0_median_hz is None:
                singer.f0_median_hz = float(median)
            session.commit()
        except Exception:
            session.rollback()
            shutil.rmtree(folder.parent.parent, ignore_errors=True)
            raise
        return ImportedVoice(run=_run_out(session, run), checkpoint=_ckpt_out(ckpt, ckpt.id))
