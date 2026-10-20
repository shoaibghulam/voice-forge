"""Covers (docs/06 "Covers") and system routes (GPU, doctor, benchmarks)."""

import json
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Checkpoint, Job, Run


async def singer_with_voice(api: AsyncClient, engine: Engine, tmp_path: Path) -> tuple[str, str]:
    singer_id = str((await api.post("/api/singers", json={"name": "Arif"})).json()["data"]["id"])
    model = tmp_path / "voice_10e_400s.pth"
    model.write_bytes(b"w")
    with Session(engine) as session:
        run = Run(singer_id=singer_id, applio_commit="abc", status="done")
        session.add(run)
        session.flush()
        ckpt = Checkpoint(run_id=run.id, epoch=10, step=400, model_path=str(model))
        session.add(ckpt)
        session.commit()
        ckpt_id = ckpt.id
    await api.post(f"/api/checkpoints/{ckpt_id}/select")
    return singer_id, ckpt_id


def ready_upload(settings: Settings, upload_id: str = "abc123") -> str:
    folder = settings.data_dir / "uploads" / "ready"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{upload_id}.mp3").write_bytes(b"ID3song")
    return upload_id


async def test_create_cover_queues_a_convert_job(
    api: AsyncClient, engine: Engine, settings: Settings, tmp_path: Path
) -> None:
    singer_id, ckpt_id = await singer_with_voice(api, engine, tmp_path)
    upload_id = ready_upload(settings)

    response = await api.post(
        "/api/covers",
        json={"upload_id": upload_id, "singer_id": singer_id, "settings": {"semitones": 2}},
    )

    assert response.status_code == 202, response.text
    cover = response.json()["data"]
    assert cover["checkpoint_id"] == ckpt_id
    assert cover["status"] == "queued"
    assert cover["settings"]["semitones"] == 2
    with Session(engine) as session:
        job = session.get(Job, cover["job_id"])
        assert job is not None and job.type == "convert"
        assert Path(str(job.params_json["input_path"])).is_file()
    assert not list((settings.data_dir / "uploads" / "ready").glob("*"))  # moved, not copied


async def test_cover_needs_a_ready_upload(api: AsyncClient, engine: Engine, tmp_path: Path) -> None:
    singer_id, _ = await singer_with_voice(api, engine, tmp_path)

    response = await api.post("/api/covers", json={"upload_id": "missing", "singer_id": singer_id})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "upload_not_found"


async def test_cover_needs_a_trained_voice(api: AsyncClient, settings: Settings) -> None:
    singer_id = str((await api.post("/api/singers", json={"name": "New"})).json()["data"]["id"])

    response = await api.post(
        "/api/covers", json={"upload_id": ready_upload(settings), "singer_id": singer_id}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "no_voice_model"


async def test_cover_rejects_bad_upload_ids(api: AsyncClient) -> None:
    response = await api.post("/api/covers", json={"upload_id": "../x", "singer_id": "s"})

    assert response.status_code == 422


async def test_list_detail_and_original_audio(
    api: AsyncClient, engine: Engine, settings: Settings, tmp_path: Path
) -> None:
    singer_id, _ = await singer_with_voice(api, engine, tmp_path)
    created = await api.post(
        "/api/covers", json={"upload_id": ready_upload(settings), "singer_id": singer_id}
    )
    cover_id = created.json()["data"]["id"]

    listed = (await api.get("/api/covers")).json()["data"]
    detail = (await api.get(f"/api/covers/{cover_id}")).json()["data"]
    original = await api.get(f"/api/covers/{cover_id}/audio/original")
    missing = await api.get(f"/api/covers/{cover_id}/audio/mix")

    assert [c["id"] for c in listed] == [cover_id]
    assert detail["audio"]["original"] == f"/api/covers/{cover_id}/audio/original"
    assert detail["audio"]["mix"] is None
    assert original.content == b"ID3song"
    assert missing.status_code == 404


async def test_doctor_reports_named_checks(api: AsyncClient) -> None:
    data = (await api.get("/api/system/doctor")).json()["data"]

    ids = {check["id"] for check in data["checks"]}
    assert {"engine_python", "rmvpe", "contentvec", "pretrained", "ffmpeg", "disk"} <= ids
    assert isinstance(data["ok"], bool)
    assert all({"id", "label", "ok", "detail", "hint"} <= set(c) for c in data["checks"])


async def test_gpu_endpoint_shape(api: AsyncClient) -> None:
    data = (await api.get("/api/system/gpu")).json()["data"]

    assert "available" in data
    if data["available"]:
        assert data["mem_total_mb"] > 0


async def test_benchmarks_read_the_newest_run(api: AsyncClient, settings: Settings) -> None:
    folder = settings.data_dir / "benchmarks" / "20261019T000000Z"
    folder.mkdir(parents=True)
    row = {
        "stage": "train",
        "label": "batch 4",
        "seconds": 34.5,
        "audio_seconds": 424,
        "peak_vram_mb": 3312,
        "note": "",
        "rtf": 0.081,
    }
    (folder / "results.jsonl").write_text(json.dumps(row) + "\n")

    data = (await api.get("/api/system/benchmarks")).json()["data"]

    assert data["measured_at"] == "2026-10-19T00:00:00Z"
    assert data["rows"][0]["peak_vram_mb"] == 3312


async def test_benchmarks_empty_when_never_run(api: AsyncClient) -> None:
    data = (await api.get("/api/system/benchmarks")).json()["data"]

    assert data == {"measured_at": None, "rows": []}
