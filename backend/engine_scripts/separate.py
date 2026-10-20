"""Run one separation model over many files. Runs INSIDE the engine venv.

    engine/.venv/Scripts/python.exe backend/engine_scripts/separate.py \
        --model mel_band_roformer_kim_ft2_bleedless_unwa.ckpt \
        --model-dir data/models_cache/separator --out-dir <dir> \
        --segment 256 --overlap 2 a.wav b.wav

One model is loaded once and applied to every input: model load is the fixed cost,
and only one model is ever resident in the 6 GB of VRAM.

Output is JSON lines on stdout, one object per line, read by the worker:

    {"event": "progress", "done": 1, "total": 3, "item": "a.wav", "seconds": 41.2,
     "outputs": {"Vocals": "<abs path>", "Instrumental": "<abs path>"}}
    {"event": "result", "seconds": 120.5, "peak_vram_mb": 3410, "files": 3}
    {"event": "error", "code": "cuda_oom", "message": "..."}

Outputs are named `<song>~<stem>.wav` (e.g. `song01~dry.wav`). Left to itself the
separator appends `_(Stem)_<model name>` at every step, and four steps down a chain the
path passes Windows' 260-character limit and the write fails. The `<song>` part is the
text before the first `~`, so names stay the same length however long the chain is.
Each output is checked to exist and be non-empty; nothing is found by scanning a folder.
"""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import torch
from audio_separator.separator import Separator

# Between song name and stem label. Not "__": the separator sanitises custom names and
# collapses runs of underscores, so "song01__dry" would be written as "song01_dry".
STEM_DELIMITER = "~"


def emit(**payload: object) -> None:
    print(json.dumps(payload), flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run one separation model over many files.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--segment", type=int, default=256)
    parser.add_argument("--overlap", type=int, default=2)
    parser.add_argument("--batch", type=int, default=1)
    parser.add_argument("--fp32", action="store_true", help="disable native fp16")
    parser.add_argument("inputs", nargs="+", type=Path)
    return parser.parse_args()


def song_base(source: Path) -> str:
    """'song01~vocals' -> 'song01': the song's own name without earlier stem suffixes."""
    return source.stem.split(STEM_DELIMITER, 1)[0]


def stem_slug(label: str) -> str:
    """'No dry' -> 'no-dry'; safe in a filename and stable across models."""
    return "-".join(label.lower().split())


def stem_labels(separator: Separator) -> list[str]:
    model = separator.model_instance
    # Demucs writes four stems (Drums, Bass, Other, Vocals), not a primary/secondary pair.
    multi = getattr(model, "demucs_source_map", None)
    if multi:
        return [str(label) for label in multi]
    labels = [model.primary_stem_name, model.secondary_stem_name]
    return [label for label in labels if label]


def build_separator(args: argparse.Namespace) -> Separator:
    return Separator(
        log_level=logging.WARNING,
        model_file_dir=str(args.model_dir),
        output_dir=str(args.out_dir),
        output_format="WAV",
        use_native_fp16=not args.fp32,
        mdxc_params={
            "segment_size": args.segment,
            "override_model_segment_size": False,
            "batch_size": args.batch,
            "overlap": args.overlap,
            "pitch_shift": 0,
        },
        # Demucs (instrument stems for Analyse): one shift halves the time of the default
        # two; stem energies and tags do not need the last 0.1 dB of separation quality.
        demucs_params={
            "segment_size": "Default",
            "shifts": 1,
            "overlap": 0.25,
            "segments_enabled": True,
        },
    )


def separate_one(
    separator: Separator, source: Path, labels: list[str], out_dir: Path
) -> dict[str, str] | None:
    """Separate one file; map stem label -> absolute path, or None if an output is bad."""
    names = {label: f"{song_base(source)}{STEM_DELIMITER}{stem_slug(label)}" for label in labels}
    separator.separate(str(source), custom_output_names=names)
    outputs = {}
    for label, name in names.items():
        path = out_dir / f"{name}.wav"
        if not path.is_file() or path.stat().st_size == 0:
            emit(event="error", code="empty_output", message=f"{source.name}: {path.name}")
            return None
        outputs[label] = str(path.resolve())
    return outputs


def separate_all(args: argparse.Namespace) -> int:
    missing = [str(p) for p in args.inputs if not p.is_file()]
    if missing:
        emit(event="error", code="missing_input", message=f"not found: {missing}")
        return 2

    args.out_dir.mkdir(parents=True, exist_ok=True)
    separator = build_separator(args)
    separator.load_model(model_filename=args.model)
    labels = stem_labels(separator)

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()

    for done, source in enumerate(args.inputs, start=1):
        item_started = time.perf_counter()
        outputs = separate_one(separator, source, labels, args.out_dir)
        if outputs is None:
            return 3
        emit(
            event="progress",
            done=done,
            total=len(args.inputs),
            item=source.name,
            seconds=round(time.perf_counter() - item_started, 2),
            outputs=outputs,
        )

    peak = torch.cuda.max_memory_allocated() // 2**20 if torch.cuda.is_available() else 0
    emit(
        event="result",
        seconds=round(time.perf_counter() - started, 2),
        peak_vram_mb=int(peak),
        files=len(args.inputs),
    )
    return 0


def main() -> int:
    args = parse_args()
    try:
        return separate_all(args)
    except torch.cuda.OutOfMemoryError as error:
        emit(event="error", code="cuda_oom", message=str(error).splitlines()[0])
        return 4


if __name__ == "__main__":
    sys.exit(main())
