"""Download separation models ahead of time. Runs INSIDE the engine venv.

    python fetch_models.py --model-dir <dir> model1.ckpt model2.ckpt ...

A job that has to download a model mid-run fails on the first network hiccup (seen in
the first end-to-end run: ConnectionResetError on the de-reverb model). Fetch them
once at install time instead; each model is retried a few times.
JSON lines: {"event": "model", "model": .., "ok": true|false, "error": ..}
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from audio_separator.separator import Separator

ATTEMPTS = 4


def fetch(separator: Separator, model: str) -> str | None:
    error = None
    for attempt in range(1, ATTEMPTS + 1):
        try:
            separator.download_model_and_data(model)
            return None
        except Exception as exc:  # network errors surface as many exception types
            error = f"{type(exc).__name__}: {exc}"
            time.sleep(2 * attempt)
    return error


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-download separation models.")
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("models", nargs="+")
    args = parser.parse_args()
    args.model_dir.mkdir(parents=True, exist_ok=True)
    separator = Separator(log_level=logging.WARNING, model_file_dir=str(args.model_dir),
                          info_only=True)  # fmt: skip
    failures = 0
    for model in args.models:
        error = fetch(separator, model)
        failures += error is not None
        print(json.dumps({"event": "model", "model": model, "ok": error is None,
                          "error": error}), flush=True)  # fmt: skip
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
