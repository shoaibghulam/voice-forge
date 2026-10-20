"""GPU telemetry through NVML (`nvidia-ml-py`, imported as `pynvml`).

The worker samples once a second while a job runs. Samples feed the dashboard's
`gpu.sample` events and a PeakTracker, which is how the benchmark measures the VRAM of
an engine SUBPROCESS - torch's own peak counters only see the process they run in.

NVML reports dedicated memory only. When the Windows driver spills into shared system
memory (docs/05 A11) used memory plateaus near the total while the job slows down, so
the dashboard watches for that plateau rather than trusting the number alone.

On this RTX 4050 Laptop, NVML intermittently answers utilisation queries with
"Unknown Error" (seen under load in the first benchmark). Memory is the reading that
matters, so every other field is best-effort (None when unreadable), and the sampler
thread counts a failed read and carries on instead of dying.
"""

import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeVar

import pynvml

BYTES_PER_MB = 2**20

T = TypeVar("T")


@dataclass(frozen=True)
class GpuSample:
    util: int | None
    mem_used_mb: int
    mem_total_mb: int
    temp_c: int | None
    power_w: float | None
    clock_mhz: int | None


class PeakTracker:
    """Accumulates samples into peak memory and mean utilisation."""

    def __init__(self, baseline_mb: int = 0) -> None:
        self.baseline_mb = baseline_mb
        self.peak_mem_used_mb = 0
        self.samples = 0
        self.failed_reads = 0
        self._util_total = 0
        self._util_count = 0

    def add(self, sample: GpuSample) -> None:
        self.peak_mem_used_mb = max(self.peak_mem_used_mb, sample.mem_used_mb)
        self.samples += 1
        if sample.util is not None:
            self._util_total += sample.util
            self._util_count += 1

    @property
    def mean_util(self) -> int:
        return round(self._util_total / self._util_count) if self._util_count else 0

    @property
    def peak_delta_mb(self) -> int:
        """Peak above what was in use before the job started (desktop, browser)."""
        return max(0, self.peak_mem_used_mb - self.baseline_mb)


Reader = Callable[[], GpuSample | None]


def drain(reader: Reader, tracker: PeakTracker, limit: int) -> None:
    """Feed up to `limit` readings into the tracker; stops early when the reader runs dry."""
    for _ in range(limit):
        reading = reader()
        if reading is None:
            return
        tracker.add(reading)


def nvml_reader(device_index: int = 0) -> Callable[[], GpuSample]:
    """A reader bound to one GPU. NVML must stay initialised while it is used."""
    pynvml.nvmlInit()
    handle = pynvml.nvmlDeviceGetHandleByIndex(device_index)

    def read() -> GpuSample:
        memory = pynvml.nvmlDeviceGetMemoryInfo(handle)  # the one reading that must work
        return GpuSample(
            util=_optional(lambda: int(pynvml.nvmlDeviceGetUtilizationRates(handle).gpu)),
            mem_used_mb=int(memory.used) // BYTES_PER_MB,
            mem_total_mb=int(memory.total) // BYTES_PER_MB,
            temp_c=_optional(
                lambda: int(pynvml.nvmlDeviceGetTemperature(handle, pynvml.NVML_TEMPERATURE_GPU))
            ),
            power_w=_optional(lambda: round(pynvml.nvmlDeviceGetPowerUsage(handle) / 1000, 1)),
            clock_mhz=_optional(
                lambda: int(pynvml.nvmlDeviceGetClockInfo(handle, pynvml.NVML_CLOCK_GRAPHICS))
            ),
        )

    return read


def _optional(query: Callable[[], T]) -> T | None:
    try:
        return query()
    except pynvml.NVMLError:
        return None


class GpuSampler:
    """Background thread: read every `interval_s`, feed a tracker, hand each sample on."""

    def __init__(
        self,
        reader: Reader,
        tracker: PeakTracker,
        on_sample: Callable[[GpuSample], None] | None = None,
        interval_s: float = 1.0,
    ) -> None:
        self._reader = reader
        self._tracker = tracker
        self._on_sample = on_sample
        self._interval_s = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="gpu-sampler", daemon=True)

    def __enter__(self) -> "GpuSampler":
        self._thread.start()
        return self

    def __exit__(self, *_: object) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval_s * 2)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                reading = self._reader()
            except Exception:  # a failed read is counted, never fatal to the thread
                self._tracker.failed_reads += 1
                reading = None
            if reading is not None:
                self._tracker.add(reading)
                if self._on_sample is not None:
                    self._on_sample(reading)
            self._stop.wait(self._interval_s)
