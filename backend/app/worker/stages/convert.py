"""convert: separate -> dereverb -> convert -> rereverb -> mix -> encode (docs/04 §9).

Job params: cover_id, singer_id, checkpoint_id, input_path, and `settings`:
    octave_auto (bool), semitones (int), timbre_strength (0-1 = index_rate),
    protect (0-0.5), vocal_level (0-2), reverb (none | light | medium | heavy)

Folder data/covers/<cover_id>/: song.<ext> (input), song~lead.wav, song~backing.wav,
song~dry.wav, converted.wav, vocal.wav, mix.wav, mix.mp3. Only the LEAD vocal is
converted; backing vocals stay in the backing track (docs/05 D1).
"""

import json
import shutil
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from app.models import Checkpoint, Cover, Singer
from app.services.storage import cover_dir
from app.worker import applio
from app.worker.stage_runner import StageContext, StageError
from app.worker.stages.common import (
    applio_paths,
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
from app.worker.stages.logic import is_silent, lost_voice, octave_shift
from app.worker.stages.prepare import BLEEDLESS, DEREVERB_ECHO, KARAOKE, KEEP

REVERB = {
    "light": "aecho=0.8:0.6:45|75:0.18|0.10",
    "medium": "aecho=0.8:0.7:60|110:0.28|0.16",
    "heavy": "aecho=0.8:0.75:80|160:0.38|0.24",
}
LIMIT = 10 ** (-1 / 20)  # -1 dBFS ceiling
AI_TAG = "AI-converted voice (Music Trainer)"


def _folder(ctx: StageContext) -> Path:
    return cover_dir(settings(), require(ctx, "cover_id"))


def _opts(ctx: StageContext) -> dict[str, Any]:
    raw = ctx.params.get("settings")
    return dict(raw) if isinstance(raw, dict) else {}


_ffmpeg = run_ffmpeg


NO_SINGING_HINT = "Is this an instrumental? Covers need a song with singing in it."


def separate(ctx: StageContext) -> dict[str, object]:
    folder = _folder(ctx)
    lead, backing = folder / "song~lead.wav", folder / "song~backing.wav"
    model = KARAOKE
    if not (lead.exists() and backing.exists()):
        source = Path(require(ctx, "input_path"))
        stems = separate_stems(ctx, KARAOKE, source, overlap=4)
        if is_silent(mean_db(Path(stems["vocals"]))):
            # The karaoke model can file the whole vocal under "backing" (wide-stereo or
            # doubled mixes; seen on the first real cover). Fall back to all vocals.
            ctx.events.emit(
                "stage.retry",
                {"reason": "no_lead_vocal", "change": {"model": BLEEDLESS}},
                stage=ctx.stage,
            )
            for leftover in stems.values():
                Path(leftover).unlink(missing_ok=True)
            model = BLEEDLESS
            stems = separate_stems(ctx, BLEEDLESS, source, overlap=4)
            stems = {"vocals": stems["vocals"], "instrumental": stems["other"]}
        shutil.move(stems["vocals"], lead)
        shutil.move(stems["instrumental"], backing)
    if is_silent(mean_db(lead)):
        raise StageError("no_singing", "No singing was found in this song.", hint=NO_SINGING_HINT)
    progress(ctx, 1, 1, "songs")
    return {"lead": str(lead), "backing": str(backing), "model": model}


def dereverb(ctx: StageContext) -> dict[str, object]:
    folder = _folder(ctx)
    lead, dry = folder / "song~lead.wav", folder / "song~dry.wav"
    if not dry.exists():
        # The gentler echo model (the one the cassette preset trains with); the studio
        # de-reverb model removed the whole vocal of an effects-heavy song.
        stems = separate_stems(ctx, DEREVERB_ECHO, lead, overlap=4)
        kept = next((stems[k] for k in KEEP[DEREVERB_ECHO] if k in stems), None)
        if kept is None:
            raise StageError("stem_not_found", f"dereverb gave {sorted(stems)}")
        shutil.move(kept, dry)
        for leftover in stems.values():
            Path(leftover).unlink(missing_ok=True)
    before, after = mean_db(lead), mean_db(dry)
    if lost_voice(before, after):
        # Converting the wet vocal beats converting silence (docs/05 D12).
        shutil.copyfile(lead, dry)
        ctx.events.emit(
            "stage.retry",
            {
                "reason": "cleanup_removed_voice",
                "change": {"skip": "dereverb", "before_db": before, "after_db": after},
            },
            stage=ctx.stage,
        )
        return {"dry": str(dry), "skipped": True}
    return {"dry": str(dry)}


def _source_median(ctx: StageContext, vocal: Path) -> float | None:
    lines = run_engine(
        ctx,
        [*engine_script("f0_stats.py"), "--applio-root", str(settings().applio_root), str(vocal)],
        fail_code="pitch_failed",
    )
    stats = json_events(lines)
    return stats[-1].get("median_hz") if stats else None


def _voice_files(ctx: StageContext) -> tuple[Path, Path, float | None]:
    with Session(ctx.engine) as session:
        ckpt = session.get(Checkpoint, require(ctx, "checkpoint_id"))
        singer = session.get(Singer, require(ctx, "singer_id"))
        if ckpt is None or singer is None:
            raise StageError("no_voice_model", "The chosen voice no longer exists.")
        model = Path(ckpt.model_path)
        target_median = singer.f0_median_hz
    indexes = sorted(model.parent.glob("*.index"))
    if not model.exists() or not indexes:
        raise StageError("no_voice_model", "The voice model or its index is missing on disk.")
    return model, indexes[0], target_median


def convert(ctx: StageContext) -> dict[str, object]:
    folder, opts = _folder(ctx), _opts(ctx)
    model, index, target_median = _voice_files(ctx)
    dry, out = folder / "song~dry.wav", folder / "converted.wav"
    source_median = _source_median(ctx, dry)
    if source_median is None:
        # Applio crashes with an opaque CUDA index error on a voiceless input; say why.
        raise StageError(
            "no_singing", "No singing pitch was found in the vocal.", hint=NO_SINGING_HINT
        )
    shift = octave_shift(source_median, target_median) if opts.get("octave_auto", True) else 0
    pitch = shift + int(opts.get("semitones", 0))
    config = applio.InferConfig(
        input_path=dry,
        output_path=out,
        pth_path=model,
        index_path=index,
        pitch=pitch,
        index_rate=float(opts.get("timbre_strength", 0.4)),
        protect=float(opts.get("protect", 0.4)),
    )
    run_engine(ctx, applio.infer_args(applio_paths(), config), fail_code="conversion_failed")
    if not out.exists() or out.stat().st_size == 0:
        raise StageError("conversion_failed", "Applio did not write the converted vocal.")
    if is_silent(mean_db(out)):
        # never hand over a "cover" that is only the backing track
        raise StageError(
            "conversion_silent",
            "The converted vocal came out silent.",
            hint="Try another song, or retry with timbre strength lowered.",
        )
    return {
        "pitch_shift": pitch,
        "octave_shift": shift,
        "source_median_hz": source_median,
        "target_median_hz": target_median,
    }


def rereverb(ctx: StageContext) -> dict[str, object]:
    folder, opts = _folder(ctx), _opts(ctx)
    amount = str(opts.get("reverb", "light"))
    source, target = folder / "converted.wav", folder / "vocal.wav"
    if amount in REVERB:
        _ffmpeg("-i", str(source), "-af", REVERB[amount], "-ar", "44100", str(target))
    else:
        _ffmpeg("-i", str(source), "-ar", "44100", str(target))
    return {"reverb": amount}


def _backing_input(folder: Path, semitones: int) -> list[str]:
    """Non-octave key changes shift the backing too, so the song stays in key (docs/04 §9c)."""
    backing = str(folder / "song~backing.wav")
    if semitones % 12 == 0:
        return ["-i", backing]
    shifted = folder / "backing_shifted.wav"
    if not shifted.exists():
        _ffmpeg("-i", backing, "-af", f"rubberband=pitch={2 ** (semitones / 12):.6f}", str(shifted))
    return ["-i", str(shifted)]


def mix(ctx: StageContext) -> dict[str, object]:
    folder, opts = _folder(ctx), _opts(ctx)
    vocal = folder / "vocal.wav"
    match_db = mean_db(folder / "song~lead.wav") - mean_db(vocal)
    level = max(0.0, min(2.0, float(opts.get("vocal_level", 1.0))))
    gain = 10 ** (match_db / 20) * level
    # Both inputs to stereo first: amix takes its layout from the FIRST input, and the
    # converted vocal is mono, so the first real cover came out mono (backing folded down,
    # voice ~7 dB too prominent). Upmixed, the voice sits centred at its original level.
    # The vocal is copied to both channels at FULL level (pan), not upmixed: ffmpeg's
    # mono->stereo upmix applies a -3 dB centre law, which left the voice 3 dB too quiet.
    stereo = "aresample=44100,aformat=channel_layouts=stereo"
    centre = "aresample=44100,aformat=channel_layouts=mono,pan=stereo|c0=c0|c1=c0"
    graph = (
        f"[0:a]volume={gain:.4f},{centre}[v];[1:a]{stereo}[b];"
        f"[v][b]amix=inputs=2:normalize=0,alimiter=limit={LIMIT:.4f}:level=0[out]"
    )
    semitones = int(opts.get("semitones", 0))
    _ffmpeg(
        "-i",
        str(vocal),
        *_backing_input(folder, semitones),
        "-filter_complex",
        graph,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s16le",
        str(folder / "mix.wav"),
    )
    return {
        "vocal_gain_db": round(match_db, 2),
        "vocal_level": level,
        "loudness_gain_db": _match_release_loudness(ctx, folder),
    }


MAX_LOUDNESS_GAIN_DB = 6.0


def _match_release_loudness(ctx: StageContext, folder: Path) -> float:
    """Bring the cover up to the original release's loudness (releases are mastered louder
    than a raw remix: -15.0 vs -17.1 dBFS on the first real cover), peaks held by the
    limiter. Never turns a cover down, never adds more than MAX_LOUDNESS_GAIN_DB."""
    mix_path = folder / "mix.wav"
    gain_db = mean_db(Path(require(ctx, "input_path"))) - mean_db(mix_path)
    gain_db = min(gain_db, MAX_LOUDNESS_GAIN_DB)
    if gain_db < 0.5:
        return 0.0
    louder = folder / "mix_loud.wav"
    _ffmpeg(
        "-i",
        str(mix_path),
        "-af",
        f"volume={gain_db:.2f}dB,alimiter=limit={LIMIT:.4f}:level=0",
        "-c:a",
        "pcm_s16le",
        str(louder),
    )
    louder.replace(mix_path)
    return round(gain_db, 2)


def encode(ctx: StageContext) -> dict[str, object]:
    folder = _folder(ctx)
    mix_wav, mix_mp3 = folder / "mix.wav", folder / "mix.mp3"
    _ffmpeg(
        "-i",
        str(mix_wav),
        "-c:a",
        "libmp3lame",
        "-b:a",
        "320k",
        "-metadata",
        f"comment={AI_TAG}",
        str(mix_mp3),
    )
    with Session(ctx.engine) as session:
        cover = session.get(Cover, require(ctx, "cover_id"))
        if cover is not None:
            cover.mix_path = str(mix_wav)
            cover.mp3_path = str(mix_mp3)
            cover.vocal_path = str(folder / "vocal.wav")
            cover.backing_path = str(folder / "song~backing.wav")
            session.commit()
    (folder / "README.txt").write_text(f"{AI_TAG}. Disclose synthetic media when publishing.\n")
    return {"mix": str(mix_wav), "mp3": str(mix_mp3), "settings": json.dumps(_opts(ctx))}
