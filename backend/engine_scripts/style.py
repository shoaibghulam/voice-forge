"""Describe a song's musical style. Runs INSIDE the engine venv.

    python style.py --mix song.wav --accompaniment accompaniment.wav --vocals vocals.wav \
        --drums d.wav --bass b.wav --other o.wav [--residue r.wav] --clap-dir <dir> \
        [--device cuda|cpu]

- tempo: librosa beat tracking on the full mix; confidence = share of frames whose local
  tempo agrees with it (or with its double / half)
- key + scale: Krumhansl-Schmuckler profiles against the mean chroma (CQT) of the
  accompaniment; key_confidence is the winning correlation. No Eastern scale (maqam /
  raag) name: chroma has no reliable way to tell them apart, so none is guessed.
- loudness: mean level in dBFS (same measure as ffmpeg volumedetect); the worker adds
  integrated LUFS with ffmpeg's ebur128
- instruments: each stem's share of the total energy (Demucs drums / bass / other, the
  vocal stem; Demucs' vocal residue counts as "other"), plus zero-shot CLAP tags on the
  accompaniment
- genre and mood: zero-shot CLAP on the full mix (approximate: CLAP has heard little
  Balochi music)

CLAP scores: the song is cut into up to 12 ten-second windows (CLAP hears 10 s at a
time); each window gets a softmax over the labels; the score is the mean over windows.

JSON lines: {"event": "result", "tempo_bpm": .., ..., "device": "cuda", "seconds": 9.1}
            {"event": "error", "code": "...", "message": "..."}
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

SR = 22050
CLAP_SR = 48000
WINDOW_S = 10
MAX_WINDOWS = 12
SILENT_WINDOW_DB = -50.0
TOP = 3
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
TEMPO_TOLERANCE = 0.05

# label shown -> what CLAP is asked
INSTRUMENTS = {
    "drums": "drums", "tabla": "tabla", "dhol": "dhol drum", "bass": "bass guitar",
    "guitar": "guitar", "rubab": "rubab", "sitar": "sitar", "benju (banjo)": "banjo",
    "harmonium": "harmonium", "violin": "violin", "sorud": "sorud bowed lute",
    "flute": "flute", "piano": "piano", "synthesizer": "synthesizer", "strings": "string section",
}  # fmt: skip
GENRES = [
    "Balochi folk", "Pakistani folk", "qawwali", "ghazal", "sufi", "pop", "rock", "hip hop",
    "electronic", "classical", "film music", "wedding song",
]
MOODS = ["happy", "sad", "romantic", "energetic", "calm", "melancholic", "festive", "devotional"]


def emit(**payload: object) -> None:
    print(json.dumps(payload), flush=True)


def correlate(a: list[float], b: list[float]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True))
    va = math.sqrt(sum((x - ma) ** 2 for x in a))
    vb = math.sqrt(sum((y - mb) ** 2 for y in b))
    return cov / (va * vb) if va and vb else 0.0


def detect_key(chroma_mean: list[float]) -> tuple[str, str, float]:
    """(tonic, "major"|"minor", correlation) - Krumhansl-Schmuckler."""
    best = ("C", "major", -2.0)
    for shift in range(12):
        rotated = chroma_mean[shift:] + chroma_mean[:shift]  # tonic candidate at index 0
        for scale, profile in (("major", MAJOR), ("minor", MINOR)):
            r = correlate(rotated, profile)
            if r > best[2]:
                best = (NOTES[shift], scale, r)
    return best


def tempo_agreement(global_bpm: float, local: list[float]) -> float:
    if not local or global_bpm <= 0:
        return 0.0
    targets = (global_bpm, global_bpm * 2, global_bpm / 2)
    hits = sum(any(abs(t - g) <= g * TEMPO_TOLERANCE for g in targets) for t in local)
    return hits / len(local)


def stem_shares(energies: dict[str, float]) -> dict[str, float]:
    total = sum(energies.values())
    if total <= 0:
        return {k: 0.0 for k in energies}
    return {k: round(100 * v / total, 1) for k, v in energies.items()}


def top_labels(labels: list[str], scores: list[float]) -> list[dict[str, Any]]:
    ranked = sorted(zip(labels, scores, strict=True), key=lambda p: p[1], reverse=True)
    return [{"label": label, "score": round(score, 3)} for label, score in ranked[:TOP]]


def load(path: Path, sr: int = SR) -> Any:
    import librosa

    audio, _ = librosa.load(str(path), sr=sr, mono=True)
    return audio


def mean_dbfs(audio: Any) -> float:
    import numpy as np

    power = float(np.mean(np.square(audio))) if len(audio) else 0.0
    return round(10 * math.log10(power), 1) if power > 0 else -91.0


def rhythm_and_key(mix: Any, accompaniment: Any) -> dict[str, Any]:
    import librosa
    import numpy as np

    onset = librosa.onset.onset_strength(y=mix, sr=SR)
    bpm, _ = librosa.beat.beat_track(onset_envelope=onset, sr=SR)
    bpm = float(np.atleast_1d(bpm)[0])
    local = librosa.feature.tempo(onset_envelope=onset, sr=SR, aggregate=None)
    chroma = librosa.feature.chroma_cqt(y=accompaniment, sr=SR)
    tonic, scale, r = detect_key([float(v) for v in chroma.mean(axis=1)])
    return {
        "tempo_bpm": round(bpm, 1),
        "tempo_confidence": round(tempo_agreement(bpm, [float(t) for t in local]), 2),
        "key": tonic,
        "scale": scale,
        "key_confidence": round(max(0.0, r), 2),
    }


def windows(audio: Any) -> list[Any]:
    """Up to MAX_WINDOWS evenly spaced, non-silent 10 s windows (48 kHz)."""
    size = WINDOW_S * CLAP_SR
    if len(audio) <= size:
        return [audio]
    count = min(MAX_WINDOWS, len(audio) // size)
    step = (len(audio) - size) / max(1, count - 1)
    picked = [audio[int(i * step) : int(i * step) + size] for i in range(count)]
    loud = [w for w in picked if mean_dbfs(w) > SILENT_WINDOW_DB]
    return loud or picked


class Clap:
    def __init__(self, folder: Path, device: str) -> None:
        import torch
        from transformers import ClapModel, ClapProcessor

        self.torch = torch
        self.device = device if device == "cpu" or torch.cuda.is_available() else "cpu"
        self.model = ClapModel.from_pretrained(str(folder)).to(self.device).eval()
        self.processor = ClapProcessor.from_pretrained(str(folder))

    @staticmethod
    def _tensor(output: Any) -> Any:
        return getattr(output, "pooler_output", output)  # transformers 5 may wrap it

    def audio_embeds(self, audio: Any) -> Any:
        inputs = self.processor(audio=windows(audio), sampling_rate=CLAP_SR, return_tensors="pt")
        with self.torch.no_grad():
            feats = self._tensor(self.model.get_audio_features(**inputs.to(self.device)))
        return self.torch.nn.functional.normalize(feats, dim=-1)

    def scores(self, audio_embeds: Any, prompts: list[str]) -> list[float]:
        inputs = self.processor(text=prompts, padding=True, return_tensors="pt")
        with self.torch.no_grad():
            text = self._tensor(self.model.get_text_features(**inputs.to(self.device)))
            text = self.torch.nn.functional.normalize(text, dim=-1)
            logits = self.model.logit_scale_a.exp() * audio_embeds @ text.T
            probs = logits.softmax(dim=-1).mean(dim=0)
        return [float(p) for p in probs.cpu()]


def tags(args: argparse.Namespace, mix: Any, accompaniment: Any) -> dict[str, Any]:
    import librosa

    clap = Clap(args.clap_dir, args.device)
    backing = clap.audio_embeds(librosa.resample(accompaniment, orig_sr=SR, target_sr=CLAP_SR))
    full = clap.audio_embeds(librosa.resample(mix, orig_sr=SR, target_sr=CLAP_SR))
    names = list(INSTRUMENTS)
    instrument = clap.scores(backing, [f"the sound of {INSTRUMENTS[n]}" for n in names])
    genre = clap.scores(full, [f"{g} music" for g in GENRES])
    mood = clap.scores(full, [f"{m} music" for m in MOODS])
    return {
        "instrument_tags": top_labels(names, instrument),
        "genre": top_labels(GENRES, genre),
        "mood": top_labels(MOODS, mood),
        "device": clap.device,
    }


def describe(args: argparse.Namespace) -> int:
    paths = [args.mix, args.accompaniment, args.vocals, args.drums, args.bass, args.other]
    missing = [str(p) for p in paths if not p.is_file()]
    if missing:
        emit(event="error", code="missing_input", message=f"not found: {missing}")
        return 2
    if not (args.clap_dir / "config.json").is_file():
        emit(event="error", code="model_missing", message=f"no CLAP model in {args.clap_dir}")
        return 2
    import numpy as np

    started = time.perf_counter()
    mix, accompaniment = load(args.mix), load(args.accompaniment)
    energy = {
        name: float(np.sum(np.square(load(path))))
        for name, path in (("vocals", args.vocals), ("drums", args.drums), ("bass", args.bass),
                           ("other", args.other))
    }  # fmt: skip
    if args.residue is not None and args.residue.is_file():
        energy["other"] += float(np.sum(np.square(load(args.residue))))
    found = tags(args, mix, accompaniment)
    emit(
        event="result",
        **rhythm_and_key(mix, accompaniment),
        loudness_dbfs=mean_dbfs(mix),
        stems=stem_shares(energy),
        **found,
        seconds=round(time.perf_counter() - started, 1),
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Describe a song's musical style.")
    for name in ("mix", "accompaniment", "vocals", "drums", "bass", "other", "clap-dir"):
        parser.add_argument(f"--{name}", required=True, type=Path)
    parser.add_argument("--residue", type=Path)
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    args = parser.parse_args()
    try:
        return describe(args)
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}".splitlines()[0][:400]
        code = "cuda_oom" if "out of memory" in message.lower() else "style_failed"
        emit(event="error", code=code, message=message)
        print(message, file=sys.stderr, flush=True)
        return 4


if __name__ == "__main__":
    sys.exit(main())
