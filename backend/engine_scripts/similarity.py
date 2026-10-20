"""Timbre similarity of candidate audio to reference clips. Runs INSIDE the engine venv.

    python similarity.py --ref a.wav b.wav --cand x.wav y.wav

Prints one JSON line per candidate: {"path", "similarity"} - the mean cosine between
MFCC statistics of the candidate and each reference. This is a coarse stand-in for a
singer-embedding model (docs/04 §7, §10): good enough to rank checkpoints of one run
against each other, never an absolute quality score. Listening decides.
"""

import argparse
import json
import sys

import librosa
import numpy as np

SR = 22050


def embed(path: str) -> np.ndarray:
    y, _ = librosa.load(path, sr=SR, mono=True)
    mfcc = librosa.feature.mfcc(y=y, sr=SR, n_mfcc=20)
    vector = np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1)])
    return vector / (np.linalg.norm(vector) or 1.0)


def main() -> int:
    parser = argparse.ArgumentParser(description="MFCC timbre similarity.")
    parser.add_argument("--ref", nargs="+", required=True)
    parser.add_argument("--cand", nargs="+", required=True)
    args = parser.parse_args()
    refs = np.stack([embed(p) for p in args.ref])
    for path in args.cand:
        score = float(np.mean(refs @ embed(path)))
        print(json.dumps({"path": path, "similarity": round(score, 4)}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
