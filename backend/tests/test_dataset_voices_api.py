"""Dataset (prepare, QC, clips) and voice (train, runs, checkpoints, export/import) routes."""

import io
import json
import zipfile
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Checkpoint, Clip, Job, Run, Singer, Song


async def make_singer(api: AsyncClient) -> str:
    return str((await api.post("/api/singers", json={"name": "Arif"})).json()["data"]["id"])


def add_song(engine: Engine, singer_id: str, era: str = "cassette") -> str:
    with Session(engine) as session:
        song = Song(singer_id=singer_id, original_filename="a.mp3", stored_path="x",
                    duration_s=240, status="ready", era=era)  # fmt: skip
        session.add(song)
        session.commit()
        return song.id


def add_clips(engine: Engine, singer_id: str, song_id: str, tmp: Path, seconds: float) -> None:
    with Session(engine) as session:
        for n in range(int(seconds // 10)):
            path = tmp / f"c{n}.wav"
            path.write_bytes(b"RIFF")
            session.add(Clip(singer_id=singer_id, song_id=song_id, path=str(path), start_s=n * 10,
                             duration_s=10, verdict="keep"))  # fmt: skip
        session.add(Clip(singer_id=singer_id, song_id=song_id, path=str(tmp / "r.wav"),
                         start_s=0, duration_s=5, verdict="reject", reason="silence"))  # fmt: skip
        session.commit()


def add_checkpoint(engine: Engine, singer_id: str, tmp: Path, epoch: int = 10) -> str:
    model_dir = tmp / "run" / "applio" / "voice"
    model_dir.mkdir(parents=True, exist_ok=True)
    pth = model_dir / f"voice_{epoch}e_{epoch * 40}s.pth"
    pth.write_bytes(b"weights")
    (model_dir / "added_voice.index").write_bytes(b"index")
    sample = tmp / f"sample{epoch}.wav"
    sample.write_bytes(b"RIFFsample")
    with Session(engine) as session:
        run = Run(singer_id=singer_id, applio_commit="abc", status="done")
        session.add(run)
        session.flush()
        ckpt = Checkpoint(run_id=run.id, epoch=epoch, step=epoch * 40, model_path=str(pth),
                          sample_path=str(sample), mel_loss=20.0, similarity=0.9)  # fmt: skip
        session.add(ckpt)
        session.commit()
        return ckpt.id


# --- prepare + dataset ---------------------------------------------------------------


async def test_prepare_queues_a_job_with_the_pipeline_stages(
    api: AsyncClient, engine: Engine
) -> None:
    singer_id = await make_singer(api)
    add_song(engine, singer_id)

    response = await api.post(f"/api/singers/{singer_id}/prepare", json={"preset": "cassette"})

    assert response.status_code == 202
    job = response.json()["data"]
    assert job["type"] == "prepare_dataset"
    assert job["params"] == {"singer_id": singer_id, "preset": "cassette"}
    assert [s["name"] for s in job["stages"]] == [
        "validate", "separate", "dereverb", "denoise", "slice", "qc",
    ]  # fmt: skip


async def test_prepare_needs_songs(api: AsyncClient) -> None:
    singer_id = await make_singer(api)

    response = await api.post(f"/api/singers/{singer_id}/prepare", json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "no_songs"


async def test_second_job_for_a_busy_singer_is_refused(api: AsyncClient, engine: Engine) -> None:
    singer_id = await make_singer(api)
    add_song(engine, singer_id)
    await api.post(f"/api/singers/{singer_id}/prepare", json={})

    response = await api.post(f"/api/singers/{singer_id}/prepare", json={})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "singer_busy"


async def test_dataset_summary(api: AsyncClient, engine: Engine, tmp_path: Path) -> None:
    singer_id = await make_singer(api)
    song_id = add_song(engine, singer_id, era="cassette")
    add_clips(engine, singer_id, song_id, tmp_path, seconds=360)

    data = (await api.get(f"/api/singers/{singer_id}/dataset")).json()["data"]

    assert data["usable_minutes"] == 6.0
    assert data["kept_clips"] == 36
    assert data["rejected"] == {"silence": 1}
    assert data["era_minutes"] == {"cassette": 6.0}
    assert data["gate"] == "warn_small"


async def test_clip_list_filter_override_and_audio(
    api: AsyncClient, engine: Engine, tmp_path: Path
) -> None:
    singer_id = await make_singer(api)
    add_clips(engine, singer_id, add_song(engine, singer_id), tmp_path, seconds=20)

    rejected = (await api.get(f"/api/singers/{singer_id}/clips?verdict=reject")).json()["data"]
    clip_id = rejected[0]["id"]
    (tmp_path / "r.wav").write_bytes(b"RIFFxxxx")
    patched = await api.patch(f"/api/clips/{clip_id}", json={"verdict": "keep"})
    audio = await api.get(f"/api/clips/{clip_id}/audio")

    assert len(rejected) == 1
    assert patched.json()["data"]["verdict"] == "keep"
    assert patched.json()["data"]["user_override"] is True
    assert audio.status_code == 200
    assert audio.content == b"RIFFxxxx"


# --- train + runs + checkpoints --------------------------------------------------------


async def test_train_refuses_without_enough_singing(
    api: AsyncClient, engine: Engine, tmp_path: Path
) -> None:
    singer_id = await make_singer(api)
    add_clips(engine, singer_id, add_song(engine, singer_id), tmp_path, seconds=120)

    response = await api.post(f"/api/singers/{singer_id}/train", json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "dataset_too_small"


async def test_train_creates_run_and_job(api: AsyncClient, engine: Engine, tmp_path: Path) -> None:
    singer_id = await make_singer(api)
    add_clips(engine, singer_id, add_song(engine, singer_id), tmp_path, seconds=900)

    response = await api.post(f"/api/singers/{singer_id}/train", json={"epochs": 60})

    assert response.status_code == 202
    data = response.json()["data"]
    assert data["job"]["type"] == "train"
    assert data["job"]["params"]["epochs"] == 60
    assert data["job"]["params"]["run_id"] == data["run"]["id"]
    runs = (await api.get(f"/api/singers/{singer_id}/runs")).json()["data"]
    assert [r["id"] for r in runs] == [data["run"]["id"]]


async def test_checkpoints_select_sample_and_export(
    api: AsyncClient, engine: Engine, tmp_path: Path
) -> None:
    singer_id = await make_singer(api)
    ckpt_id = add_checkpoint(engine, singer_id, tmp_path)
    with Session(engine) as session:
        run_id = session.scalars(select(Run.id)).one()

    listed = (await api.get(f"/api/runs/{run_id}/checkpoints")).json()["data"]
    selected = await api.post(f"/api/checkpoints/{ckpt_id}/select")
    sample = await api.get(f"/api/checkpoints/{ckpt_id}/sample")
    exported = await api.get(f"/api/checkpoints/{ckpt_id}/export")

    assert listed[0]["epoch"] == 10 and listed[0]["has_sample"] is True
    assert selected.json()["data"]["active_checkpoint_id"] == ckpt_id
    assert sample.content == b"RIFFsample"
    names = zipfile.ZipFile(io.BytesIO(exported.content)).namelist()
    assert sorted(names) == ["added_voice.index", "profile.json", "voice_10e_400s.pth"]


def voice_zip(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


async def test_import_old_notebook_zip(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    singer_id = await make_singer(api)
    data = voice_zip({"arif_50e_2000s.pth": b"w", "added_IVF_arif.index": b"i"})

    response = await api.post(
        f"/api/singers/{singer_id}/voices/import",
        files={"file": ("arif_voice.zip", data, "application/zip")},
    )

    assert response.status_code == 201, response.text
    with Session(engine) as session:
        singer = session.get(Singer, singer_id)
        ckpt = session.scalars(select(Checkpoint)).one()
    assert singer is not None and singer.active_checkpoint_id == ckpt.id
    assert ckpt.epoch == 50
    assert Path(ckpt.model_path).is_relative_to(settings.data_dir)


async def test_import_rejects_zip_slip_and_missing_files(api: AsyncClient) -> None:
    singer_id = await make_singer(api)
    evil = voice_zip({"../../evil.pth": b"x", "a.index": b"i"})
    empty = voice_zip({"readme.txt": b"hi"})

    r1 = await api.post(f"/api/singers/{singer_id}/voices/import",
                        files={"file": ("v.zip", evil, "application/zip")})  # fmt: skip
    r2 = await api.post(f"/api/singers/{singer_id}/voices/import",
                        files={"file": ("v.zip", empty, "application/zip")})  # fmt: skip

    assert r1.status_code == 422
    assert r2.status_code == 422
    assert r2.json()["error"]["code"] == "invalid_voice_zip"


async def test_run_detail_includes_profile(
    api: AsyncClient, engine: Engine, tmp_path: Path
) -> None:
    singer_id = await make_singer(api)
    add_checkpoint(engine, singer_id, tmp_path)
    with Session(engine) as session:
        run_id = session.scalars(select(Run.id)).one()
        jobs = session.scalars(select(Job)).all()

    data = (await api.get(f"/api/runs/{run_id}")).json()["data"]

    assert data["id"] == run_id
    assert data["checkpoint_count"] == 1
    assert jobs == []
    assert json.dumps(data)
