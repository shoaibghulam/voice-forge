"""Transcribe a vocal stem with faster-whisper. Runs INSIDE the engine venv.

    python transcribe.py --model-dir data/models_cache/whisper --language auto \
        [--device cuda|cpu] vocals.wav

Whisper has no Balochi, and its language-ID head calls sung Balochi "English" (0.6-0.86
on the first real song, even on vocal-only audio). So language choice is restricted to
the app's languages and decided by decoding, not by the ID head:

- `auto`: decode up to 60 s of the loudest singing in ur, fa and en; keep the language the
  decoder is most sure of (highest mean token log-probability). On the first real song
  Urdu scored -0.28, Persian -0.32, English -0.5 to -1.9.
- `ur` / `fa` / `en`: use that language
- `bal`: transcribe as Urdu (Perso-Arabic script) and mark the result approximate

Where to listen: Whisper's own VAD is a speech detector and skipped a whole sung verse on
the first real song (filed 2-60 s as "music"). The vocal stem is clean (non-singing parts
sit near -110 dBFS), so the sung regions come from its level instead: 0.1 s frames above
-40 dBFS, gaps under 1.5 s bridged, passed to Whisper as `clip_timestamps`. A region that
still comes back with no lyric is retried once in the other Arabic-script language.

Clean-up: Whisper's "music" markers (موسیقی) and stock hallucinations ("Thank you.") are
dropped, and so is any very long, near-empty segment; a word repeated more than twice in
a row (decoder loop on a held note) is cut to two; each segment's edges are trimmed to
where the vocal is audible so clicking a line seeks to the singing.

GPU is float16; when CUDA cannot start (missing cuBLAS/cuDNN DLLs, out of memory) the
model falls back to CPU int8 and the result says so (`device`, `fallback`).

JSON lines on stdout (ASCII-escaped: the pipe is cp1252 on Windows):
    {"event": "progress", "done": 63.2, "total": 193.0}        seconds of audio
    {"event": "result", "language": "ur", "language_probability": 0.71,
     "whisper_language": "en", "approximate": false, "device": "cuda", "fallback": null,
     "scores": {"ur": -0.28, ...}, "segments": [{"start": 12.3, "end": 15.9, "text": ".."}],
     "seconds": 41.0}
    {"event": "error", "code": "...", "message": "..."}
"""

import argparse
import json
import math
import os
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any

CHOICES = ("ur", "fa", "en")
ARABIC_SCRIPT = {"ur", "fa", "bal"}
# Unify Arabic letter variants with the forms Urdu and Persian both write.
ARABIC_FIXES = str.maketrans({"ي": "ی", "ى": "ی", "ك": "ک"})
INVISIBLE = re.compile("[​‎‏‪-‮﻿]")
PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
# What Whisper writes over instrumental passages, and its stock hallucinations.
NOT_LYRICS = {
    "موسیقی", "موسيقى", "music", "musik", "thank you", "thanks for watching",
    "thank you for watching", "subscribe", "please subscribe", "you",
}  # fmt: skip
SAMPLE_RATE = 16000
HOP = 1600  # 0.1 s frames for vocal activity
VOICED_DB = -40.0
DETECT_SECONDS = 60
SCORE_SHARPNESS = 10.0  # softmax over mean token log-prob: a 0.3 gap -> ~95 %
LONG_SEGMENT_S = 15.0
BRIDGE_FRAMES = 15  # 1.5 s
MIN_REGION_FRAMES = 10  # 1 s
RETRY_LANGUAGE = {"fa": "ur", "ur": "fa"}
REPEATS = re.compile(r"(?<!\S)(\S+)(?:\s+\1(?!\S)){2,}")
MIN_CHARS_PER_S = 0.4


def emit(**payload: object) -> None:
    print(json.dumps(payload), flush=True)


def add_cuda_dll_dirs() -> None:
    """CTranslate2 loads cuBLAS/cuDNN by name; on Windows they live in the nvidia-* wheels
    and in torch/lib, neither of which is on the DLL search path by default."""
    if os.name != "nt":
        return
    site = Path(sys.prefix) / "Lib" / "site-packages"
    for folder in [site / "torch" / "lib", *sorted((site / "nvidia").glob("*/bin"))]:
        if folder.is_dir():
            os.add_dll_directory(str(folder))
            os.environ["PATH"] = f"{folder}{os.pathsep}{os.environ.get('PATH', '')}"


def share(scores: dict[str, float]) -> dict[str, float]:
    """Softmax of decoder scores: how much more sure the decoder is of one language."""
    top = max(scores.values())
    weights = {k: math.exp(SCORE_SHARPNESS * (v - top)) for k, v in scores.items()}
    total = sum(weights.values())
    return {k: w / total for k, w in weights.items()}


def normalise(text: str, language: str) -> str:
    text = INVISIBLE.sub("", unicodedata.normalize("NFC", text))
    if language in ARABIC_SCRIPT:
        text = text.translate(ARABIC_FIXES)
    text = " ".join(text.split())
    return REPEATS.sub(lambda m: f"{m.group(1)} {m.group(1)}", text)


def is_lyric(text: str, start: float, end: float) -> bool:
    bare = " ".join(PUNCT.sub(" ", text).lower().split())
    if not bare or bare in NOT_LYRICS or not any(ch.isalpha() for ch in bare):
        return False
    duration = end - start
    return not (duration > LONG_SEGMENT_S and len(bare) / duration < MIN_CHARS_PER_S)


def clean_segments(
    raw: list[tuple[float, float, str]], language: str, voiced: list[bool] | None = None
) -> list[dict[str, Any]]:
    """Normalised lyric lines; edges trimmed to audible singing when `voiced` (one flag per
    0.1 s) is given; Whisper's triple-repeat loops on held notes collapsed."""
    out: list[dict[str, Any]] = []
    for start, end, text in raw:
        line = normalise(text, language)
        if not is_lyric(line, start, end):
            continue
        if len(out) >= 2 and out[-1]["text"] == line and out[-2]["text"] == line:
            continue
        if voiced:
            start, end = trim(start, end, voiced)
        out.append({"start": round(start, 2), "end": round(end, 2), "text": line})
    return out


def trim(start: float, end: float, voiced: list[bool]) -> tuple[float, float]:
    first, last = int(start * 10), min(len(voiced), int(math.ceil(end * 10)))
    hits = [i for i in range(first, last) if voiced[i]]
    if not hits:
        return start, end
    return max(start, hits[0] / 10), min(end, (hits[-1] + 1) / 10)


def vocal_regions(voiced: list[bool]) -> list[tuple[float, float]]:
    """Sung stretches (s): voiced frames, gaps under BRIDGE_FRAMES joined, short ones dropped."""
    regions: list[tuple[float, float]] = []
    start: int | None = None
    last = gap = 0
    for i, flag in enumerate([*voiced, *([False] * (BRIDGE_FRAMES + 1))]):
        if flag:
            start = i if start is None else start
            last, gap = i, 0
            continue
        gap += 1
        if start is not None and gap > BRIDGE_FRAMES:
            if last + 1 - start >= MIN_REGION_FRAMES:
                regions.append((start / 10, (last + 1) / 10))
            start = None
    return regions


def silent_regions(
    regions: list[tuple[float, float]], lines: list[dict[str, Any]]
) -> list[tuple[float, float]]:
    """Regions with no lyric line in them."""
    return [r for r in regions if not any(r[0] <= ln["start"] < r[1] for ln in lines)]


def load_model(model_dir: Path, device: str) -> tuple[Any, str, str | None]:
    from faster_whisper import WhisperModel

    if device == "cuda":
        try:
            return WhisperModel(str(model_dir), device="cuda", compute_type="float16"), "cuda", None
        except Exception as exc:  # no CUDA libs, OOM, driver mismatch: CPU still works
            fallback = f"{type(exc).__name__}: {exc}"[:300]
            return WhisperModel(str(model_dir), device="cpu", compute_type="int8"), "cpu", fallback
    return WhisperModel(str(model_dir), device="cpu", compute_type="int8"), "cpu", None


def voiced_frames(audio: Any) -> list[bool]:
    import librosa
    import numpy as np

    rms = librosa.feature.rms(y=audio, frame_length=2 * HOP, hop_length=HOP)[0]
    return [bool(v) for v in 20 * np.log10(np.maximum(rms, 1e-9)) > VOICED_DB]


def singing_clip(audio: Any, voiced: list[bool]) -> Any:
    """Up to DETECT_SECONDS of the frames where the vocal is audible, back to back."""
    import numpy as np

    frames = [audio[i * HOP : (i + 1) * HOP] for i, v in enumerate(voiced) if v]
    clip = np.concatenate(frames) if len(frames) >= 50 else audio
    return clip[: DETECT_SECONDS * SAMPLE_RATE]


def decoder_score(model: Any, clip: Any, language: str) -> float:
    segments, _ = model.transcribe(
        clip, language=language, beam_size=1, vad_filter=False,
        condition_on_previous_text=False, without_timestamps=True,
    )  # fmt: skip
    pairs = [(max(0.1, s.end - s.start), s.avg_logprob) for s in segments]
    total = sum(d for d, _ in pairs)
    return sum(d * lp for d, lp in pairs) / total if total else -10.0


def pick_language(model: Any, clip: Any, hint: str) -> tuple[str, float, dict[str, float]]:
    """(whisper language to decode with, its share of decoder confidence, raw scores)."""
    if hint in CHOICES:
        return hint, 1.0, {}
    if hint == "bal":
        return "ur", 1.0, {}
    scores = {lang: round(decoder_score(model, clip, lang), 3) for lang in CHOICES}
    shares = share(scores)
    best = max(scores, key=lambda lang: scores[lang])
    return best, shares[best], scores


def decode(
    model: Any, audio: Any, language: str, regions: list[tuple[float, float]]
) -> list[tuple[float, float, str]]:
    if not regions:
        return []
    clips = [t for region in regions for t in region]
    segments, info = model.transcribe(
        audio, language=language, beam_size=5, vad_filter=False, clip_timestamps=clips,
        word_timestamps=False,
        condition_on_previous_text=False,  # songs repeat lines; conditioning loops them
    )  # fmt: skip
    raw: list[tuple[float, float, str]] = []
    for segment in segments:
        raw.append((segment.start, segment.end, segment.text))
        emit(event="progress", done=round(segment.end, 1), total=round(info.duration, 1))
    return raw


def transcribe(args: argparse.Namespace) -> int:
    if not args.input.is_file():
        emit(event="error", code="missing_input", message=f"not found: {args.input}")
        return 2
    if not (args.model_dir / "model.bin").is_file():
        emit(event="error", code="model_missing", message=f"no Whisper model in {args.model_dir}")
        return 2
    add_cuda_dll_dirs()
    import librosa  # faster-whisper's own decoder breaks on PyAV 19 (metadata_errors)

    started = time.perf_counter()
    model, device, fallback = load_model(args.model_dir, args.device)
    audio, _ = librosa.load(str(args.input), sr=SAMPLE_RATE, mono=True)
    voiced = voiced_frames(audio)
    clip = singing_clip(audio, voiced)
    _, _, id_probs = model.detect_language(clip)
    language, probability, scores = pick_language(model, clip, args.language)
    regions = vocal_regions(voiced)
    shown = "bal" if args.language == "bal" else language
    lines = clean_segments(decode(model, audio, language, regions), shown, voiced)
    retry = RETRY_LANGUAGE.get(language)
    missed = silent_regions(regions, lines) if retry else []
    if retry and missed:
        extra = clean_segments(decode(model, audio, retry, missed), shown, voiced)
        lines = sorted([*lines, *extra], key=lambda ln: float(ln["start"]))
    emit(
        event="result",
        language=shown,
        language_probability=round(probability, 3),
        whisper_language=id_probs[0][0] if id_probs else None,
        approximate=args.language == "bal",
        device=device,
        fallback=fallback,
        scores=scores,
        segments=lines,
        regions=[[round(a, 1), round(b, 1)] for a, b in regions],
        seconds=round(time.perf_counter() - started, 1),
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe a vocal stem (faster-whisper).")
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--language", default="auto", choices=("auto", "bal", *CHOICES))
    parser.add_argument("--device", default="cuda", choices=("cuda", "cpu"))
    parser.add_argument("input", type=Path)
    args = parser.parse_args()
    try:
        return transcribe(args)
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}".splitlines()[0][:400]
        code = "cuda_oom" if "out of memory" in message.lower() else "transcribe_failed"
        emit(event="error", code=code, message=message)
        print(message, file=sys.stderr, flush=True)
        return 4


if __name__ == "__main__":
    sys.exit(main())
