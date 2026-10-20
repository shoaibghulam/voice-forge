"""train: preprocess -> extract -> train -> index -> export -> samples (docs/04 §5-8).

Job params: singer_id, run_id, epochs, batch_size, save_every, sample_rate, vocoder.

Run folder (data/singers/<singer>/runs/<run>/):
    dataset/   kept clips handed to Applio      probes/   2 held-out clips for scoring
    applio/voice/   Applio's run dir (APPLIO_LOGS_DIR=applio, model name "voice")
    samples/   checkpoint audio
Every stage verifies the files it should have produced (docs/05 A1, A2, A4, B14).
"""

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Checkpoint, Clip, Run, Singer
from app.services.storage import run_dir
from app.worker import applio
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages.common import (
    applio_paths,
    engine_script,
    json_events,
    require,
    run_engine,
    settings,
)
from app.worker.stages.logic import usable_gate

MODEL = "voice"
PROBES = 2
SCORED_CHECKPOINTS = 6
NO_CLIPS_HINT = "No singing survived slicing. Check the dataset QC report (docs/05 B14)."
NO_F0_HINT = "Pitch extraction wrote nothing. Run the doctor: rmvpe.pt may be missing."


@dataclass(frozen=True)
class RunPaths:
    root: Path
    logs: Path
    model_dir: Path
    dataset: Path
    probes: Path
    samples: Path


def run_paths(ctx: StageContext) -> RunPaths:
    root = run_dir(settings(), require(ctx, "singer_id"), require(ctx, "run_id"))
    logs = root / "applio"
    return RunPaths(root, logs, logs / MODEL, root / "dataset", root / "probes", root / "samples")


def sample_rate(ctx: StageContext) -> int:
    return int(str(ctx.params.get("sample_rate", 40000)))


def _set_run(ctx: StageContext, **values: object) -> None:
    with Session(ctx.engine) as session:
        run = session.get(Run, require(ctx, "run_id"))
        if run is not None:
            for key, value in values.items():
                setattr(run, key, value)
            session.commit()


def _kept_clips(ctx: StageContext) -> list[Clip]:
    with Session(ctx.engine, expire_on_commit=False) as session:
        query = select(Clip).where(
            Clip.singer_id == require(ctx, "singer_id"), Clip.verdict == "keep"
        )
        return list(session.scalars(query.order_by(Clip.created_at)))


def _pick_probes(clips: list[Clip]) -> list[Clip]:
    """Held-out clips of 3-15 s from different songs: never trained on, used for scoring.

    The range matches QC's slice cap (15 s); the first run with 4-10 s found no probes
    because most clips of continuous singing run 10-15 s."""
    probes: list[Clip] = []
    for clip in clips:
        if 3 <= clip.duration_s <= 15 and all(p.song_id != clip.song_id for p in probes):
            probes.append(clip)
        if len(probes) == PROBES:
            break
    return probes


def _stage_dataset(ctx: StageContext, paths: RunPaths) -> float:
    clips = _kept_clips(ctx)
    if not clips:
        raise StageError("dataset_not_prepared", "Prepare the dataset before training.")
    probes = _pick_probes(clips) if len(clips) > 20 else []
    probe_ids = {p.id for p in probes}
    paths.dataset.mkdir(parents=True, exist_ok=True)
    paths.probes.mkdir(parents=True, exist_ok=True)
    for clip in clips:
        target = (paths.probes if clip.id in probe_ids else paths.dataset) / Path(clip.path).name
        if not target.exists():
            shutil.copy2(clip.path, target)
    return sum(c.duration_s for c in clips if c.id not in probe_ids) / 60


def preprocess(ctx: StageContext) -> dict[str, object]:
    paths = run_paths(ctx)
    minutes = _stage_dataset(ctx, paths)
    if usable_gate(minutes) == "dataset_too_small":
        raise StageError(
            "dataset_too_small",
            f"Only {minutes:.1f} minutes of usable singing; at least 5 are needed.",
            hint="Add more songs and prepare again.",
        )
    _set_run(ctx, status="running")
    config = applio.PreprocessConfig(dataset=paths.dataset, sample_rate=sample_rate(ctx))
    run_engine(
        ctx,
        applio.preprocess_args(applio_paths(), paths.model_dir, config),
        env=applio.run_env(paths.logs),
        fail_code="preprocess_failed",
    )
    sliced = len(list((paths.model_dir / "sliced_audios").glob("*.wav")))
    if sliced == 0:
        raise StageError("no_clips", "Applio wrote 0 training clips.", hint=NO_CLIPS_HINT)
    return {"clips": sliced, "minutes": round(minutes, 2)}


def _store_profile(ctx: StageContext, paths: RunPaths) -> dict[str, object]:
    lines = run_engine(
        ctx,
        [
            *engine_script("f0_stats.py"),
            "--applio-root",
            str(settings().applio_root),
            "--npy-dir",
            str(paths.model_dir / "f0_voiced"),
        ],
        fail_code="profile_failed",
    )
    stats = json_events(lines)[-1] if json_events(lines) else {}
    with Session(ctx.engine) as session:
        singer = session.get(Singer, require(ctx, "singer_id"))
        if singer is not None and stats.get("median_hz"):
            singer.f0_median_hz = stats["median_hz"]
            singer.f0_p05_hz = stats["p05_hz"]
            singer.f0_p95_hz = stats["p95_hz"]
            session.commit()
    return stats


def extract(ctx: StageContext) -> dict[str, object]:
    paths = run_paths(ctx)
    config = applio.ExtractConfig(sample_rate=sample_rate(ctx))
    run_engine(
        ctx,
        applio.extract_args(applio_paths(), paths.model_dir, config),
        env=applio.run_env(paths.logs),
        fail_code="extract_failed",
        hint=NO_F0_HINT,
    )
    filelist = paths.model_dir / "filelist.txt"
    f0_files = len(list((paths.model_dir / "f0_voiced").glob("*.npy")))
    if not filelist.exists() or not filelist.read_text(encoding="utf-8").strip() or not f0_files:
        raise StageError("empty_filelist", "Feature extraction produced nothing.", hint=NO_F0_HINT)
    return {"f0_files": f0_files, "profile": _store_profile(ctx, paths)}


def index(ctx: StageContext) -> dict[str, object]:
    paths = run_paths(ctx)
    run_engine(ctx, applio.index_args(applio_paths(), paths.model_dir), fail_code="index_failed")
    indexes = sorted(paths.model_dir.glob("*.index"))
    if not indexes:
        raise StageError("no_index", "The retrieval index was not written.")
    return {"index": str(indexes[0])}


def _applio_commit() -> str:
    git = shutil.which("git")
    if git is None:
        return "unknown"
    result = subprocess.run(  # noqa: S603 - fixed argument list
        [git, "-C", str(settings().applio_root), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=False,
        timeout=10,
    )
    return result.stdout.strip() or "unknown"


def export(ctx: StageContext) -> dict[str, object]:
    paths = run_paths(ctx)
    run_id, singer_id = require(ctx, "run_id"), require(ctx, "singer_id")
    with Session(ctx.engine) as session:
        checkpoints = list(
            session.scalars(
                select(Checkpoint).where(Checkpoint.run_id == run_id).order_by(Checkpoint.epoch)
            )
        )
        singer = session.get(Singer, singer_id)
        if not checkpoints or singer is None:
            raise StageError("no_checkpoint", "Training produced no usable voice.")
        profile = {
            "sample_rate": sample_rate(ctx),
            "vocoder": ctx.params.get("vocoder", "HiFi-GAN"),
            "embedder": "contentvec",
            "f0_method": "rmvpe",
            "applio_commit": _applio_commit(),
            "f0_median_hz": singer.f0_median_hz,
            "f0_p05_hz": singer.f0_p05_hz,
            "f0_p95_hz": singer.f0_p95_hz,
            "epochs": checkpoints[-1].epoch,
        }
        if singer.active_checkpoint_id is None:
            singer.active_checkpoint_id = checkpoints[-1].id
        session.commit()
    paths.root.mkdir(parents=True, exist_ok=True)
    (paths.root / "profile.json").write_text(json.dumps(profile, indent=2), encoding="utf-8")
    return {"checkpoints": len(checkpoints), "profile": profile}


def _convert_probe(ctx: StageContext, paths: RunPaths, ckpt: Checkpoint, probe: Path) -> Path:
    indexes = sorted(paths.model_dir.glob("*.index"))
    out = paths.samples / f"probe_e{ckpt.epoch:04d}.wav"
    if not out.exists():
        config = applio.InferConfig(
            input_path=probe, output_path=out, pth_path=Path(ckpt.model_path), index_path=indexes[0]
        )
        run_engine(ctx, applio.infer_args(applio_paths(), config), fail_code="probe_failed")
    return out


def samples(ctx: StageContext) -> dict[str, object]:
    """Convert a held-out clip with recent checkpoints and rank them by timbre similarity."""
    paths = run_paths(ctx)
    probes = sorted(paths.probes.glob("*.wav"))
    with Session(ctx.engine, expire_on_commit=False) as session:
        checkpoints = list(
            session.scalars(
                select(Checkpoint)
                .where(Checkpoint.run_id == require(ctx, "run_id"))
                .order_by(Checkpoint.epoch.desc())
                .limit(SCORED_CHECKPOINTS)
            )
        )
    if len(probes) < PROBES or not checkpoints:
        _set_run(ctx, status="done")
        return {"scored": 0, "reason": "not enough held-out clips"}
    paths.samples.mkdir(parents=True, exist_ok=True)
    outputs = {c.id: _convert_probe(ctx, paths, c, probes[0]) for c in checkpoints}
    lines = run_engine(
        ctx,
        [
            *engine_script("similarity.py"),
            "--ref",
            *map(str, probes[1:]),
            "--cand",
            *map(str, outputs.values()),
        ],
        fail_code="scoring_failed",
    )
    scores = {e["path"]: float(e["similarity"]) for e in json_events(lines)}
    return _record_scores(ctx, outputs, scores)


def _record_scores(
    ctx: StageContext, outputs: dict[str, Path], scores: dict[str, float]
) -> dict[str, object]:
    best_id = max(outputs, key=lambda cid: scores.get(str(outputs[cid]), -1.0))
    scored: list[dict[str, object]] = []
    with Session(ctx.engine) as session:
        for checkpoint_id, path in outputs.items():
            ckpt = session.get(Checkpoint, checkpoint_id)
            if ckpt is None:
                continue
            ckpt.similarity = scores.get(str(path))
            ckpt.recommended = checkpoint_id == best_id
            ckpt.sample_path = ckpt.sample_path or str(path)
            scored.append(
                {
                    "checkpoint_id": ckpt.id,
                    "epoch": ckpt.epoch,
                    "similarity": ckpt.similarity,
                    "recommended": ckpt.recommended,
                }
            )
        session.commit()
    # Emit only after the commit: the event writer uses its own connection, and SQLite
    # allows one writer at a time - emitting inside the open transaction locked itself.
    for payload in scored:
        ctx.events.emit("checkpoint.scored", payload, stage=ctx.stage)
    _set_run(ctx, status="done")
    return {"scored": len(outputs), "recommended": best_id}
