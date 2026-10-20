"""prepare_dataset: validate -> separate -> dereverb -> denoise -> slice -> qc (docs/04 §1-4).

Job params: singer_id, preset (cassette | studio | live).

Stems live at stems/<song_id>/<song_id>~<name>.wav. The `<song_id>~` prefix is what
separate.py keeps when it names outputs, so a stem's song is always recoverable and
names never grow along the chain (docs/05 A12). Every chain step skips songs whose
output already exists, which is what makes a resumed job cheap.
"""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.models import Clip, Singer, Song
from app.services.storage import singer_dir, stems_dir
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages.common import (
    engine_script,
    json_events,
    mean_db,
    progress,
    require,
    run_engine,
    settings,
)
from app.worker.stages.logic import is_network_error, is_silent, lost_voice, usable_gate

KARAOKE = "bs_roformer_karaoke_frazer_becruily.ckpt"
BLEEDLESS = "mel_band_roformer_kim_ft2_bleedless_unwa.ckpt"
DEREVERB_ECHO = "dereverb-echo_mel_band_roformer_sdr_13.4843_v2.ckpt"
DEREVERB = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt"
DENOISE = "denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt"

PRESETS: dict[str, dict[str, list[str] | str]] = {
    "cassette": {"separate": [KARAOKE, BLEEDLESS], "dereverb": DEREVERB_ECHO},
    "live": {"separate": [KARAOKE, BLEEDLESS], "dereverb": DEREVERB_ECHO},
    "studio": {"separate": [KARAOKE], "dereverb": DEREVERB},
}
ALL_MODELS = [KARAOKE, BLEEDLESS, DEREVERB_ECHO, DEREVERB, DENOISE]
KEEP = {
    KARAOKE: ("vocals",),
    BLEEDLESS: ("vocals",),
    DEREVERB_ECHO: ("dry", "noreverb", "no reverb"),
    DEREVERB: ("noreverb", "no reverb", "dry"),
    DENOISE: ("dry", "noise free"),
}


def _ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if found is None:
        raise StageError("ffmpeg_missing", "ffmpeg is not installed or not on PATH.")
    return found


def _ready_songs(ctx: StageContext) -> list[Song]:
    with Session(ctx.engine, expire_on_commit=False) as session:
        query = select(Song).where(
            Song.singer_id == require(ctx, "singer_id"), Song.status == "ready"
        )
        return list(session.scalars(query.order_by(Song.created_at)))


def stem_path(singer_id: str, song_id: str, name: str) -> Path:
    return stems_dir(settings(), singer_id, song_id) / f"{song_id}~{name}.wav"


def canonical_path(singer_id: str, song_id: str) -> Path:
    return singer_dir(settings(), singer_id) / "songs" / f"{song_id}.wav"


def _decode(source: Path, target: Path) -> str:
    """Transcode to 44.1 kHz stereo PCM and return an md5 of the decoded audio."""
    ffmpeg = _ffmpeg()
    subprocess.run(  # noqa: S603 - fixed argument list
        [
            ffmpeg,
            "-v",
            "error",
            "-y",
            "-protocol_whitelist",  # user file: no playlists pulling other files or URLs
            "file",
            "-i",
            str(source),
            "-ar",
            "44100",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            str(target),
        ],
        check=True,
        timeout=600,
    )
    digest = subprocess.run(  # noqa: S603 - fixed argument list
        [ffmpeg, "-v", "error", "-i", str(target), "-f", "md5", "-"],
        capture_output=True,
        text=True,
        check=True,
        timeout=600,
    )
    return digest.stdout.strip()


def validate(ctx: StageContext) -> dict[str, object]:
    """Canonical WAV for every uploaded song; identical recordings are marked duplicate."""
    singer_id = require(ctx, "singer_id")
    with Session(ctx.engine) as session:
        songs = list(
            session.scalars(
                select(Song)
                .where(Song.singer_id == singer_id, Song.status.in_(("uploaded", "ready")))
                .order_by(Song.created_at)
            )
        )
        if not songs:
            raise StageError("no_songs", "Upload songs for this singer first.")
        seen: dict[str, str] = {}
        for done, song in enumerate(songs, start=1):
            target = canonical_path(singer_id, song.id)
            target.parent.mkdir(parents=True, exist_ok=True)
            if song.fingerprint is None or not target.exists():
                song.fingerprint = _decode(Path(song.stored_path), target)
            duplicate_of = seen.get(song.fingerprint)
            song.status = "duplicate" if duplicate_of else "ready"
            seen.setdefault(song.fingerprint, song.id)
            session.commit()
            progress(ctx, done, len(songs), "songs", song.original_filename)
        # count inside the session: the Song objects expire on commit and detach after it
        ready = sum(1 for s in songs if s.status == "ready")
        total = len(songs)
    return {"songs": total, "ready": ready, "duplicates": total - ready}


def _separate_once(
    ctx: StageContext, model: str, todo: list[tuple[str, Path]], work: Path, segment: int
) -> list[dict[str, Any]]:
    def on_line(line: str) -> None:
        if line.startswith('{"event": "progress"'):
            event = json.loads(line)
            progress(ctx, event["done"], event["total"], "songs", str(event.get("item", "")))

    args = [
        *engine_script("separate.py"),
        "--model",
        model,
        "--model-dir",
        str(settings().separator_models_dir),
        "--out-dir",
        str(work),
        "--segment",
        str(segment),
        "--overlap",
        "2",
        *(str(p) for _, p in todo),
    ]
    lines = run_engine(ctx, args, on_line=on_line, fail_code="separation_failed")
    errors = [e for e in json_events(lines) if e.get("event") == "error"]
    if errors:
        raise StageError(
            str(errors[0].get("code", "separation_failed")), str(errors[0].get("message", ""))
        )
    return [e for e in json_events(lines) if e.get("event") == "progress"]


def chain_step(ctx: StageContext, model: str, src: str, dst: str) -> int:
    """Run one model over every ready song missing `dst`; returns how many were processed."""
    singer_id = require(ctx, "singer_id")
    todo = []
    for song in _ready_songs(ctx):
        if stem_path(singer_id, song.id, dst).exists():
            continue
        source = (
            canonical_path(singer_id, song.id)
            if src == "song"
            else stem_path(singer_id, song.id, src)
        )
        todo.append((song.id, source))
    if not todo:
        return 0
    work = singer_dir(settings(), singer_id) / "stems" / "_work" / ctx.stage
    try:
        produced = _separate_once(ctx, model, todo, work, segment=256)
    except StageError as error:
        if error.code == "cuda_oom":
            produced = _separate_once(ctx, model, todo, work, segment=128)  # docs/04 §2
        elif is_network_error(error.message):
            produced = _separate_once(ctx, model, todo, work, segment=256)  # model download
        else:
            raise
    for (song_id, _), event in zip(todo, produced, strict=True):
        outputs = {str(k).lower(): str(v) for k, v in dict(event["outputs"]).items()}
        kept = next((outputs[label] for label in KEEP[model] if label in outputs), None)
        if kept is None:
            wanted = KEEP[model]
            raise StageError("stem_not_found", f"{model} gave {sorted(outputs)}, wanted {wanted}")
        target = stem_path(singer_id, song_id, dst)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(kept, target)
    shutil.rmtree(work, ignore_errors=True)
    return len(todo)


def _preset(ctx: StageContext) -> dict[str, list[str] | str]:
    name = str(ctx.params.get("preset", "cassette"))
    if name not in PRESETS:
        raise StageError("bad_params", f"Unknown preset '{name}'.")
    return PRESETS[name]


def _redo_silent_leads(ctx: StageContext, dst: str) -> int:
    """Songs whose karaoke lead came out silent get the plain vocal model instead.

    The karaoke model can file a whole vocal under "backing" (wide-stereo or doubled
    mixes); without this those songs were silently dropped as "no voice"."""
    singer_id = require(ctx, "singer_id")
    silent = [
        s.id
        for s in _ready_songs(ctx)
        if stem_path(singer_id, s.id, dst).exists()
        and is_silent(mean_db(stem_path(singer_id, s.id, dst)))
    ]
    if not silent:
        return 0
    ctx.events.emit(
        "stage.retry",
        {"reason": "no_lead_vocal", "songs": len(silent), "change": {"model": BLEEDLESS}},
        stage=ctx.stage,
    )
    for song_id in silent:
        stem_path(singer_id, song_id, dst).unlink()
    return chain_step(ctx, BLEEDLESS, "song", dst)


def separate(ctx: StageContext) -> dict[str, object]:
    models = list(_preset(ctx)["separate"])
    first_dst = "lead" if len(models) > 1 else "vocals"
    processed = chain_step(ctx, models[0], "song", first_dst)
    redone = _redo_silent_leads(ctx, first_dst)
    if len(models) > 1:
        processed = max(processed, chain_step(ctx, models[1], "lead", "vocals"))
    return {"processed": processed, "models": models, "vocal_fallback": redone}


def _keep_voice(ctx: StageContext, src: str, dst: str) -> int:
    """Per song: if this clean-up step made the vocal much quieter, it removed the singer,
    not the room or the hiss - keep the step's input instead (docs/05 D12)."""
    singer_id = require(ctx, "singer_id")
    restored = 0
    for song in _ready_songs(ctx):
        source, target = stem_path(singer_id, song.id, src), stem_path(singer_id, song.id, dst)
        if source.exists() and target.exists() and lost_voice(mean_db(source), mean_db(target)):
            shutil.copyfile(source, target)
            restored += 1
    if restored:
        ctx.events.emit(
            "stage.retry",
            {"reason": "cleanup_removed_voice", "songs": restored, "change": {"skip": ctx.stage}},
            stage=ctx.stage,
        )
    return restored


def dereverb(ctx: StageContext) -> dict[str, object]:
    model = str(_preset(ctx)["dereverb"])
    processed = chain_step(ctx, model, "vocals", "noreverb")
    return {
        "processed": processed,
        "model": model,
        "kept_input": _keep_voice(ctx, "vocals", "noreverb"),
    }


def denoise(ctx: StageContext) -> dict[str, object]:
    processed = chain_step(ctx, DENOISE, "noreverb", "dry")
    return {
        "processed": processed,
        "model": DENOISE,
        "kept_input": _keep_voice(ctx, "noreverb", "dry"),
    }


def slice_clips(ctx: StageContext) -> dict[str, object]:
    singer_id = require(ctx, "singer_id")
    folder = singer_dir(settings(), singer_id)
    clips_dir = folder / "clips"
    shutil.rmtree(clips_dir, ignore_errors=True)
    songs = [f"{s.id}={stem_path(singer_id, s.id, 'dry')}" for s in _ready_songs(ctx)]
    if not songs:
        raise StageError("no_songs", "No cleaned songs to slice.")

    def on_line(line: str) -> None:
        if line.startswith('{"event": "progress"'):
            event = json.loads(line)
            progress(ctx, event["done"], event["total"], "songs")

    lines = run_engine(
        ctx,
        [*engine_script("qc.py"), "--out-dir", str(clips_dir), *songs],
        on_line=on_line,
        fail_code="slicing_failed",
    )
    report = folder / "qc" / "report.jsonl"
    report.parent.mkdir(parents=True, exist_ok=True)
    events = json_events(lines)
    report.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    return {"clips": sum(1 for e in events if e.get("event") == "clip")}


def _store_clips(ctx: StageContext, singer_id: str, events: list[dict[str, Any]]) -> None:
    clip_events = [e for e in events if e.get("event") == "clip"]
    with Session(ctx.engine) as session:
        session.execute(delete(Clip).where(Clip.singer_id == singer_id))
        for event in clip_events:
            session.add(
                Clip(
                    singer_id=singer_id,
                    song_id=str(event["song_id"]),
                    path=str(event["path"]),
                    start_s=float(event["start_s"]),
                    duration_s=float(event["duration_s"]),
                    verdict=str(event["verdict"]),
                    reason=event.get("reason"),
                    scores_json=dict(event.get("scores") or {}),
                )
            )
        for event in events:
            if event.get("event") == "song" and event.get("no_voice"):
                song = session.get(Song, str(event["song_id"]))
                if song is not None:
                    song.status = "no_voice"
        session.commit()
    for start in range(0, len(clip_events), 20):
        ctx.events.emit("qc.clip", {"clips": clip_events[start : start + 20]}, stage=ctx.stage)


def qc(ctx: StageContext) -> dict[str, object]:
    singer_id = require(ctx, "singer_id")
    report = singer_dir(settings(), singer_id) / "qc" / "report.jsonl"
    if not report.exists():
        raise StageError("no_report", "Slicing produced no report.")
    events = [json.loads(line) for line in report.read_text(encoding="utf-8").splitlines() if line]
    _store_clips(ctx, singer_id, events)
    clips = [e for e in events if e.get("event") == "clip"]
    kept_s = sum(float(c["duration_s"]) for c in clips if c["verdict"] == "keep")
    rejected: dict[str, int] = {}
    for clip in clips:
        if clip["verdict"] != "keep":
            rejected[str(clip["reason"])] = rejected.get(str(clip["reason"]), 0) + 1
    no_voice = [e["song_id"] for e in events if e.get("event") == "song" and e.get("no_voice")]
    with Session(ctx.engine) as session:
        singer = session.get(Singer, singer_id)
        name = singer.name if singer else ""
    minutes = round(kept_s / 60, 2)
    return {
        "usable_minutes": minutes,
        "rejected": rejected,
        "no_voice_songs": no_voice,
        "gate": usable_gate(minutes),
        "singer": name,
    }
