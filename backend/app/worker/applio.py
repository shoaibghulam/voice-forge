"""Typed argument builders for Applio's scripts (pinned commit 5379cf2).

The worker calls Applio's scripts directly rather than through `core.py <command>`:
core.py runs them through quiet runners that hide their output, and older versions
reported success after a failed step (docs/05 A1). These builders reproduce the exact
positional lists core.py's run_*_script functions build; tests/test_applio_commands.py
pins them, so an Applio upgrade that reorders arguments fails a test instead of
silently training with the wrong setting.

The training scripts locate the run directory through the APPLIO_LOGS_DIR environment
variable plus the model name - see `run_env`.
"""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ApplioPaths:
    python: Path  # engine venv interpreter
    root: Path  # Applio checkout


@dataclass(frozen=True)
class PreprocessConfig:
    dataset: Path
    sample_rate: int = 40000
    cpu_cores: int = 4
    cut_preprocess: str = "Automatic"
    process_effects: bool = False
    chunk_len: float = 3.0
    overlap_len: float = 0.3
    normalization_mode: str = "none"


@dataclass(frozen=True)
class ExtractConfig:
    sample_rate: int = 40000
    cpu_cores: int = 4
    f0_method: str = "rmvpe"
    gpu: int = 0
    embedder_model: str = "contentvec"
    include_mutes: int = 2


@dataclass(frozen=True)
class TrainConfig:
    model_name: str
    sample_rate: int
    total_epoch: int
    save_every_epoch: int
    batch_size: int
    pretrained_g: Path | None = None  # None -> Applio's HiFi-GAN base for the sample rate
    pretrained_d: Path | None = None
    gpu: int = 0
    save_only_latest: bool = False
    save_every_weights: bool = True  # an exported voice at every save survives a cancel
    cache_data_in_gpu: bool = False  # costs 2-4 GB; never on a 6 GB card
    cleanup: bool = False
    vocoder: str = "HiFi-GAN"
    checkpointing: bool = False  # gradient checkpointing; the OOM fallback


@dataclass(frozen=True)
class InferConfig:
    input_path: Path
    output_path: Path
    pth_path: Path
    index_path: Path
    pitch: int = 0
    index_rate: float = 0.4
    protect: float = 0.4
    volume_envelope: float = 0.35
    f0_method: str = "rmvpe"
    embedder_model: str = "contentvec"
    split_audio: bool = True
    f0_autotune: bool = False  # off: autotune flattens vibrato and glissando
    export_format: str = "WAV"


def _script(paths: ApplioPaths, relative: str) -> list[str]:
    return [str(paths.python), str(paths.root / relative)]


def run_env(logs_dir: Path) -> dict[str, str]:
    """Environment that points Applio's model storage at one of our run folders."""
    return {"APPLIO_LOGS_DIR": str(logs_dir)}


def preprocess_args(paths: ApplioPaths, run_dir: Path, config: PreprocessConfig) -> list[str]:
    values = [
        run_dir,
        config.dataset,
        config.sample_rate,
        config.cpu_cores,
        config.cut_preprocess,
        config.process_effects,
        config.chunk_len,
        config.overlap_len,
        config.normalization_mode,
    ]
    return [*_script(paths, "rvc/train/preprocess/preprocess.py"), *map(str, values)]


def extract_args(paths: ApplioPaths, run_dir: Path, config: ExtractConfig) -> list[str]:
    values = [
        run_dir,
        config.f0_method,
        config.cpu_cores,
        config.gpu,
        config.sample_rate,
        config.embedder_model,
        None,  # embedder_model_custom; core.py passes it through str() as "None"
        config.include_mutes,
    ]
    return [*_script(paths, "rvc/train/extract/extract.py"), *map(str, values)]


def default_pretrained(paths: ApplioPaths, sample_rate: int) -> tuple[Path, Path]:
    folder = paths.root / "rvc/models/pretraineds/hifi-gan"
    khz = sample_rate // 1000
    return folder / f"f0G{khz}k.pth", folder / f"f0D{khz}k.pth"


def train_args(paths: ApplioPaths, config: TrainConfig) -> list[str]:
    base_g, base_d = default_pretrained(paths, config.sample_rate)
    values = [
        config.model_name,
        config.save_every_epoch,
        config.total_epoch,
        config.pretrained_g or base_g,
        config.pretrained_d or base_d,
        config.gpu,
        config.batch_size,
        config.sample_rate,
        config.save_only_latest,
        config.save_every_weights,
        config.cache_data_in_gpu,
        config.cleanup,
        config.vocoder,
        config.checkpointing,
    ]
    return [*_script(paths, "rvc/train/train.py"), *map(str, values)]


def index_args(paths: ApplioPaths, run_dir: Path, algorithm: str = "Auto") -> list[str]:
    return [*_script(paths, "rvc/train/process/extract_index.py"), str(run_dir), algorithm]


def infer_args(paths: ApplioPaths, config: InferConfig) -> list[str]:
    args = [
        *_script(paths, "core.py"),
        "infer",
        "--input-path", str(config.input_path),
        "--output-path", str(config.output_path),
        "--pth-path", str(config.pth_path),
        "--index-path", str(config.index_path),
        "--pitch", str(config.pitch),
        "--index-rate", str(config.index_rate),
        "--protect", str(config.protect),
        "--volume-envelope", str(config.volume_envelope),
        "--f0-method", config.f0_method,
        "--embedder-model", config.embedder_model,
        "--export-format", config.export_format,
    ]  # fmt: skip
    # click boolean flags: present means on; passing a value after them is a parse error
    if config.split_audio:
        args.append("--split-audio")
    if config.f0_autotune:
        args.append("--f0-autotune")
    return args
