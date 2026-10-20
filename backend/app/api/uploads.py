"""Resumable uploads at /api/uploads/ (tus 1.0, via tuspyserver).

Upload metadata (tus `Upload-Metadata`): `filename` and `purpose` (`dataset` | `cover` |
`analysis`) always; `singer_id` and optional `era` for purpose `dataset`. The tus upload
id (last segment of the Location URL) is the `upload_id` a cover or analysis request
refers to.

- Before any bytes: the metadata is validated and disk space is checked.
- On completion: the file is sniffed and probed, then either becomes a Song
  (dataset) stored as `<song_id>.orig.<ext>` under the singer, or is kept at
  `uploads/ready/<upload_id>.<ext>` for a cover or an analysis (its display filename in
  `uploads/names/<upload_id>.txt`). A rejected file is deleted.
The user's filename is kept only as display metadata, never used in a path.
"""

import asyncio
import contextlib
import json
import os
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, cast

from fastapi import APIRouter, Depends
from sqlalchemy import Engine
from sqlalchemy.orm import Session
from tuspyserver import create_tus_router
from tuspyserver.storage.local import LocalFileStorage

from app.api.errors import ApiError, not_found
from app.config import Settings, get_settings
from app.db import new_id
from app.deps import get_engine, require_csrf
from app.models import Singer, Song
from app.services.media import MediaError, probe, safe_suffix, sniff_audio
from app.services.storage import save_upload_name, song_dir

ERAS = {"cassette", "vinyl", "studio", "live", "unknown"}
PURPOSES = {"dataset", "cover", "analysis"}
MIN_SONG_S = 20
MAX_SONG_S = 20 * 60
DISK_HEADROOM_BYTES = 2 * 2**30


def _validate_metadata(engine: Engine, metadata: dict[str, str]) -> None:
    purpose = metadata.get("purpose", "")
    if purpose not in PURPOSES or not metadata.get("filename"):
        raise ApiError(422, "invalid_upload", "Uploads need a filename and a purpose.")
    if metadata.get("era", "unknown") not in ERAS:
        raise ApiError(422, "invalid_upload", "Unknown era.")
    if purpose == "dataset":
        with Session(engine) as session:
            if session.get(Singer, metadata.get("singer_id", "")) is None:
                raise not_found("singer")


def _in_flight_bytes(settings: Settings) -> int:
    """Space already promised to unfinished uploads (their declared lengths)."""
    total = 0
    for info in (settings.data_dir / "uploads" / "tmp").glob("*.info"):
        try:
            total += int(json.loads(info.read_text(encoding="utf-8")).get("size") or 0)
        except (OSError, ValueError):
            continue
    return total


def _check_space(settings: Settings, size: int | None) -> None:
    # tuspyserver only advertises max_size; it does not enforce it, and a deferred length
    # would skip every check here (security review M1). Require the length up front.
    if size is None:
        raise ApiError(411, "length_required", "Uploads must declare their size up front.")
    limit = settings.max_upload_mb * 2**20
    if size > limit:
        message = f"Files over {settings.max_upload_mb} MB are refused."
        raise ApiError(413, "file_too_large", message)
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(settings.data_dir).free
    if free < size + _in_flight_bytes(settings) + DISK_HEADROOM_BYTES:
        raise ApiError(507, "disk_full", "Not enough free disk space for this upload.")


def pre_create_dep(
    engine: Annotated[Engine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Callable[[dict[str, str], dict[str, object]], None]:
    def hook(metadata: dict[str, str], info: dict[str, object]) -> None:
        _validate_metadata(engine, metadata)
        size = info.get("size")
        _check_space(settings, size if isinstance(size, int) else None)

    return hook


def _discard(path: Path) -> None:
    path.unlink(missing_ok=True)
    Path(f"{path}.info").unlink(missing_ok=True)


def _store_song(engine: Engine, settings: Settings, path: Path, metadata: dict[str, str]) -> None:
    result = probe(path)
    if not MIN_SONG_S <= result.duration_s <= MAX_SONG_S:
        raise MediaError("bad_duration", "Songs must be between 20 seconds and 20 minutes.")
    singer_id = metadata["singer_id"]
    song_id = new_id()
    folder = song_dir(settings, singer_id)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{song_id}.orig{safe_suffix(metadata['filename'])}"
    shutil.move(path, dest)
    Path(f"{path}.info").unlink(missing_ok=True)
    with Session(engine) as session:
        session.add(
            Song(
                id=song_id,
                singer_id=singer_id,
                original_filename=metadata["filename"][:255],
                stored_path=str(dest),
                duration_s=result.duration_s,
                codec=result.codec,
                bitrate=result.bitrate,
                era=metadata.get("era", "unknown"),
                status="uploaded",
            )
        )
        session.commit()


def _store_cover_input(settings: Settings, path: Path, metadata: dict[str, str]) -> None:
    result = probe(path)
    if result.duration_s > MAX_SONG_S:
        raise MediaError("bad_duration", "Songs longer than 20 minutes are not supported.")
    ready = settings.data_dir / "uploads" / "ready"
    ready.mkdir(parents=True, exist_ok=True)
    shutil.move(path, ready / f"{path.name}{safe_suffix(metadata['filename'])}")
    Path(f"{path}.info").unlink(missing_ok=True)
    save_upload_name(settings, path.name, metadata["filename"])


def _finish(engine: Engine, settings: Settings, path: Path, metadata: dict[str, str]) -> None:
    try:
        sniff_audio(path)
        if metadata.get("purpose") == "dataset":
            _store_song(engine, settings, path, metadata)
        else:
            _store_cover_input(settings, path, metadata)
    except MediaError as error:
        _discard(path)
        raise ApiError(error.status, error.code, error.message) from error


def complete_dep(
    engine: Annotated[Engine, Depends(get_engine)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> Callable[[str, dict[str, str]], Awaitable[None]]:
    async def on_complete(file_path: str, metadata: dict[str, str]) -> None:
        await asyncio.to_thread(_finish, engine, settings, Path(file_path), metadata)

    return on_complete


class WindowsSafeStorage(LocalFileStorage):
    """tuspyserver 4.4.2 saves its .info sidecar with os.rename, which on Windows fails
    with WinError 183 once the file exists - i.e. on the second write of every upload.
    os.replace is the cross-platform atomic overwrite."""

    async def write_info(self, uid: str, data: dict[str, object]) -> None:
        def _do() -> None:
            self._ensure_dir()
            path = self._info_path(uid)
            tmp = f"{path}.tmp"
            try:
                with open(tmp, "w", encoding="utf-8") as fh:
                    fh.write(json.dumps(data, indent=4, default=str))
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, path)
            except Exception:
                with contextlib.suppress(OSError):
                    os.remove(tmp)
                raise

        await asyncio.to_thread(_do)


def build_router(settings: Settings) -> APIRouter:
    files_dir = settings.data_dir / "uploads" / "tmp"
    files_dir.mkdir(parents=True, exist_ok=True)
    # The library's hints say zero-arg callables, but it passes these to FastAPI's
    # Depends(), which resolves their parameters - so typed dependencies work.
    router = create_tus_router(
        prefix="api/uploads",
        files_dir=str(files_dir),
        max_size=settings.max_upload_mb * 2**20,
        auth=require_csrf,  # type: ignore[arg-type]
        pre_create_dep=pre_create_dep,
        upload_complete_dep=complete_dep,  # type: ignore[arg-type]
        storage=WindowsSafeStorage(str(files_dir)),
        tags=["uploads"],
    )
    return cast(APIRouter, router)
