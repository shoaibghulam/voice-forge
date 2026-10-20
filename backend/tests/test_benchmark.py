"""Pure parts of the benchmark: stem selection and the results report."""

import pytest

from app.worker.benchmark import BenchResult, StemNotFoundError, format_report, pick_stem


def test_pick_stem_matches_label_case_insensitively() -> None:
    outputs = {"other": "a_(other).wav", "vocals": "a_(vocals).wav"}

    assert pick_stem(outputs, ("Vocals",)) == "a_(vocals).wav"


def test_pick_stem_tries_candidates_in_order() -> None:
    outputs = {"Instrumental": "i.wav", "No Reverb": "dry.wav", "Reverb": "wet.wav"}

    assert pick_stem(outputs, ("noreverb", "no reverb")) == "dry.wav"


def test_pick_stem_never_falls_back_to_the_removed_stem() -> None:
    outputs = {"reverb": "wet.wav", "other": "x.wav"}

    with pytest.raises(StemNotFoundError, match="reverb, other"):
        pick_stem(outputs, ("noreverb",))


def test_real_time_factor_is_seconds_per_second_of_audio() -> None:
    result = BenchResult(
        stage="separate", label="m", seconds=60.0, audio_seconds=240.0, peak_vram_mb=3000
    )

    assert result.rtf == 0.25


def test_real_time_factor_is_none_without_audio_length() -> None:
    result = BenchResult(stage="train", label="b4", seconds=60.0, audio_seconds=0, peak_vram_mb=0)

    assert result.rtf is None


def test_report_has_a_row_per_result_and_flags_near_full_vram() -> None:
    results = [
        BenchResult("separate", "kim seg256 ov2", 50.0, 200.0, 2100),
        BenchResult("train", "batch 4", 95.0, 0, 5900, note="epoch time"),
    ]

    report = format_report(results, vram_total_mb=6141)

    lines = report.splitlines()
    assert lines[0].startswith("| Stage")
    assert any("kim seg256 ov2" in line and "0.25" in line for line in lines)
    assert any("batch 4" in line and "near limit" in line for line in lines)
