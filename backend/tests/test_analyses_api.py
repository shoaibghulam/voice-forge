"""Analyse routes (docs/06 "Analyses"): upload → analyze job → lyrics + style + timeline."""

from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Analysis, Job
from app.services import analyses as service

LYRICS = {
    "language": "fa",
    "language_probability": 0.94,
    "approximate": False,
    "segments": [
        {"start": 0.1, "end": 7.1, "text": "کاشی ملگو"},
        {"start": 7.1, "end": 19.2, "text": "دس وات تو"},
    ],
}
STYLE = {
    "tempo_bpm": 107.7,
    "tempo_confidence": 0.87,
    "key": "A#",
    "scale": "major",
    "key_confidence": 0.6,
    "loudness_dbfs": -16.6,
    "loudness_lufs": -12.1,
    "instruments": {
        "stems": {"vocals": 48.5, "drums": 5.1, "bass": 0.0, "other": 46.4},
        "tags": [{"label": "dhol", "score": 0.28}],
    },
    "genre": [{"label": "Pakistani folk", "score": 0.27}],
    "mood": [{"label": "happy", "score": 0.33}],
}


def ready_upload(settings: Settings, upload_id: str = "abc123", name: str | None = None) -> str:
    folder = settings.data_dir / "uploads" / "ready"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{upload_id}.mp3").write_bytes(b"ID3song")
    if name is not None:
        names = settings.data_dir / "uploads" / "names"
        names.mkdir(parents=True, exist_ok=True)
        (names / f"{upload_id}.txt").write_text(name, encoding="utf-8")
    return upload_id


async def create(api: AsyncClient, settings: Settings, **body: object) -> dict[str, object]:
    upload_id = ready_upload(settings, name="Laila (live).mp3")
    response = await api.post("/api/analyses", json={"upload_id": upload_id, **body})
    assert response.status_code == 202, response.text
    data: dict[str, object] = response.json()["data"]
    return data


def store_result(engine: Engine, analysis_id: str, result: dict[str, object]) -> None:
    with Session(engine) as session:
        row = session.get(Analysis, analysis_id)
        assert row is not None
        row.result_json = result
        session.commit()


async def test_create_queues_an_analyze_job(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    analysis = await create(api, settings, language="bal")

    assert analysis["status"] == "queued"
    assert analysis["language_hint"] == "bal"
    assert analysis["original_filename"] == "Laila (live).mp3"
    assert analysis["result"] == {
        "duration_s": None, "lyrics": None, "style": None, "sections": None,
    }  # fmt: skip
    assert analysis["lyrics_text"] is None
    with Session(engine) as session:
        job = session.get(Job, str(analysis["job_id"]))
        assert job is not None and job.type == "analyze" and job.singer_id is None
        assert job.params_json["language"] == "bal"
        assert Path(str(job.params_json["input_path"])).is_file()
    assert not list((settings.data_dir / "uploads" / "ready").glob("*"))  # moved, not copied
    assert not list((settings.data_dir / "uploads" / "names").glob("*"))


async def test_language_defaults_to_auto(api: AsyncClient, settings: Settings) -> None:
    response = await api.post("/api/analyses", json={"upload_id": ready_upload(settings)})

    assert response.status_code == 202
    assert response.json()["data"]["language_hint"] == "auto"
    assert response.json()["data"]["original_filename"] == "song.mp3"


async def test_unknown_upload_is_404(api: AsyncClient) -> None:
    response = await api.post("/api/analyses", json={"upload_id": "missing"})

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "upload_not_found"


async def test_bad_language_and_upload_ids_are_refused(
    api: AsyncClient, settings: Settings
) -> None:
    bad_language = await api.post(
        "/api/analyses", json={"upload_id": ready_upload(settings), "language": "de"}
    )
    traversal = await api.post("/api/analyses", json={"upload_id": "../../app"})

    assert bad_language.status_code == 422
    assert traversal.status_code == 422


async def test_create_needs_the_csrf_header(api: AsyncClient, settings: Settings) -> None:
    response = await api.post(
        "/api/analyses",
        json={"upload_id": ready_upload(settings)},
        headers={"X-Requested-With": ""},
    )

    assert response.status_code == 403


async def test_partial_result_is_served_while_running(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    analysis = await create(api, settings)
    store_result(engine, str(analysis["id"]), {"duration_s": 193.0, "lyrics": LYRICS})

    got = (await api.get(f"/api/analyses/{analysis['id']}")).json()["data"]

    assert got["result"]["duration_s"] == 193.0
    assert got["result"]["lyrics"]["segments"][1]["text"] == "دس وات تو"
    assert got["result"]["style"] is None
    assert got["result"]["sections"] is None


async def test_corrupt_stored_parts_are_dropped_not_served(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    analysis = await create(api, settings)
    store_result(engine, str(analysis["id"]), {"lyrics": {"segments": "nope"}, "style": STYLE})

    got = (await api.get(f"/api/analyses/{analysis['id']}")).json()["data"]

    assert got["result"]["lyrics"] is None
    assert got["result"]["style"]["key"] == "A#"


async def test_list_is_newest_first(api: AsyncClient, settings: Settings) -> None:
    first = await create(api, settings)
    second = await create(api, settings)

    items = (await api.get("/api/analyses")).json()["data"]

    assert [a["id"] for a in items] == [second["id"], first["id"]]


async def test_get_unknown_analysis_is_404(api: AsyncClient) -> None:
    response = await api.get("/api/analyses/nope")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "analysis_not_found"


async def test_user_can_edit_and_clear_the_lyrics(api: AsyncClient, settings: Settings) -> None:
    analysis = await create(api, settings)
    url = f"/api/analyses/{analysis['id']}"

    edited = await api.patch(url, json={"lyrics_text": "line one\nline two"})
    cleared = await api.patch(url, json={"lyrics_text": None})

    assert edited.status_code == 200
    assert edited.json()["data"]["lyrics_text"] == "line one\nline two"
    assert cleared.json()["data"]["lyrics_text"] is None


async def test_lyrics_edit_is_limited_in_size(api: AsyncClient, settings: Settings) -> None:
    analysis = await create(api, settings)

    response = await api.patch(
        f"/api/analyses/{analysis['id']}", json={"lyrics_text": "x" * 50_001}
    )

    assert response.status_code == 422


async def test_audio_is_served_once_written(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    analysis = await create(api, settings)
    base = f"/api/analyses/{analysis['id']}/audio"

    original = await api.get(f"{base}/original")
    vocals_missing = await api.get(f"{base}/vocals")
    folder = service.analysis_folder(settings, str(analysis["id"]))
    (folder / "vocals.wav").write_bytes(b"RIFFdata")
    vocals = await api.get(f"{base}/vocals")
    unknown = await api.get(f"{base}/drums")
    listed = (await api.get(f"/api/analyses/{analysis['id']}")).json()["data"]["audio"]

    assert original.status_code == 200 and original.content == b"ID3song"
    assert vocals_missing.status_code == 404
    assert vocals_missing.json()["error"]["code"] == "audio_missing"
    assert vocals.status_code == 200 and vocals.headers["content-type"] == "audio/wav"
    assert unknown.status_code == 404
    assert listed["vocals"].endswith("/audio/vocals")
    assert listed["accompaniment"] is None


async def test_export_txt_prefers_the_edited_lyrics(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    analysis = await create(api, settings)
    url = f"/api/analyses/{analysis['id']}"
    store_result(engine, str(analysis["id"]), {"lyrics": LYRICS})

    detected = await api.get(f"{url}/export", params={"format": "txt"})
    await api.patch(url, json={"lyrics_text": "my own words"})
    edited = await api.get(f"{url}/export", params={"format": "txt"})

    assert detected.status_code == 200
    assert detected.text == "کاشی ملگو\nدس وات تو\n"
    assert "attachment" in detected.headers["content-disposition"]
    assert "Laila" in detected.headers["content-disposition"]
    assert edited.text == "my own words\n"


async def test_export_json_carries_the_whole_analysis(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    analysis = await create(api, settings)
    store_result(engine, str(analysis["id"]), {"lyrics": LYRICS, "style": STYLE})

    response = await api.get(f"/api/analyses/{analysis['id']}/export", params={"format": "json"})
    bad = await api.get(f"/api/analyses/{analysis['id']}/export", params={"format": "pdf"})

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["result"]["style"]["tempo_bpm"] == 107.7
    assert bad.status_code == 422


async def test_analyze_jobs_carry_their_analysis_id(api: AsyncClient, settings: Settings) -> None:
    analysis = await create(api, settings)

    job = (await api.get(f"/api/jobs/{analysis['job_id']}")).json()["data"]

    assert job["analysis_id"] == analysis["id"]
    assert job["label"] == "Analysis"
    assert [s["name"] for s in job["stages"]] == ["separate", "lyrics", "style", "sections"]
