"""GPU sampling: peak tracking and snapshot shape, with NVML replaced by a fake reader."""

import time
from collections.abc import Iterator

from app.worker.gpu import GpuSample, GpuSampler, PeakTracker, drain


def sample(mem_used_mb: int, util: int = 50) -> GpuSample:
    return GpuSample(
        util=util,
        mem_used_mb=mem_used_mb,
        mem_total_mb=6141,
        temp_c=70,
        power_w=60.0,
        clock_mhz=1900,
    )


def test_peak_starts_at_zero() -> None:
    tracker = PeakTracker()

    assert tracker.peak_mem_used_mb == 0
    assert tracker.samples == 0


def test_peak_tracks_highest_memory_seen() -> None:
    tracker = PeakTracker()

    for used in (1200, 4800, 3100):
        tracker.add(sample(used))

    assert tracker.peak_mem_used_mb == 4800
    assert tracker.samples == 3


def test_peak_reports_mean_utilisation() -> None:
    tracker = PeakTracker()

    for util in (40, 80, 60):
        tracker.add(sample(1000, util=util))

    assert tracker.mean_util == 60


def test_mean_utilisation_is_zero_without_samples() -> None:
    assert PeakTracker().mean_util == 0


def test_baseline_is_subtracted_for_job_delta() -> None:
    tracker = PeakTracker(baseline_mb=900)

    tracker.add(sample(4900))

    assert tracker.peak_delta_mb == 4000


def test_mean_utilisation_skips_samples_where_it_was_unreadable() -> None:
    tracker = PeakTracker()

    tracker.add(sample(1000, util=80))
    tracker.add(GpuSample(None, 1200, 6141, None, None, None))

    assert tracker.mean_util == 80
    assert tracker.peak_mem_used_mb == 1200


def test_sampler_survives_a_reader_that_raises() -> None:
    """NVML intermittently fails on this laptop ('Unknown Error'); one bad read must not
    kill the sampler thread and zero the peak VRAM."""
    calls = 0

    def flaky() -> GpuSample:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("NVML Unknown Error")
        return sample(3000)

    tracker = PeakTracker()
    with GpuSampler(flaky, tracker, interval_s=0.01):
        deadline = time.monotonic() + 2
        while tracker.samples == 0 and time.monotonic() < deadline:
            time.sleep(0.01)

    assert tracker.peak_mem_used_mb == 3000
    assert tracker.failed_reads >= 1


def test_drain_feeds_tracker_until_reader_is_exhausted() -> None:
    readings: Iterator[GpuSample] = iter([sample(1000), sample(2500)])
    tracker = PeakTracker()

    drain(lambda: next(readings, None), tracker, limit=5)

    assert tracker.peak_mem_used_mb == 2500
    assert tracker.samples == 2
