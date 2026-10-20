"""Checks on uploaded audio before it enters the system (docs/04 §1, docs/05 E2).

1. Sniff the magic bytes: reject files that are clearly something else (an .exe renamed
   to .mp3). Formats the sniffer does not know are passed on to step 2.
2. ffprobe with a timeout: there must be an audio stream and a duration.
"""

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

import filetype

PROBE_TIMEOUT_S = 30
# filetype reports some audio containers under video/ or application/ mime types
AUDIO_CONTAINERS = {"video/mp4", "video/webm", "video/x-matroska", "application/ogg"}


class MediaError(Exception):
    def __init__(self, code: str, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


@dataclass(frozen=True)
class ProbeResult:
    duration_s: float
    codec: str
    bitrate: int | None


def sniff_audio(path: Path) -> None:
    kind = filetype.guess(str(path))
    if kind is None:
        return  # unknown to the sniffer; ffprobe decides
    if kind.mime.startswith("audio/") or kind.mime in AUDIO_CONTAINERS:
        return
    raise MediaError("not_audio", f"This file is {kind.mime}, not audio.", status=415)


def _ffprobe() -> str:
    found = shutil.which("ffprobe")
    if found is None:
        raise MediaError("ffprobe_missing", "ffprobe is not installed.", status=500)
    return found


def probe(path: Path) -> ProbeResult:
    try:
        result = subprocess.run(  # noqa: S603 - fixed argument list, no shell
            # -protocol_whitelist file: a "song" that is really an HLS playlist or concat
            # script cannot make ffprobe read other local files or open URLs
            [_ffprobe(), "-v", "error", "-protocol_whitelist", "file", "-show_entries",
             "format=duration,bit_rate:stream=codec_type,codec_name", "-of", "json", str(path)],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT_S, check=False,
        )  # fmt: skip
    except subprocess.TimeoutExpired as error:
        raise MediaError("unreadable_audio", "Reading the file took too long.") from error
    info = json.loads(result.stdout or "{}") if result.returncode == 0 else {}
    audio = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    duration = info.get("format", {}).get("duration")
    if not audio or duration is None:
        raise MediaError("unreadable_audio", "No playable audio found in this file.")
    bitrate = info.get("format", {}).get("bit_rate")
    return ProbeResult(
        duration_s=float(duration),
        codec=str(audio[0].get("codec_name", "unknown")),
        bitrate=int(bitrate) if bitrate else None,
    )


def safe_suffix(filename: str) -> str:
    """A lowercase extension from an allow-list, for naming stored files."""
    suffix = Path(filename).suffix.lower()
    allowed = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac", ".wma", ".webm"}
    return suffix if suffix in allowed else ".bin"
