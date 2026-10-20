"""Security review fixes: host check (DNS rebinding), Windows zip-slip, upload limits."""

import base64
import io
import zipfile
from pathlib import Path

from httpx import AsyncClient
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Checkpoint


def voice_zip(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    return buffer.getvalue()


async def make_singer(api: AsyncClient) -> str:
    return str((await api.post("/api/singers", json={"name": "A"})).json()["data"]["id"])


async def test_foreign_host_header_is_rejected(api: AsyncClient) -> None:
    """DNS rebinding: evil.example resolved to 127.0.0.1 still sends Host: evil.example."""
    response = await api.get("/api/singers", headers={"Host": "evil.example:8000"})

    assert response.status_code == 400


async def test_localhost_hosts_are_accepted(api: AsyncClient) -> None:
    for host in ("127.0.0.1:8000", "localhost:8000", "localhost:5173"):
        response = await api.get("/api/singers", headers={"Host": host})
        assert response.status_code == 200, host


async def test_windows_backslash_traversal_in_zip_is_refused(
    api: AsyncClient, tmp_path: Path
) -> None:
    singer_id = await make_singer(api)
    evil = voice_zip({"..\\..\\..\\evil.pth": b"x", "a.index": b"i"})

    response = await api.post(
        f"/api/singers/{singer_id}/voices/import",
        files={"file": ("v.zip", evil, "application/zip")},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_voice_zip"


async def test_imported_files_get_server_chosen_names(
    api: AsyncClient, engine: Engine, settings: Settings
) -> None:
    singer_id = await make_singer(api)
    data = voice_zip({"arif_50e_2000s.pth": b"w", "added_IVF_arif.index": b"i"})

    response = await api.post(
        f"/api/singers/{singer_id}/voices/import",
        files={"file": ("v.zip", data, "application/zip")},
    )

    assert response.status_code == 201
    with Session(engine) as session:
        ckpt = session.scalars(select(Checkpoint)).one()
    model = Path(ckpt.model_path)
    assert model.name == "voice_50e_2000s.pth"  # epoch/step kept, name is ours
    assert [p.name for p in model.parent.glob("*.index")] == ["voice_0.index"]
    assert model.is_relative_to(settings.data_dir)


async def test_zip_with_too_many_files_is_refused(api: AsyncClient) -> None:
    singer_id = await make_singer(api)
    entries = {"v_1e_1s.pth": b"w", **{f"x{n}.index": b"i" for n in range(12)}}

    response = await api.post(
        f"/api/singers/{singer_id}/voices/import",
        files={"file": ("v.zip", voice_zip(entries), "application/zip")},
    )

    assert response.status_code == 422


async def test_import_for_unknown_singer_writes_nothing(
    api: AsyncClient, settings: Settings
) -> None:
    data = voice_zip({"v_1e_1s.pth": b"w", "a.index": b"i"})

    response = await api.post(
        "/api/singers/nope/voices/import", files={"file": ("v.zip", data, "application/zip")}
    )

    assert response.status_code == 404
    assert not (settings.data_dir / "singers").exists()


async def test_deferred_length_uploads_are_refused(api: AsyncClient) -> None:
    filename = base64.b64encode(b"a.wav").decode()
    purpose = base64.b64encode(b"cover").decode()
    meta = f"filename {filename},purpose {purpose}"

    response = await api.post(
        "/api/uploads/",
        headers={"Tus-Resumable": "1.0.0", "Upload-Defer-Length": "1", "Upload-Metadata": meta},
    )

    assert response.status_code == 411
    assert response.json()["error"]["code"] == "length_required"
