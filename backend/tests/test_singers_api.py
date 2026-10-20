"""Singers and songs API (docs/06), the error envelope, and the cross-site header check."""

from httpx import AsyncClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Clip, Song
from app.worker.job_queue import claim_next, enqueue

CONSENT = {"living_consent": True, "estate_permission": False, "notes": "recorded 2026"}


async def create_singer(api: AsyncClient, name: str = "Arif Baloch") -> dict:
    response = await api.post("/api/singers", json={"name": name, "consent": CONSENT})
    assert response.status_code == 201, response.text
    return response.json()["data"]


def add_song(engine: Engine, singer_id: str, filename: str = "a.mp3") -> str:
    with Session(engine) as session:
        song = Song(
            singer_id=singer_id,
            original_filename=filename,
            stored_path="x.wav",
            duration_s=240.0,
            status="ready",
        )
        session.add(song)
        session.commit()
        return song.id


async def test_create_and_get_singer(api: AsyncClient) -> None:
    singer = await create_singer(api)

    response = await api.get(f"/api/singers/{singer['id']}")

    data = response.json()["data"]
    assert data["name"] == "Arif Baloch"
    assert data["consent"] == CONSENT
    assert data["usable_minutes"] == 0
    assert data["song_count"] == 0


async def test_list_singers_includes_usable_minutes(api: AsyncClient, engine: Engine) -> None:
    singer = await create_singer(api)
    song_id = add_song(engine, singer["id"])
    with Session(engine) as session:
        session.add_all(
            [
                Clip(singer_id=singer["id"], song_id=song_id, path="c1", start_s=0,
                     duration_s=90, verdict="keep"),
                Clip(singer_id=singer["id"], song_id=song_id, path="c2", start_s=90,
                     duration_s=30, verdict="reject", reason="silence"),
            ]
        )  # fmt: skip
        session.commit()

    response = await api.get("/api/singers")

    [row] = response.json()["data"]
    assert row["usable_minutes"] == 1.5
    assert row["song_count"] == 1
    assert response.json()["page"]["total"] == 1


async def test_singer_reports_active_voice_label_and_model_count(
    api: AsyncClient, engine: Engine
) -> None:
    from app.models import Checkpoint, Run

    singer = await create_singer(api)
    with Session(engine) as session:
        first = Run(singer_id=singer["id"], applio_commit="a", status="done")
        second = Run(singer_id=singer["id"], applio_commit="a", status="done")
        session.add(first)
        session.flush()
        session.add(second)
        session.flush()
        session.add(Checkpoint(run_id=first.id, epoch=10, step=1, model_path="a.pth"))
        chosen = Checkpoint(run_id=second.id, epoch=40, step=2, model_path="b.pth")
        session.add(chosen)
        session.commit()
        chosen_id = chosen.id
    await api.post(f"/api/checkpoints/{chosen_id}/select")

    data = (await api.get(f"/api/singers/{singer['id']}")).json()["data"]

    assert data["active_voice_label"] == "run 2 · epoch 40"
    assert data["model_count"] == 2


async def test_singer_without_voice_has_no_label(api: AsyncClient) -> None:
    singer = await create_singer(api)

    assert singer["active_voice_label"] is None
    assert singer["model_count"] == 0


async def test_blank_name_is_rejected_with_envelope(api: AsyncClient) -> None:
    response = await api.post("/api/singers", json={"name": "  ", "consent": CONSENT})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


async def test_rename_singer(api: AsyncClient) -> None:
    singer = await create_singer(api)

    response = await api.patch(f"/api/singers/{singer['id']}", json={"name": "Arif"})

    assert response.json()["data"]["name"] == "Arif"


async def test_unknown_singer_is_404_envelope(api: AsyncClient) -> None:
    response = await api.get("/api/singers/nope")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "singer_not_found"


async def test_delete_singer_removes_rows_and_files(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    singer = await create_singer(api)
    add_song(engine, singer["id"])
    folder = settings.data_dir / "singers" / singer["id"]
    folder.mkdir(parents=True)
    (folder / "x.wav").write_bytes(b"x")

    response = await api.delete(f"/api/singers/{singer['id']}")

    assert response.status_code == 204
    assert not folder.exists()
    assert (await api.get(f"/api/singers/{singer['id']}")).status_code == 404


async def test_delete_refused_while_a_job_runs_for_the_singer(
    api: AsyncClient, engine: Engine
) -> None:
    singer = await create_singer(api)
    enqueue(engine, "train", ["a"], singer_id=singer["id"])
    claim_next(engine, worker_pid=1, now="2026-10-19T00:00:00.000Z", lease_s=60)

    response = await api.delete(f"/api/singers/{singer['id']}")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "singer_busy"


async def test_list_and_update_songs(api: AsyncClient, engine: Engine) -> None:
    singer = await create_singer(api)
    song_id = add_song(engine, singer["id"], "Lewa (1978 cassette).mp3")

    listed = (await api.get(f"/api/singers/{singer['id']}/songs")).json()["data"]
    updated = await api.patch(f"/api/songs/{song_id}", json={"era": "cassette"})

    assert listed[0]["original_filename"] == "Lewa (1978 cassette).mp3"
    assert updated.json()["data"]["era"] == "cassette"


async def test_invalid_era_is_rejected(api: AsyncClient, engine: Engine) -> None:
    singer = await create_singer(api)
    song_id = add_song(engine, singer["id"])

    response = await api.patch(f"/api/songs/{song_id}", json={"era": "future"})

    assert response.status_code == 422


async def test_delete_song(api: AsyncClient, engine: Engine) -> None:
    singer = await create_singer(api)
    song_id = add_song(engine, singer["id"])

    assert (await api.delete(f"/api/songs/{song_id}")).status_code == 204
    assert (await api.get(f"/api/singers/{singer['id']}/songs")).json()["data"] == []


async def test_mutation_without_csrf_header_is_forbidden(api: AsyncClient) -> None:
    response = await api.post(
        "/api/singers",
        json={"name": "x", "consent": CONSENT},
        headers={"X-Requested-With": ""},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "missing_csrf_header"


async def test_reads_do_not_need_the_header(api: AsyncClient) -> None:
    response = await api.get("/api/singers", headers={"X-Requested-With": ""})

    assert response.status_code == 200


def test_singer_dir_rejects_ids_that_escape_the_data_folder(settings: Settings) -> None:
    from app.services.storage import UnsafePathError, singer_dir

    assert singer_dir(settings, "abc").is_relative_to(settings.data_dir)
    for bad in ("..", "../x", "a/b", "a\\b", "C:", ""):
        try:
            singer_dir(settings, bad)
        except UnsafePathError:
            continue
        raise AssertionError(f"accepted {bad!r}")
