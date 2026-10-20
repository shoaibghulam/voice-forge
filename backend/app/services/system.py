"""Doctor checks, GPU status and benchmark results (docs/05 A3-A7, docs/08 task 0.3).

The doctor answers "will a job work on this machine?" before one is queued: every
check that once caused a silent failure in the old notebook is a named check here.
"""

import json
import shutil
import subprocess
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

import pynvml

from app.config import Settings
from app.worker.gpu import nvml_reader

MB = 2**20
MIN_FREE_GB = 10
TORCH_CACHE_S = 600
_torch_cache: dict[str, tuple[float, bool, str]] = {}


@dataclass(frozen=True)
class Check:
    id: str
    label: str
    ok: bool
    detail: str
    hint: str = ""


def _size_check(id_: str, label: str, path: Path, min_mb: int, hint: str) -> Check:
    size = path.stat().st_size // MB if path.is_file() else 0
    detail = f"{size} MB" if size else f"missing: {path}"
    return Check(id_, label, size >= min_mb, detail, "" if size >= min_mb else hint)


def _torch_cuda(settings: Settings) -> Check:
    python = settings.engine_python
    if not python.is_file():
        return Check(
            "engine_cuda",
            "Engine sees the GPU",
            False,
            "engine venv missing",
            "Create engine/.venv (see CLAUDE.md).",
        )
    cached = _torch_cache.get(str(python))
    if cached is None or time.monotonic() - cached[0] > TORCH_CACHE_S:
        probe = "import torch;print(torch.cuda.is_available(), torch.__version__)"
        result = subprocess.run(  # noqa: S603 - fixed interpreter and code, no shell
            [str(python), "-c", probe], capture_output=True, text=True, timeout=120, check=False
        )
        output = result.stdout.strip() or result.stderr.strip()[-200:]
        cached = (time.monotonic(), output.startswith("True"), output)
        _torch_cache[str(python)] = cached
    _, ok, output = cached
    hint = "" if ok else "Torch is CPU-only or broken: reinstall the engine venv with cu128."
    return Check("engine_cuda", "Engine sees the GPU", ok, output, hint)


def doctor(settings: Settings) -> dict[str, object]:
    root = settings.applio_root
    models = root / "rvc" / "models"
    prereq = "Run: core.py prerequisites --models --pretraineds-hifigan --exe"
    free_gb = shutil.disk_usage(settings.data_dir if settings.data_dir.exists() else Path.cwd())
    checks = [
        Check(
            "engine_python",
            "Engine Python",
            settings.engine_python.is_file(),
            str(settings.engine_python),
            "Create engine/.venv (see CLAUDE.md).",
        ),
        Check(
            "applio",
            "Applio checkout",
            (root / "core.py").is_file(),
            str(root),
            "Clone Applio into engine/applio.",
        ),
        Check(
            "applio_config",
            "Applio export config",
            (root / "assets/config.json").is_file(),
            "assets/config.json",
            "Copy assets/config_template.json to assets/config.json.",
        ),
        _size_check("rmvpe", "Pitch model (RMVPE)", models / "predictors/rmvpe.pt", 100, prereq),
        _size_check(
            "contentvec",
            "Content model (ContentVec)",
            models / "embedders/contentvec/pytorch_model.bin",
            100,
            prereq,
        ),
        _size_check(
            "pretrained",
            "Pretrained voice base (40k)",
            models / "pretraineds/hifi-gan/f0G40k.pth",
            10,
            prereq,
        ),
        Check(
            "ffmpeg",
            "ffmpeg and ffprobe",
            bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
            shutil.which("ffmpeg") or "not on PATH",
            "Install ffmpeg and add it to PATH.",
        ),
        Check(
            "disk",
            "Free disk space",
            free_gb.free // 2**30 >= MIN_FREE_GB,
            f"{free_gb.free // 2**30} GB free",
            f"Keep at least {MIN_FREE_GB} GB free.",
        ),
        _separator_models(settings),
        _analysis_models(settings),
        _torch_cuda(settings),
    ]
    # a passing check has nothing to fix: drop its hint so the UI doesn't show advice
    shown = [asdict(c) | ({"hint": ""} if c.ok else {}) for c in checks]
    return {"checks": shown, "ok": all(c.ok for c in checks)}


def _separator_models(settings: Settings) -> Check:
    from app.worker.fetch_models import SEPARATION_MODELS

    folder = settings.separator_models_dir
    missing = [m for m in SEPARATION_MODELS if not (folder / m).is_file()]
    detail = "all downloaded" if not missing else f"missing: {', '.join(missing)}"
    hint = "" if not missing else "Run: python -m app.worker.fetch_models (in backend/)."
    return Check("separator_models", "Separation models", not missing, detail, hint)


def _analysis_models(settings: Settings) -> Check:
    from app.worker.fetch_models import missing_analysis_models

    missing = missing_analysis_models(settings)
    detail = "Whisper and CLAP downloaded" if not missing else f"missing: {', '.join(missing)}"
    hint = "" if not missing else "Run: python -m app.worker.fetch_models (in backend/)."
    return Check("analysis_models", "Analyse models (lyrics, style)", not missing, detail, hint)


def gpu_status() -> dict[str, object]:
    try:
        pynvml.nvmlInit()
        handle = pynvml.nvmlDeviceGetHandleByIndex(0)
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)
        name = pynvml.nvmlDeviceGetName(handle)
        status: dict[str, object] = {
            "available": True,
            "name": name.decode() if isinstance(name, bytes) else str(name),
            "driver": str(pynvml.nvmlSystemGetDriverVersion()),
            "mem_total_mb": int(memory.total) // MB,
            "mem_used_mb": int(memory.used) // MB,
        }
    except pynvml.NVMLError as error:
        return {"available": False, "error": str(error)}
    sample = nvml_reader()()  # temperature and utilisation are best-effort (docs/05 A13)
    status["temp_c"] = sample.temp_c
    status["util"] = sample.util
    return status


def benchmarks(settings: Settings) -> dict[str, object]:
    folder = settings.data_dir / "benchmarks"
    runs = sorted(p for p in folder.glob("*/results.jsonl")) if folder.is_dir() else []
    if not runs:
        return {"measured_at": None, "rows": []}
    latest = runs[-1]
    rows = [json.loads(line) for line in latest.read_text(encoding="utf-8").splitlines() if line]
    return {"measured_at": _folder_time(latest.parent.name), "rows": rows}


def _folder_time(name: str) -> str:
    """'20261019T000740Z' (benchmark folder) -> '2026-10-19T00:07:40Z' (ISO-8601)."""
    try:
        moment = datetime.strptime(name, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    except ValueError:
        return name
    return moment.isoformat().replace("+00:00", "Z")
