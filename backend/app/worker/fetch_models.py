"""Download every model the pipelines use (run once at install), so no job downloads
mid-run: separation models (RoFormer + Demucs) and the Analyse models (Whisper, CLAP).

cd backend
.venv/Scripts/python.exe -m app.worker.fetch_models
"""

import json
import sys

from app.config import Settings, get_settings
from app.worker.runner import run_streaming
from app.worker.stages.analyze import ANALYSIS_MODELS
from app.worker.stages.prepare import ALL_MODELS

SEPARATION_MODELS = list(dict.fromkeys([*ALL_MODELS, *ANALYSIS_MODELS]))


def missing_models(model_dir_files: set[str]) -> list[str]:
    return [m for m in SEPARATION_MODELS if m not in model_dir_files]


def missing_analysis_models(settings: Settings) -> list[str]:
    markers = {
        "whisper": settings.whisper_models_dir / "model.bin",
        "clap": settings.clap_models_dir / "config.json",
    }
    return [name for name, marker in markers.items() if not marker.is_file()]


def _run(args: list[str]) -> list[str]:
    failed: list[str] = []

    def on_line(line: str) -> None:
        if line.startswith('{"event": "model"'):
            event = json.loads(line)
            print(("ok      " if event["ok"] else "FAILED  ") + event["model"], flush=True)
            if not event["ok"]:
                failed.append(f"{event['model']}: {event['error']}")

    run_streaming(args, on_line)
    return failed


def main() -> int:
    settings = get_settings()
    python, scripts = str(settings.engine_python), settings.engine_scripts_dir
    folder = settings.separator_models_dir
    present = {p.name for p in folder.glob("*")} if folder.is_dir() else set()
    failed: list[str] = []
    todo = missing_models(present)
    if todo:
        script = str(scripts / "fetch_models.py")
        failed += _run([python, script, "--model-dir", str(folder), *todo])
    else:
        print("all separation models are already downloaded")
    if missing_analysis_models(settings):
        failed += _run([python, str(scripts / "fetch_analysis_models.py"),
                        "--whisper-dir", str(settings.whisper_models_dir),
                        "--clap-dir", str(settings.clap_models_dir)])  # fmt: skip
    else:
        print("Whisper and CLAP are already downloaded")
    for failure in failed:
        print(failure, file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
