"""Job events: the worker-side writer and the SSE replay endpoint (docs/06 "SSE stream")."""

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.db import Base, make_engine
from app.deps import get_engine
from app.main import create_app
from app.models import Job, JobEvent
from app.worker.events import EventWriter


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def engine(tmp_path: Path) -> Iterator[Engine]:
    engine = make_engine(f"sqlite:///{tmp_path / 'app.db'}")
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


def add_job(engine: Engine, status: str = "running") -> str:
    with Session(engine) as session:
        job = Job(type="train", status=status)
        session.add(job)
        session.commit()
        return job.id


def stored(engine: Engine, job_id: str) -> list[JobEvent]:
    with Session(engine) as session:
        query = select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.seq)
        return list(session.scalars(query))


# --- writer -------------------------------------------------------------------------


def test_writer_stores_event_with_payload(engine: Engine) -> None:
    job_id = add_job(engine)
    writer = EventWriter(engine, job_id)

    writer.emit("stage.started", {"stage": "train", "index": 4}, stage="train")

    [event] = stored(engine, job_id)
    assert event.type == "stage.started"
    assert event.stage == "train"
    assert event.payload_json == {"stage": "train", "index": 4}


def test_writer_throttles_high_rate_types(engine: Engine) -> None:
    job_id = add_job(engine)
    clock = FakeClock()
    writer = EventWriter(engine, job_id, clock=clock)

    assert writer.emit("gpu.sample", {"util": 1})
    clock.now += 0.3
    assert not writer.emit("gpu.sample", {"util": 2})
    clock.now += 1.0
    assert writer.emit("gpu.sample", {"util": 3})

    assert [e.payload_json["util"] for e in stored(engine, job_id)] == [1, 3]


def test_writer_never_throttles_state_changes(engine: Engine) -> None:
    job_id = add_job(engine)
    writer = EventWriter(engine, job_id, clock=FakeClock())

    for index in range(3):
        writer.emit("stage.completed", {"index": index})

    assert len(stored(engine, job_id)) == 3


def test_log_lines_are_batched_not_dropped(engine: Engine) -> None:
    job_id = add_job(engine)
    clock = FakeClock()
    writer = EventWriter(engine, job_id, clock=clock)

    for n in range(5):
        writer.log(f"line {n}")
    clock.now += 1.0
    writer.log("line 5")
    writer.flush()

    lines = [line for e in stored(engine, job_id) for line in e.payload_json["lines"]]
    assert lines == [f"line {n}" for n in range(6)]


# --- SSE endpoint ---------------------------------------------------------------------


@pytest.fixture
async def client(engine: Engine) -> AsyncIterator[AsyncClient]:
    app = create_app()
    app.dependency_overrides[get_engine] = lambda: engine
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://127.0.0.1:8000"
    ) as ac:
        yield ac
    app.dependency_overrides.clear()


def parse_sse(body: str) -> list[dict[str, str]]:
    messages = []
    for block in body.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "id" in fields:
            messages.append(fields)
    return messages


async def test_sse_replays_all_events_of_a_finished_job(
    engine: Engine, client: AsyncClient
) -> None:
    job_id = add_job(engine, status="done")
    writer = EventWriter(engine, job_id)
    for index in range(3):
        writer.emit("stage.completed", {"index": index})

    response = await client.get(f"/api/jobs/{job_id}/events")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    messages = parse_sse(response.text)
    assert [m["event"] for m in messages] == ["stage.completed"] * 3
    assert [json.loads(m["data"])["data"]["index"] for m in messages] == [0, 1, 2]


async def test_sse_resumes_after_last_event_id(engine: Engine, client: AsyncClient) -> None:
    job_id = add_job(engine, status="done")
    writer = EventWriter(engine, job_id)
    for index in range(5):
        writer.emit("stage.completed", {"index": index})
    second_seq = stored(engine, job_id)[1].seq

    response = await client.get(
        f"/api/jobs/{job_id}/events", headers={"Last-Event-ID": str(second_seq)}
    )

    indexes = [json.loads(m["data"])["data"]["index"] for m in parse_sse(response.text)]
    assert indexes == [2, 3, 4]


async def test_sse_envelope_matches_schema(engine: Engine, client: AsyncClient) -> None:
    job_id = add_job(engine, status="done")
    EventWriter(engine, job_id).emit("train.epoch", {"epoch": 3}, stage="train")

    response = await client.get(f"/api/jobs/{job_id}/events")

    [message] = parse_sse(response.text)
    envelope = json.loads(message["data"])
    assert envelope["v"] == 1
    assert envelope["job_id"] == job_id
    assert envelope["type"] == "train.epoch"
    assert envelope["stage"] == "train"
    assert envelope["seq"] == int(message["id"])
    assert envelope["ts"].endswith("Z")


async def test_sse_marks_the_end_of_replay_without_an_id(
    engine: Engine, client: AsyncClient
) -> None:
    job_id = add_job(engine, status="done")
    writer = EventWriter(engine, job_id)
    for index in range(2):
        writer.emit("stage.completed", {"index": index})

    response = await client.get(f"/api/jobs/{job_id}/events")

    blocks = [b for b in response.text.strip().split("\n\n") if "event:" in b]
    events = [
        line.split(": ", 1)[1]
        for b in blocks
        for line in b.splitlines()
        if line.startswith("event:")
    ]
    assert events == ["stage.completed", "stage.completed", "replay.done"]
    assert "id:" not in blocks[-1]


async def test_sse_unknown_job_is_404(client: AsyncClient) -> None:
    response = await client.get("/api/jobs/does-not-exist/events")

    assert response.status_code == 404
