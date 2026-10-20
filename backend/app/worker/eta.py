"""Time-remaining estimates for stages and whole jobs (docs/06 "ETA").

Three methods, and the UI shows which one produced a number (a "≈" for estimates):

- seed:  before enough items are done, use the benchmark's per-item time for this GPU
- count: once MIN_DONE items are done, extrapolate the measured pace
- ema:   training epochs, an exponential moving average of epoch time, so a laptop that
         starts throttling pushes the ETA out within a few epochs instead of never
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

MIN_DONE = 3
EMA_ALPHA = 0.3

Method = Literal["seed", "count", "ema"]


@dataclass(frozen=True)
class Eta:
    seconds: float | None
    method: Method


def count_eta(
    done: int,
    total: int,
    elapsed_s: float,
    seed_per_item_s: float | None = None,
    min_done: int = MIN_DONE,
) -> Eta:
    remaining = max(total - done, 0)
    if remaining == 0:
        return Eta(seconds=0, method="count")
    if done >= min_done and elapsed_s > 0:
        return Eta(seconds=elapsed_s / done * remaining, method="count")
    if seed_per_item_s is not None:
        return Eta(seconds=seed_per_item_s * remaining, method="seed")
    return Eta(seconds=None, method="seed")


@dataclass(frozen=True)
class EpochEma:
    value: float | None = None

    def update(self, epoch_s: float) -> "EpochEma":
        if self.value is None:
            return EpochEma(value=epoch_s)
        return EpochEma(value=EMA_ALPHA * epoch_s + (1 - EMA_ALPHA) * self.value)

    def eta(self, remaining_epochs: int) -> Eta:
        if self.value is None:
            return Eta(seconds=None, method="ema")
        return Eta(seconds=self.value * max(remaining_epochs, 0), method="ema")


def job_eta(stage_seconds: Sequence[float | None]) -> float | None:
    """Sum of remaining stages; unknown if any of them is unknown."""
    if any(seconds is None for seconds in stage_seconds):
        return None
    return sum(seconds for seconds in stage_seconds if seconds is not None)
