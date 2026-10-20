"""Pure decisions inside the Analyse engine scripts (transcribe.py, style.py, sections.py).

The scripts run in the engine venv, but their decision helpers use only the standard
library at import time, so they are tested here without numpy, librosa or a GPU."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "engine_scripts"


def load(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(f"engine_{name}", SCRIPTS / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses need the module registered
    spec.loader.exec_module(module)
    return module


transcribe = load("transcribe")
style = load("style")
sections = load("sections")


# --- transcribe -----------------------------------------------------------------------


def test_decoder_scores_turn_into_shares_that_favour_the_best() -> None:
    shares = transcribe.share({"ur": -0.485, "fa": -0.209, "en": -1.205})

    assert max(shares, key=shares.get) == "fa"
    assert shares["fa"] > 0.9
    assert sum(shares.values()) == pytest.approx(1.0)


def test_arabic_script_text_is_normalised_and_loops_are_cut() -> None:
    assert transcribe.normalise("كيف  ي‏", "fa") == "کیف ی"
    assert transcribe.normalise("نشتا تصویہ تصویہ تصویہ تصویہ", "ur") == "نشتا تصویہ تصویہ"
    assert transcribe.normalise("la la la la land", "en") == "la la land"
    assert transcribe.normalise("ab ab abc", "en") == "ab ab abc"


def test_music_markers_and_hallucinations_are_not_lyrics() -> None:
    assert not transcribe.is_lyric("موسیقی", 1.9, 60.2)
    assert not transcribe.is_lyric("Thank you.", 61.4, 67.5)
    assert not transcribe.is_lyric("Satsang with Mooji", 1.9, 61.4)  # 18 chars over 60 s
    assert not transcribe.is_lyric("...", 0, 2)
    assert transcribe.is_lyric("روچ نوکی تو شتتی سازے", 140.2, 171.1)


def test_segments_are_cleaned_trimmed_and_deduplicated() -> None:
    voiced = [False] * 10 + [True] * 20 + [False] * 30
    raw = [
        (0.0, 4.0, "line"), (4.0, 5.0, "line"), (5.0, 5.5, "line"),
        (5.5, 6.0, "موسیقی"),
    ]  # fmt: skip

    out = transcribe.clean_segments(raw, "en", voiced)

    assert out == [{"start": 1.0, "end": 3.0, "text": "line"},
                   {"start": 4.0, "end": 5.0, "text": "line"}]  # fmt: skip


def test_vocal_regions_bridge_short_gaps_and_drop_blips() -> None:
    voiced = [False] * 5 + [True] * 20 + [False] * 10 + [True] * 5 + [False] * 30 + [True] * 3

    assert transcribe.vocal_regions(voiced) == [(0.5, 4.0)]
    assert transcribe.vocal_regions([]) == []


def test_regions_without_any_lyric_are_found_for_a_retry() -> None:
    regions = [(0.0, 10.0), (20.0, 30.0)]

    missed = transcribe.silent_regions(regions, [{"start": 2.0, "end": 4.0, "text": "a"}])

    assert missed == [(20.0, 30.0)]


# --- style ------------------------------------------------------------------------------


def test_key_detection_finds_a_major_and_a_minor_key() -> None:
    # chroma is indexed by absolute pitch class (C = 0); A is 9
    c_major = [1.0, 0, 0.5, 0, 0.8, 0.6, 0, 0.9, 0, 0.5, 0, 0.3]
    a_minor = [style.MINOR[(pitch - 9) % 12] for pitch in range(12)]

    assert style.detect_key(c_major)[:2] == ("C", "major")
    assert style.detect_key(c_major)[2] > 0.8
    assert style.detect_key(a_minor)[:2] == ("A", "minor")


def test_tempo_agreement_counts_double_and_half_time() -> None:
    assert style.tempo_agreement(100, [100, 200, 50, 133]) == 0.75
    assert style.tempo_agreement(0, [100]) == 0.0


def test_stem_shares_and_top_labels() -> None:
    assert style.stem_shares({"vocals": 3.0, "drums": 1.0}) == {"vocals": 75.0, "drums": 25.0}
    assert style.stem_shares({"vocals": 0.0}) == {"vocals": 0.0}
    top = style.top_labels(["a", "b", "c", "d"], [0.1, 0.4, 0.3, 0.2])
    assert [t["label"] for t in top] == ["b", "c", "d"]


# --- sections -------------------------------------------------------------------------


def seg(start: float, end: float, vocal: float, energy: float, chroma: tuple[float, ...]) -> object:
    return sections.Segment(start=start, end=end, vocal_share=vocal, energy=energy, chroma=chroma)


HOOK = (1.0, 0.0, 0.2, 0.0, 0.9, 0.1, 0.0, 0.8, 0.0, 0.1, 0.0, 0.0)
VERSE = (0.0, 0.9, 0.0, 0.7, 0.0, 0.0, 0.8, 0.0, 0.6, 0.0, 0.5, 0.1)
OTHER = (0.3, 0.3, 0.9, 0.0, 0.2, 0.8, 0.1, 0.0, 0.1, 0.9, 0.0, 0.4)


def test_sections_label_intro_verse_chorus_instrumental_outro() -> None:
    song = [
        seg(0, 10, 0.0, 0.1, OTHER), seg(10, 30, 0.9, 0.2, VERSE), seg(30, 45, 0.9, 0.5, HOOK),
        seg(45, 60, 0.0, 0.3, OTHER), seg(60, 75, 0.8, 0.2, OTHER), seg(75, 90, 0.9, 0.6, HOOK),
        seg(90, 100, 0.1, 0.1, OTHER),
    ]  # fmt: skip

    labels = [(s["label"], s["has_vocals"]) for s in sections.label_sections(song)]

    assert labels == [
        ("intro", False), ("verse", True), ("chorus", True), ("instrumental", False),
        ("verse", True), ("chorus", True), ("outro", False),
    ]  # fmt: skip


def test_neighbouring_sections_with_one_label_are_joined() -> None:
    song = [seg(0, 10, 0.9, 0.2, VERSE), seg(10, 20, 0.5, 0.2, OTHER)]

    joined = sections.label_sections(song)

    assert joined == [{"start": 0, "end": 20, "label": "verse", "has_vocals": True,
                       "vocal_share": 0.7}]  # fmt: skip


def test_short_segments_merge_into_their_neighbour() -> None:
    song = [seg(0, 2, 0, 0, OTHER), seg(2, 20, 0, 0, OTHER), seg(20, 22, 0, 0, OTHER)]

    merged = sections.merge_short(song)

    assert [(s.start, s.end) for s in merged] == [(0, 22)]


def test_segment_count_scales_with_length_within_bounds() -> None:
    assert sections.segment_count(193, 400) == 8
    assert sections.segment_count(60, 400) == 6
    assert sections.segment_count(1200, 400) == 12
    assert sections.segment_count(193, 4) == 3
