"""The `train` stage: run Applio's train.py and narrate it live (docs/04 §6-7, docs/07).

While training runs, every stdout line is parsed:
    batch lines  -> train.step
    epoch lines  -> train.epoch + eta, then new TensorBoard scalars -> train.scalars
After each save epoch the exported `voice_<e>e_<s>s.pth` is registered as a Checkpoint
(checkpoint.saved, with the TensorBoard audio sample), old G_/D_ files are pruned, and
the stage may halt the process on purpose:
    pause requested   -> stop now, stage returns to pending, job is `paused`
    loss plateaued    -> stop now, training counts as finished (early stop)
CUDA out of memory retries once at batch 2, then with gradient checkpointing.
Resume is Applio's own: train.py continues from the newest G_/D_ in the run folder.
"""

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Checkpoint, JobEvent
from app.worker import applio
from app.worker.eta import EpochEma
from app.worker.parsers.applio_stdout import EpochDone, StepProgress, parse_line
from app.worker.stage_runner import StageContext, StageError, StagePausedError
from app.worker.stages.common import applio_paths, engine_script, json_events, run_engine
from app.worker.stages.logic import Plateau, parse_checkpoint
from app.worker.stages.train import MODEL, RunPaths, run_paths, sample_rate

KEEP_TRAINING_STATES = 2
SETTLE_S = 1.0  # a checkpoint file younger than this may still be being written


@dataclass
class Monitor:
    ctx: StageContext
    paths: RunPaths
    total_epochs: int
    halt: threading.Event = field(default_factory=threading.Event)
    halt_reason: str | None = None
    ema: EpochEma = field(default_factory=EpochEma)
    plateau: Plateau = field(default_factory=Plateau)
    last_scalar_step: int = -1
    latest_mel: float | None = None
    known: set[str] = field(default_factory=set)
    epochs_seen: int = 0

    def on_line(self, line: str) -> None:
        record = parse_line(line)
        if isinstance(record, StepProgress):
            self.ctx.events.emit("train.step", record.__dict__, stage="train")
        elif isinstance(record, EpochDone):
            self.on_epoch(record)

    def on_epoch(self, record: EpochDone) -> None:
        self.epochs_seen += 1
        # The first epoch of each start also loads models and data (minutes, not seconds);
        # counting it inflated the ETA ~5x on the first real run, so the EMA skips it.
        if self.epochs_seen > 1:
            self.ema = self.ema.update(record.epoch_seconds)
        eta = self.ema.eta(self.total_epochs - record.epoch)
        lowest = {"value": record.lowest_value, "epoch": record.lowest_epoch}
        self.ctx.events.emit(
            "train.epoch",
            {
                "epoch": record.epoch,
                "total_epochs": self.total_epochs,
                "epoch_s": record.epoch_seconds,
                "lowest": lowest,
            },
            stage="train",
        )
        self.ctx.events.emit(
            "eta", {"stage_eta_s": eta.seconds, "method": eta.method}, stage="train"
        )
        self.pull_scalars()
        early = self.latest_mel is not None and self.plateau.update(record.epoch, self.latest_mel)
        if self.register_checkpoints() and (self.ctx.pause.is_set() or early):
            self.halt_reason = "pause" if self.ctx.pause.is_set() else "early_stop"
            self.halt.set()

    def pull_scalars(self) -> None:
        args = [
            *engine_script("tb_dump.py"),
            "--event-dir",
            str(self.paths.model_dir / "eval"),
            "--after-step",
            str(self.last_scalar_step),
            "--audio-dir",
            str(self.paths.samples),
        ]
        try:
            lines = run_engine(self.ctx, args, fail_code="tensorboard_failed", log_output=False)
        except StageError as error:
            if error.code == "cancelled":
                raise
            return  # live charts are a nicety; never fail training over them
        for event in json_events(lines):
            if event.get("event") == "scalars":
                self.last_scalar_step = max(self.last_scalar_step, int(event["step"]))
                self.latest_mel = event.get("mel", self.latest_mel)
                scalars = {k: v for k, v in event.items() if k != "event"}
                self.ctx.events.emit("train.scalars", scalars, stage="train")

    def register_checkpoints(self) -> bool:
        """Record exported voices not seen before; True if any were new."""
        new = False
        for path in sorted(self.paths.model_dir.glob(f"{MODEL}_*e_*s.pth")):
            parsed = parse_checkpoint(path.name, MODEL)
            if parsed is None or path.name in self.known:
                continue
            if time.time() - path.stat().st_mtime < SETTLE_S:
                continue
            self.known.add(path.name)
            self.save_checkpoint(path, *parsed)
            new = True
        if new:
            prune_training_states(self.paths.model_dir)
        return new

    def save_checkpoint(self, path: Path, epoch: int, step: int) -> None:
        samples = sorted(self.paths.samples.glob("sample_*.wav"))
        run_id = str(self.ctx.params["run_id"])
        with Session(self.ctx.engine) as session:
            ckpt = Checkpoint(
                run_id=run_id,
                epoch=epoch,
                step=step,
                model_path=str(path),
                sample_path=str(samples[-1]) if samples else None,
                mel_loss=self.latest_mel,
            )
            session.add(ckpt)
            session.commit()
            payload = {
                "checkpoint_id": ckpt.id,
                "epoch": epoch,
                "step": step,
                "mel": self.latest_mel,
                "has_sample": bool(samples),
                "sample_url": f"/api/checkpoints/{ckpt.id}/sample" if samples else None,
            }
        self.ctx.events.emit("checkpoint.saved", payload, stage="train")


def prune_training_states(model_dir: Path) -> None:
    """Keep the newest G_/D_ pairs only: each pair is ~200 MB and only the last resumes."""
    for prefix in ("G_", "D_"):
        states = sorted(model_dir.glob(f"{prefix}*.pth"), key=lambda p: p.stat().st_mtime)
        for old in states[:-KEEP_TRAINING_STATES]:
            old.unlink(missing_ok=True)


def _known_checkpoints(ctx: StageContext) -> set[str]:
    with Session(ctx.engine) as session:
        paths = session.scalars(
            select(Checkpoint.model_path).where(Checkpoint.run_id == str(ctx.params["run_id"]))
        )
        return {Path(p).name for p in paths}


def _last_scalar_step(ctx: StageContext) -> int:
    """On resume, continue the loss chart where the previous attempt left it."""
    with Session(ctx.engine) as session:
        count = session.scalar(
            select(func.count()).where(
                JobEvent.job_id == ctx.job_id, JobEvent.type == "train.scalars"
            )
        )
        if not count:
            return -1
        last = session.scalars(
            select(JobEvent.payload_json)
            .where(JobEvent.job_id == ctx.job_id, JobEvent.type == "train.scalars")
            .order_by(JobEvent.seq.desc())
            .limit(1)
        ).first()
    return int(str((last or {}).get("step", -1)))


def _train_once(ctx: StageContext, config: applio.TrainConfig) -> Monitor:
    paths = run_paths(ctx)
    paths.samples.mkdir(parents=True, exist_ok=True)
    monitor = Monitor(
        ctx,
        paths,
        config.total_epoch,
        known=_known_checkpoints(ctx),
        last_scalar_step=_last_scalar_step(ctx),
    )
    run_engine(
        ctx,
        applio.train_args(applio_paths(), config),
        env=applio.run_env(paths.logs),
        on_line=monitor.on_line,
        fail_code="training_failed",
        keep_lines=False,
        halt=monitor.halt,
    )
    monitor.pull_scalars()
    monitor.register_checkpoints()
    return monitor


def _configs(ctx: StageContext) -> list[applio.TrainConfig]:
    batch = int(str(ctx.params.get("batch_size", 4)))
    base = applio.TrainConfig(
        model_name=MODEL,
        sample_rate=sample_rate(ctx),
        total_epoch=int(str(ctx.params.get("epochs", 100))),
        save_every_epoch=int(str(ctx.params.get("save_every", 5))),
        batch_size=batch,
        vocoder=str(ctx.params.get("vocoder", "HiFi-GAN")),
    )
    fallback = applio.TrainConfig(**{**base.__dict__, "batch_size": min(batch, 2)})
    careful = applio.TrainConfig(**{**fallback.__dict__, "checkpointing": True})
    return [base, fallback, careful] if batch > 2 else [base, careful]


def train(ctx: StageContext) -> dict[str, object]:
    configs = _configs(ctx)
    for attempt, config in enumerate(configs):
        try:
            monitor = _train_once(ctx, config)
            break
        except StageError as error:
            if error.code != "cuda_oom" or attempt == len(configs) - 1:
                raise
            nxt = configs[attempt + 1]
            ctx.events.emit(
                "stage.retry",
                {
                    "reason": "cuda_oom",
                    "change": {"batch_size": nxt.batch_size, "checkpointing": nxt.checkpointing},
                },
                stage="train",
            )
    if monitor.halt_reason == "pause":
        raise StagePausedError
    if not monitor.known:
        raise StageError("no_checkpoint", "Training ended without saving a usable voice.")
    return {
        "checkpoints": len(monitor.known),
        "stopped_early": monitor.halt_reason == "early_stop",
        "best_mel": monitor.plateau.best,
        "best_epoch": monitor.plateau.best_epoch,
    }
