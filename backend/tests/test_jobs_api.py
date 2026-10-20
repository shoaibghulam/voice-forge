"""Jobs API (docs/06 "Jobs") and pause/resume in the queue, runner and heartbeat."""

import threading

from httpx import AsyncClient
from sqlalchemy import Engine, update

from app.models import JobStage
from app.worker.events import EventWriter
from app.worker.job_queue import claim_next, enqueue, finish_job
from app.worker.loop import Heartbeat
from app.worker.stage_runner import StageContext, StagePausedError, run_job

NOW = "2026-10-19T10:00:00.000Z"


def running_job(engine: Engine, names: list[str] | None = None) -> str:
    job_id = enqueue(engine, "train", names or ["preprocess", "train"])
    claim_next(engine, worker_pid=1, now=NOW, lease_s=3600)
    return job_id


async def test_list_jobs_with_stages_and_status_filter(api: AsyncClient, engine: Engine) -> None:
    running = running_job(engine)
    enqueue(engine, "convert", ["separate"])

    all_jobs = (await api.get("/api/jobs")).json()["data"]
    only_running = (await api.get("/api/jobs?status=running")).json()["data"]

    assert len(all_jobs) == 2
    assert [j["id"] for j in only_running] == [running]
    assert [s["name"] for s in only_running[0]["stages"]] == ["preprocess", "train"]


async def test_get_job_detail(api: AsyncClient, engine: Engine) -> None:
    job_id = running_job(engine)

    data = (await api.get(f"/api/jobs/{job_id}")).json()["data"]

    assert data["status"] == "running"
    assert data["type"] == "train"
    assert data["stages"][0]["status"] == "pending"


async def test_unknown_job_is_404(api: AsyncClient) -> None:
    response = await api.get("/api/jobs/nope")

    assert response.json()["error"]["code"] == "job_not_found"


async def test_cancel_queued_and_running(api: AsyncClient, engine: Engine) -> None:
    running = running_job(engine)
    queued = enqueue(engine, "convert", ["a"])

    r1 = await api.post(f"/api/jobs/{queued}/cancel")
    r2 = await api.post(f"/api/jobs/{running}/cancel")

    assert r1.json()["data"]["status"] == "cancelled"
    assert r2.json()["data"]["status"] == "cancelling"


async def test_pause_only_applies_to_running_jobs(api: AsyncClient, engine: Engine) -> None:
    running = running_job(engine)
    queued = enqueue(engine, "train", ["a"])

    paused = await api.post(f"/api/jobs/{running}/pause")
    refused = await api.post(f"/api/jobs/{queued}/pause")

    assert paused.json()["data"]["status"] == "pausing"
    assert refused.status_code == 409
    assert refused.json()["error"]["code"] == "job_not_running"


async def test_resume_requeues_and_resets_unfinished_stages(
    api: AsyncClient, engine: Engine
) -> None:
    job_id = running_job(engine, ["preprocess", "train"])
    with engine.begin() as conn:
        conn.execute(update(JobStage).where(JobStage.name == "preprocess").values(status="done"))
        conn.execute(update(JobStage).where(JobStage.name == "train").values(status="failed"))
    finish_job(engine, job_id, "failed", now=NOW, error_code="cuda_oom")

    data = (await api.post(f"/api/jobs/{job_id}/resume")).json()["data"]

    assert data["status"] == "queued"
    assert data["resume"] is True
    assert data["error_code"] is None
    assert {s["name"]: s["status"] for s in data["stages"]} == {
        "preprocess": "done",
        "train": "pending",
    }


async def test_resume_refused_for_finished_or_active_jobs(api: AsyncClient, engine: Engine) -> None:
    job_id = running_job(engine)

    response = await api.post(f"/api/jobs/{job_id}/resume")

    assert response.status_code == 409


async def test_logs_are_joined_and_filterable_by_stage(api: AsyncClient, engine: Engine) -> None:
    job_id = running_job(engine)
    writer = EventWriter(engine, job_id)
    writer.log("slicing...", stage="preprocess")
    writer.flush()
    writer.log("epoch 1", stage="train")
    writer.flush()

    everything = (await api.get(f"/api/jobs/{job_id}/logs")).text
    train_only = (await api.get(f"/api/jobs/{job_id}/logs?stage=train")).text

    assert everything.splitlines() == ["slicing...", "epoch 1"]
    assert train_only.splitlines() == ["epoch 1"]


def test_paused_stage_returns_to_pending_and_job_is_paused(engine: Engine) -> None:
    job_id = running_job(engine, ["train", "index"])

    def train(ctx: StageContext) -> dict[str, object]:
        raise StagePausedError

    status = run_job(
        engine,
        job_id,
        {"train": [("train", train), ("index", lambda ctx: {})]},
        EventWriter(engine, job_id),
        threading.Event(),
    )

    assert status == "paused"
    with engine.connect() as conn:
        rows = dict(conn.execute(JobStage.__table__.select().with_only_columns(
            JobStage.name, JobStage.status)).all())  # fmt: skip
    assert rows == {"train": "pending", "index": "pending"}


def test_heartbeat_sets_pause_event(engine: Engine) -> None:
    job_id = running_job(engine)
    cancel, pause = threading.Event(), threading.Event()

    from app.worker.job_queue import request_pause

    with Heartbeat(engine, job_id, cancel, pause=pause, interval_s=0.02):
        request_pause(engine, job_id)
        assert pause.wait(timeout=2)
    assert not cancel.is_set()
