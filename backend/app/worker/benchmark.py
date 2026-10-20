"""Benchmark the pipeline on this machine's GPU (task 0.1 in docs/08).

    cd backend
    .venv/Scripts/python.exe -m app.worker.benchmark --songs ../data/inbox/<singer>

No published VRAM or timing numbers exist for a 6 GB laptop GPU, so the defaults in
docs/04 marked [est.] are replaced by what this measures:

1. separation: the two heaviest chain models at candidate segment/overlap settings
2. the full clean-up chain at the default setting -> dry vocals
3. Applio preprocess + extract + a short training run at batch 4 (then 2 on OOM)
4. index + one conversion with the result

Peak VRAM is read through NVML for the whole GPU minus what was in use before the step
started, so it covers engine subprocesses and their CUDA context. Results go to
data/benchmarks/<timestamp>/results.jsonl and report.md.
"""

import argparse
import json
import shutil
import subprocess
import sys
import time
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.config import Settings, get_settings
from app.worker import applio
from app.worker.gpu import GpuSampler, PeakTracker, nvml_reader
from app.worker.parsers.applio_stdout import EpochDone, parse_line
from app.worker.runner import run_streaming

AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac", ".wma"}
NEAR_LIMIT_FRACTION = 0.92
TRAIN_EPOCHS = 3

# (step, model filename, labels of the stem to KEEP, in preference order)
CHAIN: list[tuple[str, str, tuple[str, ...]]] = [
    ("lead vocal", "bs_roformer_karaoke_frazer_becruily.ckpt", ("vocals", "karaoke", "lead")),
    ("bleed", "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt", ("vocals",)),
    ("de-echo", "dereverb-echo_mel_band_roformer_sdr_13.4843_v2.ckpt", ("noreverb", "dry")),
    ("denoise", "denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt", ("dry", "noise free")),
]
DEFAULT_SETTING = (256, 2)
GRID = [(256, 2), (256, 4), (128, 2)]


class StemNotFoundError(LookupError):
    pass


@dataclass(frozen=True)
class BenchResult:
    stage: str
    label: str
    seconds: float
    audio_seconds: float
    peak_vram_mb: int
    note: str = ""

    @property
    def rtf(self) -> float | None:
        """Real-time factor: processing seconds per second of audio."""
        return round(self.seconds / self.audio_seconds, 3) if self.audio_seconds else None


def pick_stem(outputs: dict[str, str], wanted: Sequence[str]) -> str:
    """The path of the first wanted stem label present; never a guess."""
    by_label = {label.lower(): path for label, path in outputs.items()}
    for label in wanted:
        if label.lower() in by_label:
            return by_label[label.lower()]
    raise StemNotFoundError(f"none of {list(wanted)} in stems: {', '.join(outputs)}")


def format_report(results: Sequence[BenchResult], vram_total_mb: int) -> str:
    rows = [
        "| Stage | Setting | Seconds | Audio s | RTF | Peak VRAM MB | Note |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in results:
        note = r.note
        if r.peak_vram_mb >= vram_total_mb * NEAR_LIMIT_FRACTION:
            note = f"{note} (near limit)".strip()
        rtf = "" if r.rtf is None else f"{r.rtf}"
        rows.append(
            f"| {r.stage} | {r.label} | {r.seconds:.1f} | {r.audio_seconds:.0f} | {rtf}"
            f" | {r.peak_vram_mb} | {note} |"
        )
    return "\n".join(rows)


class Bench:
    def __init__(self, settings: Settings, out_dir: Path) -> None:
        self.settings = settings
        self.out_dir = out_dir
        self.results: list[BenchResult] = []
        self.read_gpu = nvml_reader()
        self.paths = applio.ApplioPaths(python=settings.engine_python, root=settings.applio_root)

    def record(self, result: BenchResult) -> None:
        self.results.append(result)
        with (self.out_dir / "results.jsonl").open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({**asdict(result), "rtf": result.rtf}) + "\n")
        print(
            f"  {result.stage:<10} {result.label:<40} {result.seconds:8.1f}s"
            f"  vram {result.peak_vram_mb} MB  {result.note}",
            flush=True,
        )

    def run(
        self, args: list[str], env: dict[str, str] | None = None
    ) -> tuple[list[str], float, int, int | None]:
        """Run an engine command; returns (lines, seconds, peak VRAM delta MB, returncode)."""
        tracker = PeakTracker(baseline_mb=self.read_gpu().mem_used_mb)
        lines: list[str] = []
        started = time.perf_counter()
        with GpuSampler(self.read_gpu, tracker, interval_s=0.5):
            result = run_streaming(args, lines.append, env=env, cwd=self.settings.applio_root)
        return lines, time.perf_counter() - started, tracker.peak_delta_mb, result.returncode


def tool(name: str) -> str:
    """Absolute path of an executable on PATH; fail clearly if it is missing."""
    found = shutil.which(name)
    if found is None:
        raise FileNotFoundError(f"{name} not found on PATH (install ffmpeg)")
    return found


def audio_seconds(path: Path) -> float:
    probe = subprocess.run(  # noqa: S603 - fixed argument list
        [tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
         str(path)],
        capture_output=True, text=True, check=True, timeout=60,
    )  # fmt: skip
    return float(probe.stdout.strip())


def prepare_songs(source: Path, dest: Path, max_songs: int) -> list[Path]:
    """Transcode up to `max_songs` inputs to the canonical 44.1 kHz stereo WAV."""
    dest.mkdir(parents=True, exist_ok=True)
    found = sorted(p for p in source.iterdir() if p.suffix.lower() in AUDIO_SUFFIXES)
    songs = []
    for index, song in enumerate(found[:max_songs], start=1):
        target = dest / f"song{index:02d}.wav"
        subprocess.run(  # noqa: S603 - fixed argument list
            [tool("ffmpeg"), "-v", "error", "-y", "-i", str(song), "-ar", "44100", "-ac", "2",
             "-c:a", "pcm_s16le", str(target)],
            check=True, timeout=600,
        )  # fmt: skip
        songs.append(target)
    return songs


def separate(
    bench: Bench, model: str, inputs: list[Path], out: Path, setting: tuple[int, int]
) -> tuple[list[dict[str, str]], float, int]:
    segment, overlap = setting
    script = bench.settings.engine_scripts_dir / "separate.py"
    args = [str(bench.settings.engine_python), str(script), "--model", model,
            "--model-dir", str(bench.settings.separator_models_dir), "--out-dir", str(out),
            "--segment", str(segment), "--overlap", str(overlap), *map(str, inputs)]  # fmt: skip
    lines, seconds, peak, code = bench.run(args)
    events = [json.loads(line) for line in lines if line.startswith('{"event"')]
    errors = [e for e in events if e["event"] == "error"]
    if code != 0 or errors:
        detail = errors[0] if errors else lines[-5:]
        raise RuntimeError(f"{model} failed ({code}): {detail}")
    outputs = [e["outputs"] for e in events if e["event"] == "progress"]
    return outputs, seconds, peak


def bench_separation_grid(bench: Bench, songs: list[Path], total_audio: float) -> None:
    print("\n[1/4] separation settings grid", flush=True)
    for step, model, _ in CHAIN[:2]:
        for setting in GRID:
            out = bench.out_dir / "grid" / f"{step}-{setting[0]}-{setting[1]}"
            try:
                _, seconds, peak = separate(bench, model, songs, out, setting)
                note = ""
            except RuntimeError as error:
                seconds, peak, note = 0.0, 0, f"FAILED: {str(error)[:80]}"
            label = f"{model.split('.')[0][:28]} seg{setting[0]} ov{setting[1]}"
            bench.record(BenchResult("separate", label, seconds, total_audio, peak, note))


def run_chain(bench: Bench, songs: list[Path], total_audio: float) -> list[Path]:
    print("\n[2/4] full clean-up chain at default setting", flush=True)
    current = songs
    for step, model, keep in CHAIN:
        outputs, seconds, peak = separate(
            bench, model, current, bench.out_dir / "chain" / step, DEFAULT_SETTING
        )
        current = [Path(pick_stem(stems, keep)) for stems in outputs]
        bench.record(BenchResult("chain", step, seconds, total_audio, peak))
    return current


def bench_training(bench: Bench, dry: list[Path], dry_audio: float) -> Path | None:
    print("\n[3/4] preprocess, extract, train", flush=True)
    dataset = bench.out_dir / "dataset"
    dataset.mkdir(exist_ok=True)
    for path in dry:
        shutil.copy2(path, dataset / path.name)
    logs = bench.out_dir / "runs"
    run_dir = logs / "bench"
    env = applio.run_env(logs)
    steps = [
        ("preprocess", applio.preprocess_args(
            bench.paths, run_dir, applio.PreprocessConfig(dataset=dataset))),
        ("extract", applio.extract_args(bench.paths, run_dir, applio.ExtractConfig())),
    ]  # fmt: skip
    for name, args in steps:
        lines, seconds, peak, code = bench.run(args, env)
        note = "" if code == 0 else f"FAILED {code}: {lines[-1:]}"
        sliced = len(list((run_dir / "sliced_audios").glob("*.wav")))
        if name == "preprocess" and code == 0:
            # Applio prints "preprocessed successfully" even when it wrote nothing (docs/05 A1)
            note = f"{sliced} clips" if sliced else "FAILED: 0 clips written (silent input?)"
        bench.record(BenchResult(name, "default", seconds, dry_audio, peak, note))
        if code != 0 or sliced == 0:
            return None
    for batch in (4, 2):
        if train_once(bench, env, batch, dry_audio):
            return run_dir
    return None


def train_once(bench: Bench, env: dict[str, str], batch: int, dry_audio: float) -> bool:
    config = applio.TrainConfig(
        model_name="bench",
        sample_rate=40000,
        total_epoch=TRAIN_EPOCHS,
        save_every_epoch=TRAIN_EPOCHS,
        batch_size=batch,
    )
    lines, seconds, peak, code = bench.run(applio.train_args(bench.paths, config), env)
    epochs = [r for r in map(parse_line, lines) if isinstance(r, EpochDone)]
    oom = any("out of memory" in line.lower() for line in lines)
    # the first epoch includes model load and warm-up; leave it out of the mean
    epoch_s = [e.epoch_seconds for e in epochs[1:]] or [e.epoch_seconds for e in epochs]
    mean = sum(epoch_s) / len(epoch_s) if epoch_s else 0.0
    note = "OOM" if oom else f"{len(epochs)} epochs, total {seconds:.0f}s"
    if code != 0 and not oom:
        note = f"FAILED {code}: {lines[-3:]}"
    bench.record(BenchResult("train", f"batch {batch} (s/epoch)", mean, dry_audio, peak, note))
    return code == 0 and bool(epochs)


def bench_inference(bench: Bench, run_dir: Path, vocal: Path) -> None:
    print("\n[4/4] index + conversion", flush=True)
    _, seconds, peak, code = bench.run(applio.index_args(bench.paths, run_dir))
    bench.record(BenchResult("index", "Auto", seconds, 0, peak, "" if code == 0 else "FAILED"))
    models = sorted(run_dir.glob("bench_*e_*s.pth"))
    indexes = sorted(run_dir.glob("*.index"))
    if not models or not indexes:
        bench.record(BenchResult("infer", "-", 0, 0, 0, "no exported model or index"))
        return
    config = applio.InferConfig(
        input_path=vocal,
        output_path=bench.out_dir / "converted.wav",
        pth_path=models[-1],
        index_path=indexes[0],
    )
    lines, seconds, peak, code = bench.run(applio.infer_args(bench.paths, config))
    note = "" if code == 0 and config.output_path.is_file() else f"FAILED: {lines[-3:]}"
    bench.record(BenchResult("infer", "rmvpe split", seconds, audio_seconds(vocal), peak, note))


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Benchmark the pipeline on this GPU.")
    parser.add_argument("--songs", type=Path, required=True)
    parser.add_argument("--max-songs", type=int, default=3)
    parser.add_argument("--skip-grid", action="store_true")
    parser.add_argument(
        "--vocals",
        action="store_true",
        help="inputs are already clean vocals: skip separation, benchmark training only",
    )
    args = parser.parse_args(argv)

    settings = get_settings()
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    bench = Bench(settings, settings.data_dir / "benchmarks" / stamp)
    bench.out_dir.mkdir(parents=True)
    songs = prepare_songs(args.songs, bench.out_dir / "songs", args.max_songs)
    if not songs:
        print(f"no audio files in {args.songs}", file=sys.stderr)
        return 2
    total = sum(map(audio_seconds, songs))
    print(f"{len(songs)} songs, {total / 60:.1f} min -> {bench.out_dir}", flush=True)

    if args.vocals:
        dry = songs
    else:
        if not args.skip_grid:
            bench_separation_grid(bench, songs, total)
        dry = run_chain(bench, songs, total)
    dry_audio = sum(map(audio_seconds, dry))
    run_dir = bench_training(bench, dry, dry_audio)
    if run_dir is not None:
        bench_inference(bench, run_dir, dry[0])

    report = format_report(bench.results, bench.read_gpu().mem_total_mb)
    (bench.out_dir / "report.md").write_text(report + "\n", encoding="utf-8")
    print("\n" + report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
