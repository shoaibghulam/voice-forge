"""Contract tests: argument lists for Applio's scripts at the pinned commit.

core.py builds these lists positionally (rvc/train/*.py read sys.argv by index), so a
reordered or missing argument does not fail loudly - it trains with the wrong setting.
The expected lists below mirror core.py's run_*_script functions at commit 5379cf2.
"""

from pathlib import Path

from app.worker.applio import (
    ApplioPaths,
    ExtractConfig,
    InferConfig,
    PreprocessConfig,
    TrainConfig,
    extract_args,
    index_args,
    infer_args,
    preprocess_args,
    train_args,
)

PATHS = ApplioPaths(python=Path("E:/py.exe"), root=Path("E:/applio"))
RUN = Path("D:/data/runs/r1")


def test_preprocess_args_follow_core_order() -> None:
    config = PreprocessConfig(dataset=Path("D:/clips"), sample_rate=40000, cpu_cores=4)

    assert preprocess_args(PATHS, RUN, config) == [
        str(PATHS.python),
        str(PATHS.root / "rvc/train/preprocess/preprocess.py"),
        str(RUN),
        str(Path("D:/clips")),
        "40000",
        "4",
        "Automatic",
        "False",
        "3.0",
        "0.3",
        "none",
    ]


def test_extract_args_follow_core_order() -> None:
    config = ExtractConfig(sample_rate=40000, cpu_cores=4)

    assert extract_args(PATHS, RUN, config) == [
        str(PATHS.python),
        str(PATHS.root / "rvc/train/extract/extract.py"),
        str(RUN),
        "rmvpe",
        "4",
        "0",
        "40000",
        "contentvec",
        "None",
        "2",
    ]


def test_train_args_follow_core_order() -> None:
    config = TrainConfig(
        model_name="arif",
        sample_rate=40000,
        total_epoch=100,
        save_every_epoch=5,
        batch_size=4,
        pretrained_g=Path("E:/g.pth"),
        pretrained_d=Path("E:/d.pth"),
    )

    assert train_args(PATHS, config) == [
        str(PATHS.python),
        str(PATHS.root / "rvc/train/train.py"),
        "arif",
        "5",
        "100",
        str(Path("E:/g.pth")),
        str(Path("E:/d.pth")),
        "0",
        "4",
        "40000",
        "False",
        "True",
        "False",
        "False",
        "HiFi-GAN",
        "False",
    ]


def test_train_defaults_are_the_6gb_safe_ones() -> None:
    config = TrainConfig(
        model_name="m", sample_rate=40000, total_epoch=10, save_every_epoch=5, batch_size=4
    )

    assert config.cache_data_in_gpu is False
    assert config.save_every_weights is True
    assert config.save_only_latest is False
    assert config.checkpointing is False


def test_default_pretrained_resolves_to_hifigan_for_sample_rate() -> None:
    config = TrainConfig(
        model_name="m", sample_rate=40000, total_epoch=10, save_every_epoch=5, batch_size=4
    )

    args = train_args(PATHS, config)

    assert args[5] == str(PATHS.root / "rvc/models/pretraineds/hifi-gan/f0G40k.pth")
    assert args[6] == str(PATHS.root / "rvc/models/pretraineds/hifi-gan/f0D40k.pth")


def test_index_args() -> None:
    assert index_args(PATHS, RUN) == [
        str(PATHS.python),
        str(PATHS.root / "rvc/train/process/extract_index.py"),
        str(RUN),
        "Auto",
    ]


def test_infer_args_use_flags_and_omit_disabled_switches() -> None:
    config = InferConfig(
        input_path=Path("D:/in.wav"),
        output_path=Path("D:/out.wav"),
        pth_path=Path("D:/m.pth"),
        index_path=Path("D:/m.index"),
        pitch=12,
    )

    args = infer_args(PATHS, config)

    assert args[:3] == [str(PATHS.python), str(PATHS.root / "core.py"), "infer"]
    assert args[args.index("--pitch") + 1] == "12"
    assert args[args.index("--index-rate") + 1] == "0.4"
    assert args[args.index("--protect") + 1] == "0.4"
    assert args[args.index("--volume-envelope") + 1] == "0.35"
    assert args[args.index("--f0-method") + 1] == "rmvpe"
    assert "--split-audio" in args
    assert "--f0-autotune" not in args
    assert "--proposed-pitch" not in args
