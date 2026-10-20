"""Resumable uploads (tus) and the media checks behind them (docs/04 §1, docs/05 E1/E2)."""

import base64
import shutil
import subprocess
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Song
from app.services.media import MediaError, probe, sniff_audio

TUS = {"Tus-Resumable": "1.0.0"}
FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


def make_wav(path: Path, seconds: float) -> Path:
    assert FFMPEG is not None
    subprocess.run(  # noqa: S603 - fixed test command
        [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=220:duration={seconds}",
         "-ar", "44100", str(path)],
        check=True,
    )  # fmt: skip
    return path


def metadata(**fields: str) -> str:
    return ",".join(
        f"{key} {base64.b64encode(value.encode()).decode()}" for key, value in fields.items()
    )


async def tus_upload(api: AsyncClient, data: bytes, **meta: str) -> tuple[int, str]:
    """Create + one PATCH. Returns (final status, upload id)."""
    created = await api.post(
        "/api/uploads/",
        headers={**TUS, "Upload-Length": str(len(data)), "Upload-Metadata": metadata(**meta)},
    )
    if created.status_code != 201:
        return created.status_code, ""
    location = created.headers["Location"]
    upload_id = location.rstrip("/").rsplit("/", 1)[-1]
    patched = await api.patch(
        f"/api/uploads/{upload_id}",
        content=data,
        headers={**TUS, "Upload-Offset": "0", "Content-Type": "application/offset+octet-stream"},
    )
    return patched.status_code, upload_id


async def make_singer(api: AsyncClient) -> str:
    response = await api.post("/api/singers", json={"name": "Arif"})
    return str(response.json()["data"]["id"])


# --- media checks -------------------------------------------------------------------


@needs_ffmpeg
def test_probe_reads_duration_and_codec(tmp_path: Path) -> None:
    wav = make_wav(tmp_path / "a.wav", 30)

    result = probe(wav)

    assert result.duration_s == pytest.approx(30, abs=0.1)
    assert result.codec == "pcm_s16le"


def test_sniff_rejects_non_audio(tmp_path: Path) -> None:
    fake = tmp_path / "song.mp3"
    fake.write_bytes(b"MZ\x90\x00" + b"\x00" * 300)  # a Windows executable header

    with pytest.raises(MediaError) as error:
        sniff_audio(fake)

    assert error.value.code == "not_audio"


@needs_ffmpeg
def test_sniff_accepts_wav(tmp_path: Path) -> None:
    sniff_audio(make_wav(tmp_path / "a.wav", 1))


def test_probe_rejects_garbage(tmp_path: Path) -> None:
    junk = tmp_path / "junk.wav"
    junk.write_bytes(b"RIFF" + b"\x00" * 100)

    with pytest.raises(MediaError) as error:
        probe(junk)

    assert error.value.code == "unreadable_audio"


# --- tus flow ---------------------------------------------------------------------


@needs_ffmpeg
async def test_dataset_upload_creates_a_song(
    api: AsyncClient, engine: Engine, settings: Settings, tmp_path: Path
) -> None:
    singer_id = await make_singer(api)
    data = make_wav(tmp_path / "x.wav", 30).read_bytes()

    status, _ = await tus_upload(
        api, data, singer_id=singer_id, filename="Lewa (1978).wav", era="cassette",
        purpose="dataset",
    )  # fmt: skip

    assert status == 204
    with Session(engine) as session:
        song = session.scalars(select(Song)).one()
    assert song.original_filename == "Lewa (1978).wav"
    assert song.era == "cassette"
    assert song.duration_s == pytest.approx(30, abs=0.1)
    stored = Path(song.stored_path)
    assert stored.is_file()
    assert stored.is_relative_to(settings.data_dir / "singers" / singer_id / "songs")
    assert "Lewa" not in stored.name  # user filenames are never paths


async def test_upload_for_unknown_singer_is_refused_before_any_bytes(api: AsyncClient) -> None:
    status, _ = await tus_upload(
        api, b"x" * 10, singer_id="nope", filename="a.wav", purpose="dataset"
    )

    assert status == 404


async def test_upload_needs_a_filename_and_purpose(api: AsyncClient) -> None:
    status, _ = await tus_upload(api, b"x" * 10, singer_id="x")

    assert status == 422


async def test_non_audio_upload_is_rejected_and_removed(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    singer_id = await make_singer(api)

    status, _ = await tus_upload(
        api, b"MZ\x90\x00" + b"\x00" * 500, singer_id=singer_id, filename="song.mp3",
        purpose="dataset",
    )  # fmt: skip

    assert status == 415
    with Session(engine) as session:
        assert session.scalars(select(Song)).all() == []
    songs_dir = settings.data_dir / "singers" / singer_id / "songs"
    assert not songs_dir.exists() or not any(songs_dir.iterdir())


@needs_ffmpeg
async def test_too_short_song_is_rejected(api: AsyncClient, tmp_path: Path) -> None:
    singer_id = await make_singer(api)
    data = make_wav(tmp_path / "x.wav", 5).read_bytes()

    status, _ = await tus_upload(
        api, data, singer_id=singer_id, filename="a.wav", purpose="dataset"
    )

    assert status == 422


@needs_ffmpeg
async def test_cover_upload_is_kept_ready_by_upload_id(
    api: AsyncClient, settings: Settings, tmp_path: Path
) -> None:
    data = make_wav(tmp_path / "x.wav", 30).read_bytes()

    status, upload_id = await tus_upload(api, data, filename="song.wav", purpose="cover")

    assert status == 204
    ready = list((settings.data_dir / "uploads" / "ready").glob(f"{upload_id}.*"))
    assert len(ready) == 1


@needs_ffmpeg
async def test_analysis_upload_is_kept_ready_with_its_display_name(
    api: AsyncClient, settings: Settings, tmp_path: Path
) -> None:
    data = make_wav(tmp_path / "x.wav", 10).read_bytes()

    status, upload_id = await tus_upload(api, data, filename="Laila (live).wav", purpose="analysis")

    assert status == 204
    assert len(list((settings.data_dir / "uploads" / "ready").glob(f"{upload_id}.*"))) == 1
    name = settings.data_dir / "uploads" / "names" / f"{upload_id}.txt"
    assert name.read_text(encoding="utf-8") == "Laila (live).wav"


async def test_tus_create_needs_the_csrf_header(api: AsyncClient) -> None:
    response = await api.post(
        "/api/uploads/",
        headers={**TUS, "Upload-Length": "10", "X-Requested-With": "",
                 "Upload-Metadata": metadata(filename="a.wav", purpose="cover")},
    )  # fmt: skip

    assert response.status_code == 403
