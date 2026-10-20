"""Run the stages of one claimed job, in order, and narrate it as events.

A pipeline maps a job type to its ordered (stage name, function) list. Each stage
function does its work and returns the outputs worth recording (counts, paths). The
runner owns everything around it:

- skip stages already `done` (this is what makes resume after a crash work)
- record attempts, start and finish times, outputs or failure on the job_stages row
- emit stage.started / stage.completed / stage.skipped / stage.failed and job.status
- stop between stages when cancel is requested
- turn a StageError into a clean failure with a code and a hint for the UI, and any
  other exception into `internal_error` rather than a dead worker

Stage functions must verify their own outputs (docs/05 A1) and raise StageError when
something is missing; the runner never infers success from the absence of an exception
in an engine subprocess.
"""

import threading
import time
import traceback
from collections.abc import Callable
from dataclasses import dataclass, field

from sqlalchemy import Engine, select, update
from sqlalchemy.orm import Session

from app.db import utc_now
from app.models import Job, JobStage
from app.worker.events import EventWriter
from app.worker.job_queue import finish_job


@dataclass(frozen=True)
class StageContext:
    engine: Engine
    job_id: str
    stage: str
    params: dict[str, object]
    events: EventWriter
    cancel: threading.Event
    outputs: dict[str, dict[str, object]] = field(default_factory=dict)  # earlier stages
    pause: threading.Event = field(default_factory=threading.Event)  # stop at next checkpoint


class StageError(Exception):
    """An expected failure with a stable code and a hint the UI can show."""

    def __init__(self, code: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = hint


class StagePausedError(Exception):
    """Raised by a stage that honoured a pause request at a safe point (a checkpoint).
    The stage goes back to pending so a resume runs it again from that checkpoint."""


StageFn = Callable[[StageContext], dict[str, object]]
Pipeline = dict[str, list[tuple[str, StageFn]]]


def _load(engine: Engine, job_id: str) -> tuple[Job, list[JobStage]]:
    with Session(engine, expire_on_commit=False) as session:
        job = session.get(Job, job_id)
        if job is None:
            raise LookupError(job_id)
        stages = list(
            session.scalars(
                select(JobStage).where(JobStage.job_id == job_id).order_by(JobStage.position)
            )
        )
        return job, stages


def _set_stage(engine: Engine, stage_id: str, **values: object) -> None:
    with engine.begin() as conn:
        conn.execute(update(JobStage).where(JobStage.id == stage_id).values(**values))


def _end(engine: Engine, events: EventWriter, job_id: str, status: str, code: str | None) -> str:
    events.flush()
    finish_job(engine, job_id, status, now=utc_now(), error_code=code)
    events.emit("job.status", {"status": status, "error_code": code})
    return status


def _fail(
    engine: Engine, events: EventWriter, stage: JobStage, error: StageError, started: float
) -> None:
    _set_stage(engine, stage.id, status="failed", finished_at=utc_now())
    events.flush()
    events.emit(
        "stage.failed",
        {
            "stage": stage.name,
            "error_code": error.code,
            "message": error.message,
            "hint": error.hint,
            "duration_s": round(time.monotonic() - started, 2),
        },
        stage=stage.name,
    )


def _run_stage(ctx: StageContext, stage: JobStage, fn: StageFn, total: int) -> StageError | None:
    """Run one stage; returns the error that failed it, or None on success."""
    engine, events = ctx.engine, ctx.events
    _set_stage(
        engine, stage.id, status="running", started_at=utc_now(), attempts=stage.attempts + 1
    )
    events.emit(
        "stage.started",
        {"stage": stage.name, "index": stage.position, "total_stages": total},
        stage=stage.name,
    )
    started = time.monotonic()
    try:
        outputs = fn(ctx)
    except StagePausedError:
        _set_stage(engine, stage.id, status="pending")
        events.flush()
        events.emit("stage.paused", {"stage": stage.name}, stage=stage.name)
        return StageError("paused", "Paused at a checkpoint.")
    except StageError as error:
        _fail(engine, events, stage, error, started)
        return error
    except Exception:
        crash = StageError("internal_error", traceback.format_exc(limit=5))
        _fail(engine, events, stage, crash, started)
        return crash
    _set_stage(engine, stage.id, status="done", finished_at=utc_now(), outputs_json=outputs)
    events.flush()
    events.emit(
        "stage.completed",
        {"stage": stage.name, "outputs": outputs,
         "duration_s": round(time.monotonic() - started, 2)},
        stage=stage.name,
    )  # fmt: skip
    ctx.outputs[stage.name] = outputs
    return None


def run_job(
    engine: Engine,
    job_id: str,
    pipeline: Pipeline,
    events: EventWriter,
    cancel: threading.Event,
    pause: threading.Event | None = None,
) -> str:
    """Run a claimed job to a terminal status and return it."""
    pause = pause or threading.Event()
    job, stages = _load(engine, job_id)
    events.emit("job.status", {"status": "running", "resume": job.resume})
    functions = dict(pipeline.get(job.type, []))
    if not functions:
        return _end(engine, events, job_id, "failed", "unknown_job_type")

    outputs = {s.name: s.outputs_json for s in stages if s.status == "done"}
    for stage in stages:
        if cancel.is_set():
            return _end(engine, events, job_id, "cancelled", None)
        if stage.status == "done":
            events.emit(
                "stage.skipped", {"stage": stage.name, "reason": "already_done"}, stage=stage.name
            )
            continue
        if stage.name not in functions:
            return _end(engine, events, job_id, "failed", "unknown_stage")
        ctx = StageContext(
            engine, job_id, stage.name, job.params_json, events, cancel, outputs, pause
        )
        error = _run_stage(ctx, stage, functions[stage.name], len(stages))
        if error is not None:
            if cancel.is_set():
                return _end(engine, events, job_id, "cancelled", None)
            if error.code == "paused":
                return _end(engine, events, job_id, "paused", None)
            return _end(engine, events, job_id, "failed", error.code)
    status = "cancelled" if cancel.is_set() else "done"
    return _end(engine, events, job_id, status, None)
