"""analyze: separate -> lyrics -> style -> sections (docs/04 §12).

Job params: analysis_id, input_path, language (auto | bal | ur | fa | en).

Folder data/analyses/<id>/: input.<ext>, song.wav (44.1 kHz stereo), vocals.wav and
accompaniment.wav (bleedless RoFormer), stems/accompaniment~{drums,bass,other,vocals}.wav
(Demucs on the accompaniment; its "vocals" is residue). Each stage writes its own part of
the result into the analyses row as soon as it is done, so the page fills in live; stage
outputs stay small. Engine output is validated (schemas/analysis.py) before it is stored.

GPU stages (separate, lyrics, style) each run in their own process, one at a time, so
Whisper's and CLAP's VRAM is freed in between. When CUDA fails in the lyrics or style
step it is retried on the CPU, and the result says so.
"""

import re
import shutil
from pathlib import Path
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.models import Analysis
from app.schemas.analysis import EngineSections, EngineStyle, Instruments, Lyrics, Style
from app.services.media import MediaError, probe
from app.services.storage import analysis_dir
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages.common import (
    engine_script,
    json_events,
    mean_db,
    progress,
    require,
    run_engine,
    run_ffmpeg,
    separate_stems,
    settings,
)
from app.worker.stages.logic import is_silent
from app.worker.stages.prepare import BLEEDLESS

HTDEMUCS = "htdemucs_ft.yaml"
ANALYSIS_MODELS = [BLEEDLESS, HTDEMUCS]
INSTRUMENT_STEMS = ("drums", "bass", "other", "vocals")
HINTS = {"auto", "bal", "ur", "fa", "en"}
MODELS_HINT = "Download the Analyse models: python -m app.worker.fetch_models (in backend/)."
NOT_ON_CPU = ("model_missing", "missing_input")
_LUFS = re.compile(r"I:\s+(-?[\d.]+) LUFS")
M = TypeVar("M", bound=BaseModel)


def _folder(ctx: StageContext) -> Path:
    return analysis_dir(settings(), require(ctx, "analysis_id"))


def _stem(folder: Path, name: str) -> Path:
    return folder / "stems" / f"accompaniment~{name}.wav"


def store(ctx: StageContext, key: str, value: object) -> None:
    """Merge one part into the analysis result (the UI shows it on its next poll)."""
    with Session(ctx.engine) as session:
        row = session.get(Analysis, require(ctx, "analysis_id"))
        if row is None:
            raise StageError("analysis_missing", "This analysis no longer exists.")
        row.result_json = {**(row.result_json or {}), key: value}
        session.commit()


def _result_event(lines: list[str], fail_code: str) -> dict[str, Any]:
    events = json_events(lines)
    result: dict[str, Any] | None = next(
        (e for e in reversed(events) if e.get("event") == "result"), None
    )
    if result is not None:
        return result
    error = next((e for e in reversed(events) if e.get("event") == "error"), None)
    message = str(error.get("message")) if error else "The engine printed no result."
    hint = MODELS_HINT if error and error.get("code") == "model_missing" else ""
    raise StageError(fail_code, message, hint=hint)


def _validated(model: type[M], data: object) -> M:
    try:
        return model.model_validate(data)
    except ValidationError as error:
        first = error.errors()[0]
        where = ".".join(str(p) for p in first["loc"])
        raise StageError(
            "bad_engine_output", f"{model.__name__}: {where}: {first['msg']}"
        ) from error


def _on_gpu_then_cpu(
    ctx: StageContext, args: list[str], fail_code: str
) -> tuple[dict[str, Any], str | None]:
    """Run an engine script on the GPU; when CUDA itself fails, once more on the CPU.
    Returns the result event and why the GPU was given up (None if it was not)."""

    def attempt(device: str) -> dict[str, Any]:
        lines = run_engine(ctx, [*args, "--device", device], fail_code=fail_code)
        return _result_event(lines, fail_code)

    try:
        return attempt("cuda"), None
    except StageError as error:
        gpu_problem = error.code == "cuda_oom" or (
            error.code == fail_code and not any(c in error.message for c in NOT_ON_CPU)
        )
        if not gpu_problem:
            raise
        ctx.events.emit(
            "stage.retry",
            {"reason": "gpu_failed", "change": {"device": "cpu"}},
            stage=ctx.stage,
        )
        return attempt("cpu"), error.message[:500]


def _keep(stems: dict[str, str], label: str, target: Path) -> None:
    source = stems.get(label)
    if source is None or not Path(source).is_file() or Path(source).stat().st_size == 0:
        raise StageError("stem_not_found", f"The separator gave {sorted(stems)}, no '{label}'.")
    if Path(source).resolve() != target.resolve():
        shutil.move(source, target)


def _canonical_song(ctx: StageContext, folder: Path) -> Path:
    song = folder / "song.wav"
    if not song.is_file():
        source = require(ctx, "input_path")
        run_ffmpeg("-i", source, "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", str(song))
    return song


def _duration(song: Path) -> float | None:
    try:
        return round(probe(song).duration_s, 2)
    except MediaError:
        return None


def separate(ctx: StageContext) -> dict[str, object]:
    folder = _folder(ctx)
    song = _canonical_song(ctx, folder)
    vocals, backing = folder / "vocals.wav", folder / "accompaniment.wav"
    if not (vocals.is_file() and backing.is_file()):
        stems = separate_stems(ctx, BLEEDLESS, song, overlap=4)
        _keep(stems, "vocals", vocals)
        _keep(stems, "other", backing)
    progress(ctx, 1, 2, "steps", "vocals")
    if not all(_stem(folder, s).is_file() for s in INSTRUMENT_STEMS):
        # accompaniment.wav, not song~other.wav: Demucs' own "other" would overwrite it
        stems = separate_stems(ctx, HTDEMUCS, backing, overlap=4, out_dir=folder / "stems")
        for name in INSTRUMENT_STEMS:
            _keep(stems, name, _stem(folder, name))
    progress(ctx, 2, 2, "steps", "instruments")
    duration = _duration(song)
    store(ctx, "duration_s", duration)
    vocal_db = mean_db(vocals)
    return {"has_vocals": not is_silent(vocal_db), "vocals_db": vocal_db, "duration_s": duration}


def lyrics(ctx: StageContext) -> dict[str, object]:
    hint = str(ctx.params.get("language") or "auto")
    if hint not in HINTS:
        raise StageError("bad_params", f"Unknown language '{hint}'.")
    vocals = _folder(ctx) / "vocals.wav"
    if is_silent(mean_db(vocals)):
        found = Lyrics(
            language=None if hint == "auto" else hint,  # type: ignore[arg-type]
            approximate=hint == "bal",
            note="no_singing",
            segments=[],
        )
    else:
        args = [
            *engine_script("transcribe.py"),
            "--model-dir", str(settings().whisper_models_dir),
            "--language", hint,
            str(vocals),
        ]  # fmt: skip
        event, fallback = _on_gpu_then_cpu(ctx, args, "transcribe_failed")
        found = _validated(Lyrics, event)
        if fallback:
            found = found.model_copy(update={"fallback": fallback})
    store(ctx, "lyrics", found.model_dump(mode="json"))
    return {"language": found.language, "lines": len(found.segments), "device": found.device}


def integrated_lufs(path: Path) -> float | None:
    """Integrated loudness (EBU R128) from ffmpeg's ebur128 summary."""
    found = _LUFS.findall(run_ffmpeg("-i", str(path), "-af", "ebur128", "-f", "null", "-"))
    return float(found[-1]) if found else None


def style(ctx: StageContext) -> dict[str, object]:
    folder = _folder(ctx)
    song = folder / "song.wav"
    args = [
        *engine_script("style.py"),
        "--mix", str(song),
        "--accompaniment", str(folder / "accompaniment.wav"),
        "--vocals", str(folder / "vocals.wav"),
        "--drums", str(_stem(folder, "drums")),
        "--bass", str(_stem(folder, "bass")),
        "--other", str(_stem(folder, "other")),
        "--residue", str(_stem(folder, "vocals")),
        "--clap-dir", str(settings().clap_models_dir),
    ]  # fmt: skip
    event, _ = _on_gpu_then_cpu(ctx, args, "style_failed")
    raw = _validated(EngineStyle, event)
    found = _validated(
        Style,
        {
            **raw.model_dump(exclude={"stems", "instrument_tags"}),
            "loudness_lufs": integrated_lufs(song),
            "instruments": Instruments(stems=raw.stems, tags=raw.instrument_tags),
        },
    )
    store(ctx, "style", found.model_dump(mode="json"))
    return {"tempo_bpm": found.tempo_bpm, "key": f"{found.key} {found.scale}"}


def sections(ctx: StageContext) -> dict[str, object]:
    folder = _folder(ctx)
    args = [
        *engine_script("sections.py"),
        "--mix", str(folder / "song.wav"),
        "--vocals", str(folder / "vocals.wav"),
    ]  # fmt: skip
    lines = run_engine(ctx, args, fail_code="sections_failed")
    found = _validated(EngineSections, _result_event(lines, "sections_failed"))
    store(ctx, "sections", [s.model_dump(mode="json") for s in found.sections])
    return {"sections": len(found.sections), "sung": sum(s.has_vocals for s in found.sections)}
