"""Slice clean vocal stems into clips and judge each clip. Runs INSIDE the engine venv.

    python qc.py --out-dir <clips dir> <song_id>=<dry vocal wav> [...]

Per song: if the stem is near-silent the song is reported as `no_voice` (docs/05 B14).
Otherwise it is split on silence, long phrases are cut to at most MAX_CLIP_S, clips
shorter than MIN_CLIP_S are dropped, and every clip is loudness-normalised and judged:

    silence       voiced frames (WebRTC VAD) below 50 %
    clipping      more than 0.1 % of samples within 0.5 dB of full scale
    other_singer  timbre far from the singer's centroid (MFCC statistics; a coarse
                  stand-in for a singer-embedding model - see docs/04 §4)
    duplicate     near-identical timbre and length to a clip of an EARLIER SONG

JSON lines on stdout: {"event":"song",...}, {"event":"clip",...}, {"event":"result",...}.
Thresholds are starting points for task 2.5 to tune on real recordings.
"""

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
import webrtcvad

SR = 44100
NO_VOICE_DBFS = -60.0
TOP_DB = 35
MERGE_GAP_S = 0.5
MIN_CLIP_S = 1.5
MAX_CLIP_S = 15.0
TARGET_RMS_DBFS = -20.0
PEAK_CEILING = 10 ** (-1 / 20)  # -1 dBFS
CLIP_LEVEL = 10 ** (-0.5 / 20)  # within 0.5 dB of full scale
MIN_VOICED = 0.5
MAX_CLIPPED = 0.001
DUPLICATE_SIMILARITY = 0.998


@dataclass
class ClipInfo:
    song_id: str
    path: str
    start_s: float
    duration_s: float
    voiced: float
    clipped: float
    embedding: np.ndarray
    verdict: str = "keep"
    reason: str | None = None


def emit(**payload: object) -> None:
    print(json.dumps(payload), flush=True)


def dbfs(y: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.square(y)))) if y.size else 0.0
    return 20 * np.log10(rms) if rms > 0 else -120.0


def phrases(y: np.ndarray) -> list[tuple[int, int]]:
    """Non-silent spans, merged across short gaps, cut to MAX_CLIP_S, short ones dropped."""
    spans = librosa.effects.split(y, top_db=TOP_DB, frame_length=2048, hop_length=512)
    merged: list[list[int]] = []
    for start, end in spans:
        if merged and start - merged[-1][1] < MERGE_GAP_S * SR:
            merged[-1][1] = int(end)
        else:
            merged.append([int(start), int(end)])
    limit = int(MAX_CLIP_S * SR)
    pieces = []
    for start, end in merged:
        count = max(1, int(np.ceil((end - start) / limit)))
        step = (end - start) // count
        pieces.extend((start + i * step, start + (i + 1) * step) for i in range(count))
    return [(s, e) for s, e in pieces if e - s >= MIN_CLIP_S * SR]


def voiced_ratio(clip: np.ndarray, vad: webrtcvad.Vad) -> float:
    pcm = librosa.resample(clip, orig_sr=SR, target_sr=16000)
    pcm16 = (np.clip(pcm, -1, 1) * 32767).astype(np.int16).tobytes()
    frame = 480 * 2  # 30 ms at 16 kHz, 16-bit
    frames = [pcm16[i : i + frame] for i in range(0, len(pcm16) - frame + 1, frame)]
    if not frames:
        return 0.0
    return sum(vad.is_speech(f, 16000) for f in frames) / len(frames)


def normalise(clip: np.ndarray) -> np.ndarray:
    gain = 10 ** ((TARGET_RMS_DBFS - dbfs(clip)) / 20)
    out = clip * gain
    peak = float(np.max(np.abs(out))) if out.size else 0.0
    return out * (PEAK_CEILING / peak) if peak > PEAK_CEILING else out


def embed(clip: np.ndarray) -> np.ndarray:
    mfcc = librosa.feature.mfcc(y=clip, sr=SR, n_mfcc=20)
    vector = np.concatenate([mfcc.mean(axis=1), mfcc.std(axis=1)])
    return vector / (np.linalg.norm(vector) or 1.0)


def process_song(song_id: str, path: Path, out_dir: Path, vad: webrtcvad.Vad) -> list[ClipInfo]:
    y, _ = librosa.load(str(path), sr=SR, mono=True)
    level = dbfs(y)
    spans = phrases(y) if level > NO_VOICE_DBFS else []
    emit(event="song", song_id=song_id, mean_dbfs=round(float(level), 1),
         no_voice=bool(level <= NO_VOICE_DBFS), clips=len(spans))  # fmt: skip
    clips = []
    for index, (start, end) in enumerate(spans):
        raw = y[start:end]
        clipped = float(np.mean(np.abs(raw) >= CLIP_LEVEL))
        target = out_dir / f"{song_id}_{index:04d}.wav"
        sf.write(str(target), normalise(raw), SR, subtype="PCM_16")
        clips.append(
            ClipInfo(song_id, str(target.resolve()), start / SR, (end - start) / SR,
                     voiced_ratio(raw, vad), clipped, embed(raw))
        )  # fmt: skip
    return clips


def judge(clips: list[ClipInfo]) -> None:
    for clip in clips:
        if clip.voiced < MIN_VOICED:
            clip.verdict, clip.reason = "reject", "silence"
        elif clip.clipped > MAX_CLIPPED:
            clip.verdict, clip.reason = "reject", "clipping"
    kept = [c for c in clips if c.verdict == "keep"]
    if len(kept) < 5:
        return
    matrix = np.stack([c.embedding for c in kept])
    centroid = np.median(matrix, axis=0)
    centroid /= np.linalg.norm(centroid) or 1.0
    sims = matrix @ centroid
    mad = float(np.median(np.abs(sims - np.median(sims)))) or 1e-3
    floor = float(np.median(sims)) - 4 * 1.4826 * mad
    for clip, sim in zip(kept, sims, strict=True):
        if sim < floor:
            clip.verdict, clip.reason = "reject", "other_singer"
    # Only across songs: the same recording uploaded twice (two cassettes of one release).
    # A chorus repeated inside one song is valid training data, not a duplicate.
    pairwise = matrix @ matrix.T
    for i in range(len(kept)):
        for j in range(i):
            if kept[i].song_id == kept[j].song_id:
                continue
            similar = pairwise[i, j] > DUPLICATE_SIMILARITY
            same_length = abs(kept[i].duration_s - kept[j].duration_s) < 0.2
            if similar and same_length and kept[j].verdict == "keep":
                kept[i].verdict, kept[i].reason = "reject", "duplicate"
                break


def main() -> int:
    parser = argparse.ArgumentParser(description="Slice and judge vocal clips.")
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("songs", nargs="+", help="song_id=path")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    vad = webrtcvad.Vad(2)

    clips: list[ClipInfo] = []
    for done, item in enumerate(args.songs, start=1):
        song_id, _, path = item.partition("=")
        clips.extend(process_song(song_id, Path(path), args.out_dir, vad))
        emit(event="progress", done=done, total=len(args.songs), item=song_id)

    judge(clips)
    for clip in clips:
        emit(event="clip", song_id=clip.song_id, path=clip.path, start_s=round(clip.start_s, 3),
             duration_s=round(clip.duration_s, 3), verdict=clip.verdict, reason=clip.reason,
             scores={"voiced": round(clip.voiced, 3), "clipped": round(clip.clipped, 5)})  # fmt: skip
    kept = sum(c.duration_s for c in clips if c.verdict == "keep")
    emit(event="result", clips=len(clips), kept_seconds=round(kept, 1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
