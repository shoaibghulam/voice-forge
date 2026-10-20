"""Song timeline: where the singing is and how the song is built. Runs INSIDE the engine
venv, CPU only (librosa).

    python sections.py --mix song.wav --vocals vocals.wav

1. Vocal activity: 0.1 s frames of the vocal stem above -45 dBFS.
2. Structure: agglomerative segmentation of beat-synchronous chroma + MFCC of the full
   mix into ~one segment per 24 s (6-12 segments); segments under 4 s merge into the
   previous one.
3. Labels (heuristic, shown as approximate):
   - no singing in a segment -> `intro` (first), `outro` (last), else `instrumental`
   - sung segments whose harmony repeats elsewhere in the song (chroma correlation in
     the top quarter, at least 0.8) and that are at least as loud as the median sung
     segment -> `chorus`; other sung segments -> `verse`
   Neighbours with the same label are joined.

JSON lines: {"event": "result", "duration": 193.0, "sections": [{"start": 0.0,
             "end": 12.4, "label": "intro", "has_vocals": false, "vocal_share": 0.02}]}
"""

import argparse
import json
import sys
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

SR = 22050
HOP = 512
VOICED_DB = -45.0
VOCAL_FRAME_S = 0.1
SECONDS_PER_SEGMENT = 24
MIN_SEGMENTS, MAX_SEGMENTS = 6, 12
MIN_SECTION_S = 4.0
HAS_VOCALS_SHARE = 0.25
REPEAT_FLOOR = 0.8
REPEAT_PERCENTILE = 0.75


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    vocal_share: float
    energy: float
    chroma: tuple[float, ...]


def emit(**payload: object) -> None:
    print(json.dumps(payload), flush=True)


def segment_count(duration_s: float, beats: int) -> int:
    wanted = round(duration_s / SECONDS_PER_SEGMENT)
    return max(1, min(beats - 1, max(MIN_SEGMENTS, min(MAX_SEGMENTS, wanted))))


def correlation(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    cov = sum((x - ma) * (y - mb) for x, y in zip(a, b, strict=True))
    va = sum((x - ma) ** 2 for x in a) ** 0.5
    vb = sum((y - mb) ** 2 for y in b) ** 0.5
    return cov / (va * vb) if va and vb else 0.0


def merge_short(segments: list[Segment]) -> list[Segment]:
    out: list[Segment] = []
    for seg in segments:
        if out and seg.end - seg.start < MIN_SECTION_S:
            out[-1] = replace(out[-1], end=seg.end)
        else:
            out.append(seg)
    if len(out) > 1 and out[0].end - out[0].start < MIN_SECTION_S:
        out = [replace(out[1], start=out[0].start), *out[2:]]
    return out


def _quantile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))]


def chorus_set(sung: list[int], segments: list[Segment]) -> set[int]:
    if len(sung) < 3:
        return set()
    pairs = {(i, j): correlation(segments[i].chroma, segments[j].chroma)
             for i in sung for j in sung if i < j}  # fmt: skip
    threshold = max(REPEAT_FLOOR, _quantile(list(pairs.values()), REPEAT_PERCENTILE))
    repeated = {k for pair, r in pairs.items() if r >= threshold for k in pair}
    loud = _quantile([segments[i].energy for i in sung], 0.5)
    return {i for i in repeated if segments[i].energy >= loud}


def label_sections(segments: list[Segment]) -> list[dict[str, Any]]:
    sung = [i for i, s in enumerate(segments) if s.vocal_share >= HAS_VOCALS_SHARE]
    chorus = chorus_set(sung, segments)
    last = len(segments) - 1
    labelled: list[dict[str, Any]] = []
    for i, seg in enumerate(segments):
        if i in sung:
            label = "chorus" if i in chorus else "verse"
        else:
            label = "intro" if i == 0 else "outro" if i == last else "instrumental"
        if labelled and labelled[-1]["label"] == label:
            prev = labelled[-1]
            span = prev["end"] - prev["start"], seg.end - seg.start
            share = (prev["vocal_share"] * span[0] + seg.vocal_share * span[1]) / sum(span)
            labelled[-1] = {**prev, "end": round(seg.end, 2), "vocal_share": round(share, 2)}
            continue
        labelled.append({
            "start": round(seg.start, 2), "end": round(seg.end, 2), "label": label,
            "has_vocals": i in sung, "vocal_share": round(seg.vocal_share, 2),
        })  # fmt: skip
    return labelled


def vocal_flags(vocals: Any) -> list[bool]:
    import librosa
    import numpy as np

    hop = int(SR * VOCAL_FRAME_S)
    rms = librosa.feature.rms(y=vocals, frame_length=2 * hop, hop_length=hop)[0]
    return [bool(v) for v in 20 * np.log10(np.maximum(rms, 1e-9)) > VOICED_DB]


def structure(mix: Any) -> tuple[list[float], Any, Any]:
    """Segment boundaries (s), beat-synchronous chroma and the beat times."""
    import librosa
    import numpy as np

    _, beats = librosa.beat.beat_track(y=mix, sr=SR, hop_length=HOP)
    chroma = librosa.feature.chroma_cqt(y=mix, sr=SR, hop_length=HOP)
    mfcc = librosa.feature.mfcc(y=mix, sr=SR, hop_length=HOP, n_mfcc=13)
    sync_chroma = librosa.util.sync(chroma, beats, aggregate=np.median)
    sync_mfcc = librosa.util.sync(mfcc, beats, aggregate=np.mean)
    feats = np.vstack([librosa.util.normalize(sync_chroma, axis=1),
                       librosa.util.normalize(sync_mfcc, axis=1)])  # fmt: skip
    duration = len(mix) / SR
    edges = [0, *beats.tolist(), librosa.time_to_frames(duration, sr=SR, hop_length=HOP)]
    edge_times = librosa.frames_to_time(np.array(edges), sr=SR, hop_length=HOP)
    k = segment_count(duration, feats.shape[1])
    bounds = librosa.segment.agglomerative(feats, k) if feats.shape[1] > k else np.arange(k)
    times = sorted({0.0, *(float(edge_times[b]) for b in bounds), duration})
    return times, sync_chroma, edge_times


def build_segments(mix: Any, vocals: Any) -> tuple[list[Segment], float]:
    import numpy as np

    flags = vocal_flags(vocals)
    times, chroma, edge_times = structure(mix)
    segments = []
    for start, end in zip(times, times[1:], strict=False):
        if end - start <= 0:
            continue
        lo, hi = int(start / VOCAL_FRAME_S), max(int(start / VOCAL_FRAME_S) + 1, int(end / VOCAL_FRAME_S))
        window = flags[lo:hi]
        cols = [i for i in range(chroma.shape[1]) if start <= edge_times[i] < end] or [0]
        piece = mix[int(start * SR) : int(end * SR)]
        segments.append(Segment(
            start=start, end=end,
            vocal_share=sum(window) / len(window) if window else 0.0,
            energy=float(np.mean(np.square(piece))) if len(piece) else 0.0,
            chroma=tuple(float(v) for v in chroma[:, cols].mean(axis=1)),
        ))  # fmt: skip
    return merge_short(segments), len(mix) / SR


def main() -> int:
    parser = argparse.ArgumentParser(description="Song timeline: sections and singing.")
    parser.add_argument("--mix", required=True, type=Path)
    parser.add_argument("--vocals", required=True, type=Path)
    args = parser.parse_args()
    missing = [str(p) for p in (args.mix, args.vocals) if not p.is_file()]
    if missing:
        emit(event="error", code="missing_input", message=f"not found: {missing}")
        return 2
    try:
        import librosa

        started = time.perf_counter()
        mix, _ = librosa.load(str(args.mix), sr=SR, mono=True)
        vocals, _ = librosa.load(str(args.vocals), sr=SR, mono=True)
        segments, duration = build_segments(mix, vocals)
        emit(
            event="result",
            duration=round(duration, 2),
            sections=label_sections(segments),
            seconds=round(time.perf_counter() - started, 1),
        )
        return 0
    except Exception as exc:
        message = f"{type(exc).__name__}: {exc}".splitlines()[0][:400]
        emit(event="error", code="sections_failed", message=message)
        print(message, file=sys.stderr, flush=True)
        return 4


if __name__ == "__main__":
    sys.exit(main())
