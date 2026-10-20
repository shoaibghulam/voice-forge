"""Pure decisions inside the pipeline stages."""

import pytest

from app.worker.stages.logic import (
    Plateau,
    is_oom,
    octave_shift,
    parse_checkpoint,
    usable_gate,
)


def test_oom_is_detected_in_torch_and_cuda_messages() -> None:
    assert is_oom(["...", "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate"])
    assert is_oom(["RuntimeError: CUDA error: out of memory"])
    assert not is_oom(["epoch=3 | step=120"])


@pytest.mark.parametrize(
    ("source", "target", "expected"),
    [
        (196.0, 196.0, 0),  # same range
        (110.0, 220.0, 12),  # male source, female singer
        (330.0, 165.0, -12),  # female source, male singer
        (196.0, 247.0, 0),  # 4 semitones apart rounds to no octave shift
        (100.0, 420.0, 24),  # two octaves
        (50.0, 800.0, 24),  # clamped
    ],
)
def test_octave_shift_is_whole_octaves(source: float, target: float, expected: int) -> None:
    assert octave_shift(source, target) == expected


def test_octave_shift_is_zero_when_a_median_is_unknown() -> None:
    assert octave_shift(None, 200.0) == 0
    assert octave_shift(200.0, None) == 0


def test_plateau_waits_for_minimum_epochs() -> None:
    plateau = Plateau(patience=3, min_epochs=10)

    stops = [plateau.update(epoch, 20.0) for epoch in range(1, 10)]

    assert not any(stops)


def test_plateau_stops_after_patience_without_one_percent_gain() -> None:
    plateau = Plateau(patience=3, min_epochs=1)
    for epoch, mel in enumerate([30.0, 25.0, 22.0], start=1):
        assert not plateau.update(epoch, mel)

    results = [plateau.update(epoch, 21.9) for epoch in (4, 5, 6)]

    assert results == [False, False, True]


def test_plateau_resets_on_real_improvement() -> None:
    plateau = Plateau(patience=2, min_epochs=1)
    plateau.update(1, 20.0)
    plateau.update(2, 19.95)

    assert not plateau.update(3, 18.0)
    assert plateau.best == 18.0


def test_parse_checkpoint_name() -> None:
    assert parse_checkpoint("voice_25e_3400s.pth", "voice") == (25, 3400)
    assert parse_checkpoint("G_3400.pth", "voice") is None
    assert parse_checkpoint("other_25e_3400s.pth", "voice") is None


def test_silence_threshold() -> None:
    from app.worker.stages.logic import is_silent

    assert is_silent(-91.0)  # what the separators output when they remove everything
    assert not is_silent(-20.8)  # a real separated vocal


@pytest.mark.parametrize(
    ("before", "after", "lost"),
    [
        (-20.8, -65.5, True),  # studio de-reverb on a wet vocal (first real cover)
        (-21.4, -32.7, True),  # de-echo removing 11 dB
        (-19.8, -21.3, False),  # normal cassette clean-up on the training songs
        (-40.0, -61.0, True),  # anything ending silent
    ],
)
def test_cleanup_that_removes_the_voice_is_detected(
    before: float, after: float, lost: bool
) -> None:
    from app.worker.stages.logic import lost_voice

    assert lost_voice(before, after) is lost


def test_network_errors_are_recognised() -> None:
    from app.worker.stages.logic import is_network_error

    assert is_network_error("requests.exceptions.ConnectionError: ('Connection aborted.'")
    assert is_network_error("ConnectionResetError(10054, 'forcibly closed')")
    assert not is_network_error("CUDA out of memory")


@pytest.mark.parametrize(
    ("minutes", "code"),
    [(3.0, "dataset_too_small"), (7.0, "warn_small"), (25.0, None)],
)
def test_usable_gate(minutes: float, code: str | None) -> None:
    assert usable_gate(minutes) == code
