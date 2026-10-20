"""Pitch statistics of a vocal with Applio's RMVPE. Runs INSIDE the engine venv.

    python f0_stats.py --applio-root <dir> <vocal.wav>

Prints one JSON line: {"median_hz", "p05_hz", "p95_hz", "voiced_ratio"}. Used for the
automatic octave match of a cover (docs/04 §9c): the source vocal's median against the
trained singer's median.
"""

import argparse
import json
import sys
from pathlib import Path

import librosa
import numpy as np
import torch


def main() -> int:
    parser = argparse.ArgumentParser(description="RMVPE pitch statistics.")
    parser.add_argument("--applio-root", required=True, type=Path)
    parser.add_argument("--npy-dir", type=Path, help="Applio f0_voiced folder (Hz per frame)")
    parser.add_argument("vocal", type=Path, nargs="?")
    args = parser.parse_args()

    if args.npy_dir is not None:
        frames = [np.load(p) for p in sorted(args.npy_dir.glob("*.npy"))]
        report(np.concatenate(frames) if frames else np.zeros(1))
        return 0
    if args.vocal is None:
        parser.error("give a vocal file or --npy-dir")

    sys.path.insert(0, str(args.applio_root))
    from rvc.lib.predictors.RMVPE import RMVPE0Predictor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = RMVPE0Predictor(
        str(args.applio_root / "rvc/models/predictors/rmvpe.pt"), device=device
    )
    audio, _ = librosa.load(str(args.vocal), sr=16000, mono=True)
    report(np.asarray(model.infer_from_audio(audio, thred=0.03)))
    return 0


def report(f0: np.ndarray) -> None:
    voiced = f0[f0 > 0]
    if voiced.size == 0:
        print(json.dumps({"median_hz": None, "p05_hz": None, "p95_hz": None,
                          "voiced_ratio": 0.0}))  # fmt: skip
        return
    print(
        json.dumps(
            {
                "median_hz": round(float(np.median(voiced)), 2),
                "p05_hz": round(float(np.percentile(voiced, 5)), 2),
                "p95_hz": round(float(np.percentile(voiced, 95)), 2),
                "voiced_ratio": round(voiced.size / f0.size, 3),
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    sys.exit(main())
