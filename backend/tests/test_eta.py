"""ETA maths behind the live view's countdown (docs/06 "ETA")."""

import pytest

from app.worker.eta import EpochEma, count_eta, job_eta


def test_count_eta_uses_seed_until_three_items_are_done() -> None:
    eta = count_eta(done=1, total=10, elapsed_s=500, seed_per_item_s=60)

    assert eta.method == "seed"
    assert eta.seconds == 9 * 60


def test_count_eta_extrapolates_from_measured_pace() -> None:
    eta = count_eta(done=4, total=10, elapsed_s=200, seed_per_item_s=60)

    assert eta.method == "count"
    assert eta.seconds == pytest.approx(300)


def test_count_eta_is_unknown_without_progress_or_seed() -> None:
    eta = count_eta(done=0, total=10, elapsed_s=5, seed_per_item_s=None)

    assert eta.seconds is None


def test_count_eta_is_zero_when_finished() -> None:
    assert count_eta(done=10, total=10, elapsed_s=99).seconds == 0


def test_epoch_ema_starts_with_first_epoch() -> None:
    ema = EpochEma().update(100)

    assert ema.value == 100


def test_epoch_ema_weights_recent_epochs() -> None:
    ema = EpochEma().update(100).update(200)

    assert ema.value == pytest.approx(130)  # 0.3 * 200 + 0.7 * 100


def test_epoch_ema_is_immutable() -> None:
    first = EpochEma().update(100)

    first.update(500)

    assert first.value == 100


def test_epoch_eta_multiplies_by_remaining_epochs() -> None:
    eta = EpochEma().update(100).eta(remaining_epochs=10)

    assert eta.method == "ema"
    assert eta.seconds == 1000


def test_epoch_eta_unknown_before_any_epoch() -> None:
    assert EpochEma().eta(remaining_epochs=10).seconds is None


def test_job_eta_sums_known_stages() -> None:
    assert job_eta([120.0, 0.0, 600.0]) == 720


def test_job_eta_is_unknown_if_any_remaining_stage_is_unknown() -> None:
    assert job_eta([120.0, None]) is None
