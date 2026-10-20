"""Paths under DATA_DIR. Every path is built from server-generated ids and checked to
stay inside the data folder (docs/03 "Data on disk"); user filenames are never used."""

import re
import shutil
from pathlib import Path

from app.config import Settings

_SAFE_ID = re.compile(r"^[A-Za-z0-9-]{1,64}$")


class UnsafePathError(ValueError):
    pass


def _child(root: Path, *parts: str) -> Path:
    for part in parts:
        if not _SAFE_ID.match(part):
            raise UnsafePathError(f"unsafe path component: {part!r}")
    path = root.joinpath(*parts).resolve()
    if not path.is_relative_to(root.resolve()):
        raise UnsafePathError(f"path escapes {root}: {path}")
    return path


def singer_dir(settings: Settings, singer_id: str) -> Path:
    return _child(settings.data_dir / "singers", singer_id)


def song_dir(settings: Settings, singer_id: str) -> Path:
    return singer_dir(settings, singer_id) / "songs"


def stems_dir(settings: Settings, singer_id: str, song_id: str) -> Path:
    return _child(singer_dir(settings, singer_id) / "stems", song_id)


def run_dir(settings: Settings, singer_id: str, run_id: str) -> Path:
    return _child(singer_dir(settings, singer_id) / "runs", run_id)


def cover_dir(settings: Settings, cover_id: str) -> Path:
    return _child(settings.data_dir / "covers", cover_id)


def analysis_dir(settings: Settings, analysis_id: str) -> Path:
    return _child(settings.data_dir / "analyses", analysis_id)


def ready_upload(settings: Settings, upload_id: str) -> Path | None:
    """A finished cover/analysis upload, kept as uploads/ready/<upload_id>.<ext>."""
    folder = _child(settings.data_dir / "uploads", "ready")
    _child(folder, upload_id)  # validates the id
    matches = sorted(folder.glob(f"{upload_id}.*"))
    return matches[0] if matches else None


def _name_file(settings: Settings, upload_id: str) -> Path:
    path = _child(settings.data_dir / "uploads" / "names", upload_id)
    return path.with_name(f"{path.name}.txt")


def save_upload_name(settings: Settings, upload_id: str, filename: str) -> None:
    """The user's filename of a ready upload: display metadata only, never a path."""
    path = _name_file(settings, upload_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(filename[:255], encoding="utf-8")


def take_upload_name(settings: Settings, upload_id: str) -> str | None:
    """Read and forget the saved filename of an upload (None if it was never saved)."""
    path = _name_file(settings, upload_id)
    if not path.is_file():
        return None
    name = path.read_text(encoding="utf-8").strip()
    path.unlink(missing_ok=True)
    return name or None


def remove_tree(path: Path, settings: Settings) -> None:
    """Delete a folder, but only one inside the data folder."""
    if not path.resolve().is_relative_to(settings.data_dir.resolve()):
        raise UnsafePathError(f"refusing to delete outside the data folder: {path}")
    shutil.rmtree(path, ignore_errors=True)
