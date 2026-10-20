"""Job queries and controls for the API. The worker owns execution; this only reads
state and records the user's requests (cancel, pause, resume)."""

from collections.abc import Sequence

from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.api.errors import ApiError, not_found
from app.models import Job, JobEvent, JobStage, Singer
from app.schemas.jobs import JobOut, StageOut
from app.worker import job_queue

LABELS = {
    "prepare_dataset": "Dataset preparation",
    "train": "Training run",
    "convert": "Cover",
    "analyze": "Analysis",
}
ACTIVE = ("queued", "running", "pausing", "cancelling")


def _job_out(session: Session, job: Job) -> JobOut:
    stages = session.scalars(
        select(JobStage).where(JobStage.job_id == job.id).order_by(JobStage.position)
    )
    singer = session.get(Singer, job.singer_id) if job.singer_id else None
    params = job.params_json or {}
    return JobOut(
        id=job.id,
        type=job.type,
        singer_id=job.singer_id,
        singer_name=singer.name if singer else None,
        label=LABELS.get(job.type, job.type),
        run_id=str(params["run_id"]) if params.get("run_id") else None,
        cover_id=str(params["cover_id"]) if params.get("cover_id") else None,
        analysis_id=str(params["analysis_id"]) if params.get("analysis_id") else None,
        status=job.status,
        params=job.params_json,
        resume=job.resume,
        error_code=job.error_code,
        created_at=job.created_at,
        started_at=job.started_at,
        finished_at=job.finished_at,
        stages=[
            StageOut(
                name=s.name,
                position=s.position,
                status=s.status,
                started_at=s.started_at,
                finished_at=s.finished_at,
                attempts=s.attempts,
                outputs=s.outputs_json,
            )
            for s in stages
        ],
    )


def list_jobs(engine: Engine, statuses: Sequence[str], singer_id: str | None) -> list[JobOut]:
    query = select(Job).order_by(Job.created_at.desc())
    if statuses:
        query = query.where(Job.status.in_(statuses))
    if singer_id:
        query = query.where(Job.singer_id == singer_id)
    with Session(engine) as session:
        return [_job_out(session, job) for job in session.scalars(query.limit(200))]


def start_job(engine: Engine, job_type: str, singer_id: str, params: dict[str, object]) -> JobOut:
    """Queue a pipeline job for a singer; one active job per singer at a time."""
    from app.worker.pipelines import stage_names

    with Session(engine) as session:
        busy = session.scalar(
            select(Job.id).where(Job.singer_id == singer_id, Job.status.in_(ACTIVE))
        )
    if busy:
        raise ApiError(409, "singer_busy", "This singer already has a job queued or running.")
    job_id = job_queue.enqueue(
        engine, job_type, stage_names(job_type), params=params, singer_id=singer_id
    )
    return get_job(engine, job_id)


def get_job(engine: Engine, job_id: str) -> JobOut:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job is None:
            raise not_found("job")
        return _job_out(session, job)


def cancel(engine: Engine, job_id: str) -> JobOut:
    get_job(engine, job_id)
    job_queue.request_cancel(engine, job_id)
    return get_job(engine, job_id)


def pause(engine: Engine, job_id: str) -> JobOut:
    get_job(engine, job_id)
    if not job_queue.request_pause(engine, job_id):
        raise ApiError(409, "job_not_running", "Only a running job can be paused.")
    return get_job(engine, job_id)


def resume(engine: Engine, job_id: str) -> JobOut:
    get_job(engine, job_id)
    if not job_queue.resume_job(engine, job_id):
        raise ApiError(
            409, "job_not_resumable", "Only failed, cancelled or paused jobs can be resumed."
        )
    return get_job(engine, job_id)


def logs(engine: Engine, job_id: str, stage: str | None) -> str:
    get_job(engine, job_id)
    query = (
        select(JobEvent.payload_json)
        .where(JobEvent.job_id == job_id, JobEvent.type == "log.lines")
        .order_by(JobEvent.seq)
    )
    if stage:
        query = query.where(JobEvent.stage == stage)
    lines: list[str] = []
    with Session(engine) as session:
        for payload in session.scalars(query):
            batch = payload.get("lines", [])
            if isinstance(batch, list):
                lines.extend(str(line) for line in batch)
    return "\n".join(lines) + ("\n" if lines else "")
