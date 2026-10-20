"""Shared plumbing for stage functions: run an engine subprocess the safe way.

`run_engine` is the only way a stage starts engine work. It:
- passes the user's cancel through to the process-tree kill (`ctx.cancel`)
- streams every output line into the job log (`log.lines` events)
- samples the GPU once a second into `gpu.sample` events while the process runs
- turns cancel, timeout, CUDA OOM and non-zero exits into StageErrors with codes
It never treats a zero exit as success - callers verify their output files.
"""

import contextlib
import json
import re
import shutil
import subprocess
import threading
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any

from app.config import Settings, get_settings
from app.worker import applio
from app.worker.gpu import GpuSample, GpuSampler, PeakTracker, nvml_reader
from app.worker.runner import run_streaming
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages.logic import is_network_error, is_oom

OOM_HINT = "Close other GPU programs, or lower the batch size / segment size and resume."

_reader: Callable[[], GpuSample] | None = None
_reader_failed = False


def gpu_reader() -> Callable[[], GpuSample] | None:
    """The NVML reader, created once; None when NVML is unavailable."""
    global _reader, _reader_failed
    if _reader is None and not _reader_failed:
        try:
            _reader = nvml_reader()
        except Exception:
            _reader_failed = True
    return _reader


def settings() -> Settings:
    return get_settings()


def applio_paths() -> applio.ApplioPaths:
    s = settings()
    return applio.ApplioPaths(python=s.engine_python, root=s.applio_root)


def engine_script(name: str) -> list[str]:
    s = settings()
    return [str(s.engine_python), str(s.engine_scripts_dir / name)]


@contextlib.contextmanager
def _gpu_events(ctx: StageContext) -> Iterator[None]:
    reader = gpu_reader()
    if reader is None:
        yield
        return

    def on_sample(sample: GpuSample) -> None:
        ctx.events.emit("gpu.sample", asdict(sample))

    with GpuSampler(reader, PeakTracker(), on_sample=on_sample):
        yield


def run_engine(
    ctx: StageContext,
    args: Sequence[str],
    *,
    env: dict[str, str] | None = None,
    on_line: Callable[[str], None] | None = None,
    fail_code: str = "engine_failed",
    hint: str = "",
    timeout_s: float | None = None,
    keep_lines: bool = True,
    halt: threading.Event | None = None,
    log_output: bool = True,
) -> list[str]:
    """Run an engine command for this stage; return its output lines (if kept).

    `halt` lets the stage itself stop the process (pause or early stop at a checkpoint):
    the process tree is killed but, unlike a user cancel, no error is raised - the caller
    checks why it set `halt`.
    """
    lines: list[str] = []
    stop = halt or threading.Event()
    watcher_done = threading.Event()

    def watch_cancel() -> None:
        while not watcher_done.is_set():
            if ctx.cancel.is_set():
                stop.set()
                return
            watcher_done.wait(0.2)

    threading.Thread(target=watch_cancel, daemon=True).start()

    def handle(line: str) -> None:
        if keep_lines:
            lines.append(line)
        # Our engine scripts' JSON-lines protocol ({"event": ...}) is for the worker, not
        # the person reading the log; tool output (Applio, the separator) is still logged.
        if log_output and not line.startswith('{"event"'):
            ctx.events.log(line, stage=ctx.stage)
        if on_line is not None:
            on_line(line)

    try:
        with _gpu_events(ctx):
            result = run_streaming(
                args,
                handle,
                env=env,
                cwd=settings().applio_root,
                cancel=stop,
                timeout_s=timeout_s,
                tail_lines=80,
            )
    finally:
        watcher_done.set()
    ctx.events.flush()
    if result.cancelled and ctx.cancel.is_set():
        raise StageError("cancelled", "Cancelled by the user.")
    if result.cancelled:
        return lines  # halted on purpose by the stage
    if result.timed_out:
        raise StageError("timeout", f"The step took longer than {timeout_s} s and was stopped.")
    if is_oom(result.tail):
        raise StageError("cuda_oom", "The GPU ran out of memory.", hint=OOM_HINT)
    if result.returncode != 0:
        tail = " | ".join(result.tail[-3:])
        raise StageError(fail_code, f"Exited with code {result.returncode}: {tail}", hint=hint)
    return lines


def run_ffmpeg(*args: str) -> str:
    """Run ffmpeg with an argument list (no shell); its stderr, or a StageError."""
    binary = shutil.which("ffmpeg")
    if binary is None:
        raise StageError("ffmpeg_missing", "ffmpeg is not installed or not on PATH.")
    result = subprocess.run(  # noqa: S603 - argument list built by callers, no shell
        [binary, "-hide_banner", "-y", *args], capture_output=True, text=True, timeout=900
    )
    if result.returncode != 0:
        raise StageError("ffmpeg_failed", result.stderr.strip()[-400:])
    return result.stderr


def mean_db(path: Path) -> float:
    """Mean loudness of an audio file in dBFS (ffmpeg volumedetect); -91 if unreadable."""
    binary = shutil.which("ffmpeg")
    if binary is None:
        raise StageError("ffmpeg_missing", "ffmpeg is not installed or not on PATH.")
    result = subprocess.run(  # noqa: S603 - fixed argument list, no shell
        [binary, "-hide_banner", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    match = re.search(r"mean_volume: (-?[\d.]+) dB", result.stderr)
    return float(match.group(1)) if match else -91.0


def json_events(lines: Sequence[str]) -> list[dict[str, Any]]:
    """The JSON-lines events our engine scripts print, ignoring library log noise."""
    events = []
    for line in lines:
        if line.startswith("{"):
            with contextlib.suppress(json.JSONDecodeError):
                events.append(json.loads(line))
    return events


def progress(ctx: StageContext, done: int, total: int, unit: str, item: str = "") -> None:
    ctx.events.emit(
        "stage.progress",
        {"done": done, "total": total, "unit": unit, "item": item},
        stage=ctx.stage,
    )


def require(ctx: StageContext, key: str) -> str:
    value = ctx.params.get(key)
    if not isinstance(value, str) or not value:
        raise StageError("bad_params", f"Job parameter '{key}' is missing.")
    return value


SEGMENT = 256
OOM_SEGMENT = 128  # docs/04 §2: on CUDA OOM retry once with the smaller segment


def separate_stems(
    ctx: StageContext,
    model: str,
    source: Path,
    overlap: int,
    out_dir: Path | None = None,
) -> dict[str, str]:
    """Run separate.py with one model on one file; {lower-case stem label: path}.

    Retries once on a dropped model download and once (segment 128) on CUDA OOM."""

    def args(segment: int) -> list[str]:
        return [
            *engine_script("separate.py"),
            "--model", model,
            "--model-dir", str(settings().separator_models_dir),
            "--out-dir", str(out_dir or source.parent),
            "--segment", str(segment),
            "--overlap", str(overlap),
            str(source),
        ]  # fmt: skip

    try:
        lines = run_engine(ctx, args(SEGMENT), fail_code="separation_failed")
    except StageError as error:
        if error.code == "cuda_oom":
            ctx.events.emit(
                "stage.retry",
                {"reason": "cuda_oom", "change": {"segment": OOM_SEGMENT}},
                stage=ctx.stage,
            )
            lines = run_engine(ctx, args(OOM_SEGMENT), fail_code="separation_failed")
        elif is_network_error(error.message):
            lines = run_engine(ctx, args(SEGMENT), fail_code="separation_failed")
        else:
            raise
    done = [e for e in json_events(lines) if e.get("event") == "progress"]
    if not done or not isinstance(done[0].get("outputs"), dict):
        raise StageError("separation_failed", "The separator produced no output.")
    return {str(k).lower(): str(v) for k, v in done[0]["outputs"].items()}
