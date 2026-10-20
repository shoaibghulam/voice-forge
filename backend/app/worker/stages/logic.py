"""Pure decisions used by the pipeline stages (no I/O, unit-tested)."""

import math
import re
from collections.abc import Sequence

MAX_OCTAVES = 2
MIN_USABLE_MINUTES = 5.0
WARN_USABLE_MINUTES = 10.0

_OOM = re.compile(r"out of memory|OutOfMemoryError", re.IGNORECASE)


def is_oom(lines: Sequence[str]) -> bool:
    return any(_OOM.search(line) for line in lines)


def octave_shift(source_median_hz: float | None, target_median_hz: float | None) -> int:
    """Whole-octave transposition (in semitones) that brings the source into the target
    singer's range. Whole octaves keep the vocal in key with the unshifted backing
    (docs/04 §9c); anything finer is the user's choice."""
    if not source_median_hz or not target_median_hz:
        return 0
    octaves = round(math.log2(target_median_hz / source_median_hz))
    return 12 * max(-MAX_OCTAVES, min(MAX_OCTAVES, octaves))


class Plateau:
    """Early stopping on the smoothed mel loss (Applio's own detector is not in train.py).

    Stops once `patience` epochs pass without a relative improvement of `min_gain`
    over the best value, but never before `min_epochs`.
    """

    def __init__(self, patience: int = 20, min_epochs: int = 30, min_gain: float = 0.01) -> None:
        self.patience = patience
        self.min_epochs = min_epochs
        self.min_gain = min_gain
        self.best: float | None = None
        self.best_epoch = 0
        self.stale = 0

    def update(self, epoch: int, mel: float) -> bool:
        if self.best is None or mel < self.best * (1 - self.min_gain):
            self.best, self.best_epoch, self.stale = mel, epoch, 0
        else:
            self.stale += 1
        return epoch >= self.min_epochs and self.stale >= self.patience


def parse_checkpoint(filename: str, model_name: str) -> tuple[int, int] | None:
    """'voice_25e_3400s.pth' -> (25, 3400): Applio's exported, usable voice files."""
    match = re.fullmatch(rf"{re.escape(model_name)}_(\d+)e_(\d+)s\.pth", filename)
    return (int(match.group(1)), int(match.group(2))) if match else None


_NETWORK = re.compile(
    r"ConnectionError|ConnectionResetError|ReadTimeout|RemoteDisconnected|"
    r"Temporary failure in name resolution|getaddrinfo failed",
    re.IGNORECASE,
)


def is_network_error(text: str) -> bool:
    """A failure caused by a dropped download (worth one retry), not by the audio."""
    return bool(_NETWORK.search(text))


SILENT_DBFS = -60.0


def is_silent(mean_dbfs: float) -> bool:
    """A stem this quiet holds no singing (separated non-voice comes out near -90 dBFS)."""
    return mean_dbfs <= SILENT_DBFS


MAX_CLEANUP_DROP_DB = 10.0


def lost_voice(before_dbfs: float, after_dbfs: float) -> bool:
    """A de-reverb/denoise step that makes the vocal much quieter removed the singer, not
    the room: on a heavily-effected vocal the studio de-reverb model took it from -20.8 to
    -65.5 dBFS (first real cover). Real clean-up removes a few dB at most."""
    return is_silent(after_dbfs) or before_dbfs - after_dbfs > MAX_CLEANUP_DROP_DB


def usable_gate(minutes: float) -> str | None:
    """docs/01 F4: refuse under 5 minutes of usable singing, warn under 10."""
    if minutes < MIN_USABLE_MINUTES:
        return "dataset_too_small"
    if minutes < WARN_USABLE_MINUTES:
        return "warn_small"
    return None
