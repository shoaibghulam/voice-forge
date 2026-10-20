"""Download the Analyse models ahead of time. Runs INSIDE the engine venv.

    python fetch_analysis_models.py --whisper-dir <dir> --clap-dir <dir>

Jobs never download mid-run (a dropped connection fails the job; seen in the first
end-to-end run), so the lyrics and style models are fetched once at install time:

- Whisper large-v3-turbo in CTranslate2 format (faster-whisper), ~1.6 GB
- CLAP `laion/clap-htsat-unfused` (zero-shot instrument / genre / mood tags), ~0.6 GB

JSON lines: {"event": "model", "model": .., "ok": true|false, "error": ..}
"""

import argparse
import json
import sys
import time
from collections.abc import Callable
from pathlib import Path

WHISPER_MODEL = "large-v3-turbo"
CLAP_REPO = "laion/clap-htsat-unfused"
ATTEMPTS = 4


def fetch_whisper(folder: Path) -> None:
    from faster_whisper.utils import download_model

    download_model(WHISPER_MODEL, output_dir=str(folder))
    if not (folder / "model.bin").is_file():
        raise RuntimeError("model.bin missing after download")


def fetch_clap(folder: Path) -> None:
    from huggingface_hub import HfApi, snapshot_download

    files = HfApi().list_repo_files(CLAP_REPO)
    # one copy of the weights is enough: prefer safetensors over the pickle file
    weights = "*.safetensors" if any(f.endswith(".safetensors") for f in files) else "*.bin"
    snapshot_download(CLAP_REPO, local_dir=str(folder), allow_patterns=["*.json", "*.txt", weights])
    if not (folder / "config.json").is_file():
        raise RuntimeError("config.json missing after download")


def attempt(fetch: Callable[[Path], None], folder: Path) -> str | None:
    error = None
    for tries in range(1, ATTEMPTS + 1):
        try:
            folder.mkdir(parents=True, exist_ok=True)
            fetch(folder)
            return None
        except Exception as exc:  # network errors surface as many exception types
            error = f"{type(exc).__name__}: {exc}"
            time.sleep(2 * tries)
    return error


def main() -> int:
    parser = argparse.ArgumentParser(description="Pre-download the Analyse models.")
    parser.add_argument("--whisper-dir", required=True, type=Path)
    parser.add_argument("--clap-dir", required=True, type=Path)
    args = parser.parse_args()
    failures = 0
    jobs = [(f"whisper {WHISPER_MODEL}", fetch_whisper, args.whisper_dir),
            (f"clap {CLAP_REPO}", fetch_clap, args.clap_dir)]  # fmt: skip
    for name, fetch, folder in jobs:
        error = attempt(fetch, folder)
        failures += error is not None
        print(json.dumps({"event": "model", "model": name, "ok": error is None,
                          "error": error}), flush=True)  # fmt: skip
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
