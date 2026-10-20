"""Analyse stages (separate -> lyrics -> style -> sections) against fake engine scripts:
no GPU, no models. The fakes print the same JSON lines the real scripts do."""

import json
import subprocess
from pathlib import Path
from textwrap import dedent

import pytest
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Analysis, JobEvent
from app.services.storage import analysis_dir
from app.worker.pipelines import stage_names
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages import analyze
from tests.test_stages import FFMPEG, make_ctx, make_wav, needs_ffmpeg, write_script

SEPARATOR = """
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
    out.mkdir(parents=True, exist_ok=True)
    demucs = ["Drums", "Bass", "Other", "Vocals"]
    labels = demucs if model.endswith(".yaml") else ["vocals", "other"]
    outputs = {}
    for label in labels:
        path = out / f"{base}~{label.lower()}.wav"
        silent = label == "vocals" and "instrumental" in str(src.parent)
        write(path, loud=not silent)
        outputs[label] = str(path)
    with open(Path(__file__).parent / "calls.txt", "a") as log:
        log.write(model + "\\n")
    print(json.dumps({"event": "progress", "done": 1, "total": 1, "item": src.name,
                      "outputs": outputs}), flush=True)
"""

TRANSCRIBE = """
    import json, sys
    args = sys.argv[1:]
    lang, device = args[args.index("--language") + 1], args[args.index("--device") + 1]
    if device == "cuda" and "{broken}" == "yes":
        print("RuntimeError: Library cublas64_12.dll is not found", file=sys.stderr)
        sys.exit(3)
    print(json.dumps({{"event": "result", "language": "fa" if lang == "auto" else lang,
        "language_probability": 0.9, "approximate": lang == "bal", "device": device,
        "fallback": None, "segments": [{{"start": 0.5, "end": 1.5, "text": "{text}"}}],
        "seconds": 1.0}}))
"""

STYLE_RESULT = {
    "event": "result", "tempo_bpm": 107.7, "tempo_confidence": 0.87, "key": "A#",
    "scale": "major", "key_confidence": 0.6, "loudness_dbfs": -16.6,
    "stems": {"vocals": 48.5, "drums": 5.1, "bass": 0.0, "other": 46.4},
    "instrument_tags": [{"label": "dhol", "score": 0.28}, {"label": "rubab", "score": 0.18}],
    "genre": [{"label": "Pakistani folk", "score": 0.27}],
    "mood": [{"label": "happy", "score": 0.33}], "device": "cuda", "seconds": 9.0,
}  # fmt: skip

SECTIONS_RESULT = {
    "event": "result", "duration": 2.0, "seconds": 0.5,
    "sections": [
        {"start": 0.0, "end": 0.8, "label": "intro", "has_vocals": False, "vocal_share": 0.0},
        {"start": 0.8, "end": 2.0, "label": "chorus", "has_vocals": True, "vocal_share": 0.9},
    ],
}  # fmt: skip


def printing(payload: dict[str, object]) -> str:
    return f"print({json.dumps(json.dumps(payload))})\n"


def make_analysis(
    engine: Engine, settings: Settings, stage: str, analysis_id: str = "an1", language: str = "auto"
) -> StageContext:
    folder = analysis_dir(settings, analysis_id)
    folder.mkdir(parents=True, exist_ok=True)
    song = make_wav(folder / "input.wav", 2)
    with Session(engine) as session:
        session.add(
            Analysis(
                id=analysis_id,
                original_filename="song.wav",
                input_path=str(song),
                language_hint=language,
            )
        )
        session.commit()
    params = {"analysis_id": analysis_id, "input_path": str(song), "language": language}
    return make_ctx(engine, stage, params)


def stems_ready(settings: Settings, analysis_id: str = "an1", vocal: bool = True) -> Path:
    """What the separate stage leaves behind, made with ffmpeg."""
    folder = analysis_dir(settings, analysis_id)
    (folder / "stems").mkdir(parents=True, exist_ok=True)
    make_wav(folder / "song.wav", 2)
    make_wav(folder / "accompaniment.wav", 2)
    for stem in ("drums", "bass", "other", "vocals"):
        make_wav(folder / "stems" / f"accompaniment~{stem}.wav", 2)
    if vocal:
        make_wav(folder / "vocals.wav", 2)
    else:
        assert FFMPEG is not None
        subprocess.run(  # noqa: S603 - fixed test command
            [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
             "-t", "2", str(folder / "vocals.wav")],
            check=True,
        )  # fmt: skip
    return folder


def stored(engine: Engine, analysis_id: str = "an1") -> dict[str, object]:
    with Session(engine) as session:
        row = session.get(Analysis, analysis_id)
        assert row is not None
        return dict(row.result_json)


def test_pipeline_stage_names_are_the_ui_contract() -> None:
    assert stage_names("analyze") == ["separate", "lyrics", "style", "sections"]


# --- separate --------------------------------------------------------------------------


@needs_ffmpeg
def test_separate_writes_vocals_accompaniment_and_instrument_stems(
    engine: Engine, fake_settings: Settings
) -> None:
    write_script(fake_settings, "separate.py", SEPARATOR)
    ctx = make_analysis(engine, fake_settings, "separate")

    outputs = analyze.separate(ctx)

    folder = analysis_dir(fake_settings, "an1")
    assert (folder / "song.wav").is_file()
    assert (folder / "vocals.wav").is_file() and (folder / "accompaniment.wav").is_file()
    for stem in ("drums", "bass", "other", "vocals"):
        assert (folder / "stems" / f"accompaniment~{stem}.wav").is_file()
    assert outputs["has_vocals"] is True
    assert stored(engine)["duration_s"] == pytest.approx(2.0, abs=0.1)
    calls = (fake_settings.engine_scripts_dir / "calls.txt").read_text().split()
    assert calls == [analyze.BLEEDLESS, analyze.HTDEMUCS]


@needs_ffmpeg
def test_separate_on_resume_reuses_finished_stems(engine: Engine, fake_settings: Settings) -> None:
    write_script(fake_settings, "separate.py", "raise SystemExit('must not run')")
    ctx = make_analysis(engine, fake_settings, "separate")
    stems_ready(fake_settings)

    outputs = analyze.separate(ctx)

    assert outputs["has_vocals"] is True


@needs_ffmpeg
def test_separation_out_of_memory_retries_with_a_smaller_segment(
    engine: Engine, fake_settings: Settings
) -> None:
    oom_first = (
        "import sys\n"
        "if sys.argv[sys.argv.index('--segment') + 1] == '256':\n"
        "    print('torch.OutOfMemoryError: CUDA out of memory', flush=True)\n"
        "    sys.exit(1)\n"
    )
    write_script(fake_settings, "separate.py", oom_first + dedent(SEPARATOR))
    ctx = make_analysis(engine, fake_settings, "separate")

    analyze.separate(ctx)

    with Session(engine) as session:
        retries = session.scalars(select(JobEvent).where(JobEvent.type == "stage.retry")).all()
    assert [r.payload_json["change"] for r in retries] == [{"segment": 128}, {"segment": 128}]


@needs_ffmpeg
def test_separate_refuses_missing_instrument_stems(engine: Engine, fake_settings: Settings) -> None:
    write_script(
        fake_settings,
        "separate.py",
        SEPARATOR.replace('["Drums", "Bass", "Other", "Vocals"]', '["Drums", "Other"]'),
    )
    ctx = make_analysis(engine, fake_settings, "separate")

    with pytest.raises(StageError) as error:
        analyze.separate(ctx)

    assert error.value.code == "stem_not_found"


# --- lyrics ----------------------------------------------------------------------------


@needs_ffmpeg
def test_lyrics_are_validated_and_stored(engine: Engine, fake_settings: Settings) -> None:
    write_script(fake_settings, "transcribe.py", TRANSCRIBE.format(broken="no", text="کاشی"))
    ctx = make_analysis(engine, fake_settings, "lyrics", language="bal")
    stems_ready(fake_settings)

    outputs = analyze.lyrics(ctx)

    lyrics = stored(engine)["lyrics"]
    assert isinstance(lyrics, dict)
    assert lyrics["language"] == "bal" and lyrics["approximate"] is True
    assert lyrics["segments"] == [{"start": 0.5, "end": 1.5, "text": "کاشی"}]
    assert outputs == {"language": "bal", "lines": 1, "device": "cuda"}


@needs_ffmpeg
def test_lyrics_fall_back_to_the_cpu_when_the_gpu_fails(
    engine: Engine, fake_settings: Settings
) -> None:
    write_script(fake_settings, "transcribe.py", TRANSCRIBE.format(broken="yes", text="hello"))
    ctx = make_analysis(engine, fake_settings, "lyrics", language="en")
    stems_ready(fake_settings)

    outputs = analyze.lyrics(ctx)

    lyrics = stored(engine)["lyrics"]
    assert isinstance(lyrics, dict)
    assert lyrics["device"] == "cpu"
    assert "cublas64_12.dll" in str(lyrics["fallback"])
    assert outputs["device"] == "cpu"
    with Session(engine) as session:
        retry = session.scalars(select(JobEvent).where(JobEvent.type == "stage.retry")).one()
    assert retry.payload_json["change"] == {"device": "cpu"}


@needs_ffmpeg
def test_an_instrumental_has_no_lyrics_rather_than_a_failure(
    engine: Engine, fake_settings: Settings
) -> None:
    write_script(fake_settings, "transcribe.py", "raise SystemExit('must not run')")
    ctx = make_analysis(engine, fake_settings, "lyrics", language="ur")
    stems_ready(fake_settings, vocal=False)

    outputs = analyze.lyrics(ctx)

    lyrics = stored(engine)["lyrics"]
    assert isinstance(lyrics, dict)
    assert lyrics["segments"] == [] and lyrics["note"] == "no_singing"
    assert outputs["lines"] == 0


@needs_ffmpeg
def test_engine_output_that_breaks_the_contract_fails_the_stage(
    engine: Engine, fake_settings: Settings
) -> None:
    bad = {"event": "result", "language": "de", "segments": [{"start": -4, "text": 3}]}
    write_script(fake_settings, "transcribe.py", printing(bad))
    ctx = make_analysis(engine, fake_settings, "lyrics")
    stems_ready(fake_settings)

    with pytest.raises(StageError) as error:
        analyze.lyrics(ctx)

    assert error.value.code == "bad_engine_output"
    assert "lyrics" not in stored(engine)


@needs_ffmpeg
def test_an_engine_error_event_is_reported(engine: Engine, fake_settings: Settings) -> None:
    write_script(
        fake_settings,
        "transcribe.py",
        printing({"event": "error", "code": "model_missing", "message": "no Whisper model"}),
    )
    ctx = make_analysis(engine, fake_settings, "lyrics")
    stems_ready(fake_settings)

    with pytest.raises(StageError) as error:
        analyze.lyrics(ctx)

    assert error.value.code == "transcribe_failed"
    assert "no Whisper model" in error.value.message
    assert "fetch_models" in error.value.hint


# --- style and sections ----------------------------------------------------------------


@needs_ffmpeg
def test_style_stores_tempo_key_instruments_and_loudness(
    engine: Engine, fake_settings: Settings
) -> None:
    write_script(fake_settings, "style.py", printing(STYLE_RESULT))
    ctx = make_analysis(engine, fake_settings, "style")
    stems_ready(fake_settings)

    outputs = analyze.style(ctx)

    style = stored(engine)["style"]
    assert isinstance(style, dict)
    assert style["tempo_bpm"] == 107.7 and style["key"] == "A#" and style["scale"] == "major"
    assert style["instruments"]["stems"]["vocals"] == 48.5
    assert style["instruments"]["tags"][0] == {"label": "dhol", "score": 0.28}
    assert style["genre"][0]["label"] == "Pakistani folk"
    assert isinstance(style["loudness_lufs"], float)
    assert outputs == {"tempo_bpm": 107.7, "key": "A# major"}


@needs_ffmpeg
def test_style_rejects_nonsense_values(engine: Engine, fake_settings: Settings) -> None:
    write_script(fake_settings, "style.py", printing({**STYLE_RESULT, "key": "H", "tempo_bpm": 0}))
    ctx = make_analysis(engine, fake_settings, "style")
    stems_ready(fake_settings)

    with pytest.raises(StageError) as error:
        analyze.style(ctx)

    assert error.value.code == "bad_engine_output"


@needs_ffmpeg
def test_sections_store_the_timeline(engine: Engine, fake_settings: Settings) -> None:
    write_script(fake_settings, "sections.py", printing(SECTIONS_RESULT))
    ctx = make_analysis(engine, fake_settings, "sections")
    stems_ready(fake_settings)

    outputs = analyze.sections(ctx)

    sections = stored(engine)["sections"]
    assert isinstance(sections, list)
    assert [s["label"] for s in sections] == ["intro", "chorus"]
    assert outputs == {"sections": 2, "sung": 1}


@needs_ffmpeg
def test_sections_refuse_an_end_before_the_start(engine: Engine, fake_settings: Settings) -> None:
    broken = {**SECTIONS_RESULT, "sections": [
        {"start": 3.0, "end": 1.0, "label": "verse", "has_vocals": True, "vocal_share": 0.5},
    ]}  # fmt: skip
    write_script(fake_settings, "sections.py", printing(broken))
    ctx = make_analysis(engine, fake_settings, "sections")
    stems_ready(fake_settings)

    with pytest.raises(StageError) as error:
        analyze.sections(ctx)

    assert error.value.code == "bad_engine_output"


def test_a_deleted_analysis_fails_the_stage_clearly(
    engine: Engine, fake_settings: Settings
) -> None:
    ctx = make_ctx(engine, "style", {"analysis_id": "gone", "input_path": "x", "language": "auto"})

    with pytest.raises(StageError) as error:
        analyze.store(ctx, "style", {})

    assert error.value.code == "analysis_missing"
