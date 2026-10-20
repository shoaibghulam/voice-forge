"""Stage functions against a fake engine (no GPU): the test interpreter plays the engine
venv, and tiny scripts in a temp folder play separate.py / qc.py, printing the same
JSON lines the real ones do."""

import json
import shutil
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path
from textwrap import dedent

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Checkpoint, Clip, JobEvent, Run, Singer, Song
from app.worker.events import EventWriter
from app.worker.job_queue import enqueue
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages import common, convert, prepare, train, train_loop

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg not on PATH")


def make_ctx(engine: Engine, stage: str, params: dict[str, object]) -> StageContext:
    job_id = enqueue(engine, "t", [stage])
    return StageContext(
        engine, job_id, stage, params, EventWriter(engine, job_id), threading.Event()
    )


def write_script(settings: Settings, name: str, body: str) -> None:
    (settings.engine_scripts_dir / name).write_text(dedent(body), encoding="utf-8")


def add_singer(engine: Engine) -> str:
    with Session(engine) as session:
        singer = Singer(name="Arif")
        session.add(singer)
        session.commit()
        return singer.id


def make_wav(path: Path, seconds: float, freq: int = 220) -> Path:
    assert FFMPEG is not None
    subprocess.run(  # noqa: S603 - fixed test command
        [
            FFMPEG,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency={freq}:duration={seconds}",
            str(path),
        ],
        check=True,
    )
    return path


# --- run_engine ----------------------------------------------------------------------


def test_run_engine_returns_lines_and_logs_them(engine: Engine, fake_settings: Settings) -> None:
    ctx = make_ctx(engine, "s", {})

    lines = common.run_engine(ctx, [sys.executable, "-c", "print('hello'); print('world')"])

    assert lines == ["hello", "world"]
    with Session(engine) as session:
        logged = session.scalars(select(JobEvent).where(JobEvent.type == "log.lines")).all()
    assert [line for e in logged for line in e.payload_json["lines"]] == ["hello", "world"]


def test_run_engine_maps_failures_to_codes(engine: Engine, fake_settings: Settings) -> None:
    ctx = make_ctx(engine, "s", {})

    with pytest.raises(StageError) as failed:
        common.run_engine(ctx, [sys.executable, "-c", "raise SystemExit(2)"], fail_code="boom")
    with pytest.raises(StageError) as oom:
        common.run_engine(
            ctx, [sys.executable, "-c", "print('CUDA out of memory'); raise SystemExit(1)"]
        )

    assert failed.value.code == "boom"
    assert oom.value.code == "cuda_oom"


def test_run_engine_halt_stops_without_error(engine: Engine, fake_settings: Settings) -> None:
    ctx = make_ctx(engine, "s", {})
    halt = threading.Event()
    script = "import time\nprint('started', flush=True)\ntime.sleep(30)"

    lines = common.run_engine(
        ctx, [sys.executable, "-c", script], on_line=lambda _: halt.set(), halt=halt
    )

    assert lines == ["started"]


def test_run_engine_user_cancel_raises(engine: Engine, fake_settings: Settings) -> None:
    ctx = make_ctx(engine, "s", {})
    script = "import time\nprint('started', flush=True)\ntime.sleep(30)"

    with pytest.raises(StageError) as cancelled:
        common.run_engine(ctx, [sys.executable, "-c", script], on_line=lambda _: ctx.cancel.set())

    assert cancelled.value.code == "cancelled"


# --- prepare -----------------------------------------------------------------------


@needs_ffmpeg
def test_validate_transcodes_and_marks_duplicates(
    engine: Engine, fake_settings: Settings, tmp_path: Path
) -> None:
    singer_id = add_singer(engine)
    original = make_wav(tmp_path / "a.wav", 2)
    with Session(engine) as session:
        session.add_all(
            [
                Song(singer_id=singer_id, original_filename="a.wav", stored_path=str(original)),
                Song(singer_id=singer_id, original_filename="copy.wav", stored_path=str(original)),
            ]
        )
        session.commit()

    outputs = prepare.validate(make_ctx(engine, "validate", {"singer_id": singer_id}))

    assert outputs == {"songs": 2, "ready": 1, "duplicates": 1}
    with Session(engine) as session:
        statuses = sorted(s.status for s in session.scalars(select(Song)))
    assert statuses == ["duplicate", "ready"]


def test_validate_without_songs_fails(engine: Engine, fake_settings: Settings) -> None:
    with pytest.raises(StageError) as error:
        prepare.validate(make_ctx(engine, "validate", {"singer_id": add_singer(engine)}))

    assert error.value.code == "no_songs"


FAKE_SEPARATOR = """
    import json, sys
    from pathlib import Path
    args = sys.argv[1:]
    out = Path(args[args.index("--out-dir") + 1])
    out.mkdir(parents=True, exist_ok=True)
    inputs = [a for a in args if a.endswith(".wav")]
    for n, src in enumerate(inputs, 1):
        base = Path(src).stem.split("~")[0]
        kept, other = out / f"{base}~vocals.wav", out / f"{base}~instrumental.wav"
        kept.write_bytes(Path(src).read_bytes()); other.write_bytes(b"x")
        print(json.dumps({"event": "progress", "done": n, "total": len(inputs), "item": src,
              "outputs": {"Vocals": str(kept), "Instrumental": str(other)}}), flush=True)
"""


def ready_song(engine: Engine, singer_id: str, settings: Settings) -> str:
    with Session(engine) as session:
        song = Song(singer_id=singer_id, original_filename="a.wav", stored_path="x", status="ready")
        session.add(song)
        session.commit()
        song_id = song.id
    canonical = prepare.canonical_path(singer_id, song_id)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_bytes(b"RIFFsong")
    return song_id


def test_chain_step_keeps_the_labelled_stem(engine: Engine, fake_settings: Settings) -> None:
    write_script(fake_settings, "separate.py", FAKE_SEPARATOR)
    singer_id = add_singer(engine)
    song_id = ready_song(engine, singer_id, fake_settings)
    ctx = make_ctx(engine, "separate", {"singer_id": singer_id})

    processed = prepare.chain_step(ctx, prepare.KARAOKE, "song", "vocals")
    again = prepare.chain_step(ctx, prepare.KARAOKE, "song", "vocals")

    assert processed == 1
    assert again == 0  # resume: done songs are skipped
    assert prepare.stem_path(singer_id, song_id, "vocals").read_bytes() == b"RIFFsong"


def test_chain_step_refuses_a_missing_stem_label(engine: Engine, fake_settings: Settings) -> None:
    write_script(fake_settings, "separate.py", FAKE_SEPARATOR)
    singer_id = add_singer(engine)
    ready_song(engine, singer_id, fake_settings)
    ctx = make_ctx(engine, "dereverb", {"singer_id": singer_id})

    with pytest.raises(StageError) as error:
        prepare.chain_step(ctx, prepare.DEREVERB, "song", "noreverb")

    assert error.value.code == "stem_not_found"


def test_qc_stage_stores_clips_and_flags_silent_songs(
    engine: Engine, fake_settings: Settings
) -> None:
    singer_id = add_singer(engine)
    song_id = ready_song(engine, singer_id, fake_settings)
    report = fake_settings.data_dir / "singers" / singer_id / "qc" / "report.jsonl"
    report.parent.mkdir(parents=True)
    events = [
        {"event": "song", "song_id": song_id, "no_voice": True},
        *[
            {
                "event": "clip",
                "song_id": song_id,
                "path": f"c{n}.wav",
                "start_s": n * 10,
                "duration_s": 10,
                "verdict": "keep",
                "reason": None,
                "scores": {},
            }
            for n in range(36)
        ],
        {
            "event": "clip",
            "song_id": song_id,
            "path": "r.wav",
            "start_s": 0,
            "duration_s": 3,
            "verdict": "reject",
            "reason": "clipping",
            "scores": {},
        },
    ]
    report.write_text("\n".join(json.dumps(e) for e in events))

    outputs = prepare.qc(make_ctx(engine, "qc", {"singer_id": singer_id}))

    assert outputs["usable_minutes"] == 6.0
    assert outputs["rejected"] == {"clipping": 1}
    assert outputs["gate"] == "warn_small"
    assert outputs["no_voice_songs"] == [song_id]
    with Session(engine) as session:
        assert len(session.scalars(select(Clip)).all()) == 37
        song = session.get(Song, song_id)
        assert song is not None and song.status == "no_voice"


def test_unknown_preset_is_rejected(engine: Engine, fake_settings: Settings) -> None:
    ctx = make_ctx(engine, "separate", {"singer_id": "x", "preset": "radio"})

    with pytest.raises(StageError) as error:
        prepare.separate(ctx)

    assert error.value.code == "bad_params"


# --- train -------------------------------------------------------------------------


def train_ctx(engine: Engine, singer_id: str, stage: str) -> tuple[StageContext, str]:
    with Session(engine) as session:
        run = Run(singer_id=singer_id, applio_commit="pending")
        session.add(run)
        session.commit()
        run_id = run.id
    return make_ctx(engine, stage, {"singer_id": singer_id, "run_id": run_id}), run_id


def test_preprocess_needs_a_prepared_dataset(engine: Engine, fake_settings: Settings) -> None:
    ctx, _ = train_ctx(engine, add_singer(engine), "preprocess")

    with pytest.raises(StageError) as error:
        train.preprocess(ctx)

    assert error.value.code == "dataset_not_prepared"


def test_preprocess_refuses_too_little_singing(
    engine: Engine, fake_settings: Settings, tmp_path: Path
) -> None:
    singer_id = add_singer(engine)
    song_id = ready_song(engine, singer_id, fake_settings)
    clip = tmp_path / "c.wav"
    clip.write_bytes(b"RIFF")
    with Session(engine) as session:
        session.add(
            Clip(
                singer_id=singer_id,
                song_id=song_id,
                path=str(clip),
                start_s=0,
                duration_s=60,
                verdict="keep",
            )
        )
        session.commit()
    ctx, _ = train_ctx(engine, singer_id, "preprocess")

    with pytest.raises(StageError) as error:
        train.preprocess(ctx)

    assert error.value.code == "dataset_too_small"


def test_export_writes_profile_and_activates_the_voice(
    engine: Engine, fake_settings: Settings
) -> None:
    singer_id = add_singer(engine)
    ctx, run_id = train_ctx(engine, singer_id, "export")
    with Session(engine) as session:
        session.add(Checkpoint(run_id=run_id, epoch=10, step=400, model_path="m.pth"))
        session.commit()

    outputs = train.export(ctx)

    assert outputs["checkpoints"] == 1
    assert (train.run_paths(ctx).root / "profile.json").is_file()
    with Session(engine) as session:
        singer = session.get(Singer, singer_id)
        assert singer is not None and singer.active_checkpoint_id is not None


def test_monitor_registers_checkpoints_and_prunes_states(
    engine: Engine, fake_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    singer_id = add_singer(engine)
    ctx, _ = train_ctx(engine, singer_id, "train")
    paths = train.run_paths(ctx)
    paths.model_dir.mkdir(parents=True)
    paths.samples.mkdir(parents=True)
    for step in (100, 200, 300):
        (paths.model_dir / f"G_{step}.pth").write_bytes(b"g")
        (paths.model_dir / f"D_{step}.pth").write_bytes(b"d")
    (paths.model_dir / "voice_5e_200s.pth").write_bytes(b"v")
    monkeypatch.setattr(train_loop, "SETTLE_S", 0.0)
    monitor = train_loop.Monitor(ctx, paths, total_epochs=10)
    monkeypatch.setattr(monitor, "pull_scalars", lambda: None)

    monitor.on_line("voice | epoch=5 | step=200 | batch=40/40")
    monitor.on_line("voice | epoch=5 | step=200 | time=01:00:00 | training_speed=0:00:30")

    with Session(engine) as session:
        ckpt = session.scalars(select(Checkpoint)).one()
        types = [e.type for e in session.scalars(select(JobEvent).order_by(JobEvent.seq))]
    assert (ckpt.epoch, ckpt.step) == (5, 200)
    assert {"train.step", "train.epoch", "eta", "checkpoint.saved"} <= set(types)
    assert len(list(paths.model_dir.glob("G_*.pth"))) == 2


def test_recording_scores_does_not_lock_the_database(
    engine: Engine, fake_settings: Settings, tmp_path: Path
) -> None:
    """Regression: scoring held an open write transaction while emitting events through a
    second connection; SQLite allows one writer, so it timed out with 'database is locked'
    (first real training run, 2026-10-19)."""
    singer_id = add_singer(engine)
    ctx, run_id = train_ctx(engine, singer_id, "samples")
    with Session(engine) as session:
        ckpts = [
            Checkpoint(run_id=run_id, epoch=e, step=e * 10, model_path=f"{e}.pth") for e in (60, 65)
        ]
        session.add_all(ckpts)
        session.commit()
        ids = [c.id for c in ckpts]
    outputs = {ids[0]: tmp_path / "p60.wav", ids[1]: tmp_path / "p65.wav"}
    scores = {str(outputs[ids[0]]): 0.8886, str(outputs[ids[1]]): 0.8852}

    result = train._record_scores(ctx, outputs, scores)

    assert result["recommended"] == ids[0]
    with Session(engine) as session:
        best = session.get(Checkpoint, ids[0])
        assert best is not None and best.recommended and best.similarity == 0.8886
        scored = session.scalars(select(JobEvent).where(JobEvent.type == "checkpoint.scored"))
        assert len(scored.all()) == 2


def test_eta_ignores_the_warm_up_epoch(engine: Engine, fake_settings: Settings) -> None:
    ctx, _ = train_ctx(engine, add_singer(engine), "train")
    paths = train.run_paths(ctx)
    paths.model_dir.mkdir(parents=True)
    monitor = train_loop.Monitor(ctx, paths, total_epochs=100)
    monitor.pull_scalars = lambda: None  # type: ignore[method-assign]

    monitor.on_line("v | epoch=1 | step=40 | time=01:00:00 | training_speed=0:04:10")
    after_first = monitor.ema.value
    monitor.on_line("v | epoch=2 | step=80 | time=01:00:30 | training_speed=0:00:27")

    assert after_first is None
    assert monitor.ema.value == 27


def test_monitor_halts_for_a_pause_at_a_checkpoint(
    engine: Engine, fake_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    ctx, _ = train_ctx(engine, add_singer(engine), "train")
    paths = train.run_paths(ctx)
    paths.model_dir.mkdir(parents=True)
    paths.samples.mkdir(parents=True)
    (paths.model_dir / "voice_5e_200s.pth").write_bytes(b"v")
    monkeypatch.setattr(train_loop, "SETTLE_S", 0.0)
    monitor = train_loop.Monitor(ctx, paths, total_epochs=10)
    monkeypatch.setattr(monitor, "pull_scalars", lambda: None)
    ctx.pause.set()

    monitor.on_line("voice | epoch=5 | step=200 | time=01:00:00 | training_speed=0:00:30")

    assert monitor.halt.is_set()
    assert monitor.halt_reason == "pause"


# --- convert -------------------------------------------------------------------------


@needs_ffmpeg
def test_mean_db_reads_ffmpeg_volume(tmp_path: Path) -> None:
    level = convert.mean_db(make_wav(tmp_path / "tone.wav", 1))

    assert -30 < level < -10  # ffmpeg sine is 1/8 amplitude: about -21 dB


@needs_ffmpeg
def test_backing_is_only_shifted_for_non_octave_changes(tmp_path: Path) -> None:
    make_wav(tmp_path / "song~backing.wav", 1)

    unshifted = convert._backing_input(tmp_path, 12)
    shifted = convert._backing_input(tmp_path, 2)

    assert unshifted[-1].endswith("song~backing.wav")
    assert shifted[-1].endswith("backing_shifted.wav")
    assert Path(shifted[-1]).is_file()


LEAD_SILENT_SEPARATOR = """
    import json, math, struct, sys, wave
    from pathlib import Path

    def write(path, loud):
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
            amp = 8000 if loud else 0
            w.writeframes(b"".join(struct.pack("<h", int(amp * math.sin(i / 8)))
                                   for i in range(16000)))

    args = sys.argv[1:]
    model, out = args[args.index("--model") + 1], Path(args[args.index("--out-dir") + 1])
    src = Path(args[-1])
    base = src.stem.split("~")[0]
    karaoke = "karaoke" in model
    labels = ("Vocals", "Instrumental") if karaoke else ("vocals", "other")
    lead, rest = out / f"{base}~{labels[0].lower()}.wav", out / f"{base}~{labels[1].lower()}.wav"
    write(lead, loud=not karaoke and "silent" not in src.name)  # karaoke misses the vocal
    write(rest, loud=True)
    print(json.dumps({"event": "progress", "done": 1, "total": 1, "item": src.name,
          "outputs": {labels[0]: str(lead), labels[1]: str(rest)}}), flush=True)
"""


def cover_ctx(engine: Engine, settings: Settings, song_name: str) -> StageContext:
    from app.services.storage import cover_dir

    folder = cover_dir(settings, "cov1")
    folder.mkdir(parents=True)
    song = folder / song_name
    song.write_bytes(b"x")
    return make_ctx(engine, "separate", {"cover_id": "cov1", "input_path": str(song)})


@needs_ffmpeg
def test_cover_falls_back_to_all_vocals_when_karaoke_finds_no_lead(
    engine: Engine, fake_settings: Settings
) -> None:
    write_script(fake_settings, "separate.py", LEAD_SILENT_SEPARATOR)
    ctx = cover_ctx(engine, fake_settings, "song.wav")

    outputs = convert.separate(ctx)

    assert outputs["model"] == prepare.BLEEDLESS
    assert not convert.is_silent(common.mean_db(Path(str(outputs["lead"]))))
    with Session(engine) as session:
        retry = session.scalars(select(JobEvent).where(JobEvent.type == "stage.retry")).one()
    assert retry.payload_json["reason"] == "no_lead_vocal"


@needs_ffmpeg
def test_cover_of_a_song_without_singing_fails_clearly(
    engine: Engine, fake_settings: Settings
) -> None:
    write_script(fake_settings, "separate.py", LEAD_SILENT_SEPARATOR)
    ctx = cover_ctx(engine, fake_settings, "silent.wav")

    with pytest.raises(StageError) as error:
        convert.separate(ctx)

    assert error.value.code == "no_singing"
    assert "instrumental" in error.value.hint


@needs_ffmpeg
def test_cover_mix_keeps_the_backing_in_stereo(engine: Engine, fake_settings: Settings) -> None:
    """Regression: the first real cover came out mono (amix follows the mono vocal)."""
    from app.services.storage import cover_dir

    folder = cover_dir(fake_settings, "covmix")
    folder.mkdir(parents=True)
    assert FFMPEG is not None
    for name, layout in (
        ("vocal.wav", "mono"),
        ("song~lead.wav", "stereo"),
        ("song~backing.wav", "stereo"),
    ):
        subprocess.run(  # noqa: S603 - fixed test command
            [
                FFMPEG,
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=330:duration=2",
                "-af",
                f"aformat=channel_layouts={layout}",
                str(folder / name),
            ],
            check=True,
        )
    ctx = make_ctx(
        engine,
        "mix",
        {"cover_id": "covmix", "settings": {}, "input_path": str(folder / "vocal.wav")},
    )

    convert.mix(ctx)

    probe = subprocess.run(  # noqa: S603 - fixed test command
        [
            shutil.which("ffprobe") or "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=channels",
            "-of",
            "csv=p=0",
            str(folder / "mix.wav"),
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert probe.stdout.strip() == "2"


@needs_ffmpeg
def test_cover_mix_keeps_the_voice_at_its_original_level(
    engine: Engine, fake_settings: Settings
) -> None:
    """Regression: ffmpeg's mono->stereo upmix (-3 dB) left the voice 3 dB too quiet."""
    from app.services.storage import cover_dir

    folder = cover_dir(fake_settings, "covlevel")
    folder.mkdir(parents=True)
    assert FFMPEG is not None
    tone = ["-f", "lavfi", "-i", "sine=frequency=330:duration=2"]
    for name, extra in (
        ("vocal.wav", []),
        ("song~lead.wav", []),
        ("song~backing.wav", ["-af", "volume=0.001,aformat=channel_layouts=stereo"]),
    ):
        subprocess.run(  # noqa: S603 - fixed test command
            [FFMPEG, "-v", "error", "-y", *tone, *extra, str(folder / name)],
            check=True,
        )
    ctx = make_ctx(
        engine,
        "mix",
        {
            "cover_id": "covlevel",
            "settings": {"reverb": "none"},
            "input_path": str(folder / "vocal.wav"),
        },
    )

    convert.mix(ctx)

    voice_alone = common.mean_db(folder / "vocal.wav")
    assert abs(common.mean_db(folder / "mix.wav") - voice_alone) < 1.0


@needs_ffmpeg
def test_cover_is_brought_up_to_the_release_loudness(
    engine: Engine, fake_settings: Settings
) -> None:
    from app.services.storage import cover_dir

    folder = cover_dir(fake_settings, "covloud")
    folder.mkdir(parents=True)
    assert FFMPEG is not None
    tone = ["-f", "lavfi", "-i", "sine=frequency=330:duration=2"]
    for name, extra in (
        ("vocal.wav", []),
        ("song~lead.wav", []),
        ("song~backing.wav", ["-af", "volume=0.001,aformat=channel_layouts=stereo"]),
        ("release.wav", ["-af", "volume=4dB"]),
    ):
        subprocess.run(  # noqa: S603 - fixed test command
            [FFMPEG, "-v", "error", "-y", *tone, *extra, str(folder / name)], check=True
        )
    ctx = make_ctx(
        engine,
        "mix",
        {
            "cover_id": "covloud",
            "settings": {"reverb": "none"},
            "input_path": str(folder / "release.wav"),
        },
    )

    outputs = convert.mix(ctx)

    assert 3.0 < float(str(outputs["loudness_gain_db"])) < 5.0
    assert abs(common.mean_db(folder / "mix.wav") - common.mean_db(folder / "release.wav")) < 1.0


def test_ctx_settings_default_when_missing(engine: Engine) -> None:
    ctx = make_ctx(engine, "mix", {"cover_id": "abc"})

    assert convert._opts(ctx) == {}


@pytest.fixture(autouse=True)
def _no_leak(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    yield
