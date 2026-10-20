"""Turn lines from Applio's rvc/train/train.py stdout into typed progress records.

Applio prints three kinds of line the dashboard cares about (pinned commit 5379cf2):

    <model> | epoch=3 | step=120 | batch=16/40
    <model> | epoch=3 | step=120 | time=02:31:04 | training_speed=0:01:43
        (from epoch 2 on, followed by: | lowest_value=21.734 (epoch 2 and step 80))
    Training has been successfully completed with 50 epoch, 2000 steps and 27.4 loss gen.

Everything else is log noise and parses to None. `training_speed` is the wall time of
the epoch as `str(timedelta)`, so it can exceed an hour (`1:02:03`).
"""

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class StepProgress:
    epoch: int
    step: int
    batch: int
    num_batches: int


@dataclass(frozen=True)
class EpochDone:
    epoch: int
    step: int
    epoch_seconds: int
    lowest_value: float | None
    lowest_epoch: int | None


@dataclass(frozen=True)
class TrainingCompleted:
    epochs: int
    steps: int
    loss_gen: float


ProgressRecord = StepProgress | EpochDone | TrainingCompleted

_STEP = re.compile(r"\| epoch=(\d+) \| step=(\d+) \| batch=(\d+)/(\d+)$")
_EPOCH = re.compile(
    r"\| epoch=(\d+) \| step=(\d+) \| time=[\d:]+ \| training_speed=(\d+):(\d\d):(\d\d)"
    r"(?: \| lowest_value=([\d.]+) \(epoch (\d+) and step \d+\))?$"
)
_COMPLETED = re.compile(
    r"^Training has been successfully completed with (\d+) epoch, (\d+) steps"
    r" and ([\d.]+) loss gen\.$"
)


def parse_line(line: str) -> ProgressRecord | None:
    """Parse one stdout line; None when it is not a progress line."""
    text = line.strip()
    if not text:
        return None

    if match := _STEP.search(text):
        epoch, step, batch, num_batches = map(int, match.groups())
        return StepProgress(epoch=epoch, step=step, batch=batch, num_batches=num_batches)

    if match := _EPOCH.search(text):
        e_epoch, e_step, hours, minutes, seconds, lowest, lowest_epoch = match.groups()
        return EpochDone(
            epoch=int(e_epoch),
            step=int(e_step),
            epoch_seconds=int(hours) * 3600 + int(minutes) * 60 + int(seconds),
            lowest_value=float(lowest) if lowest is not None else None,
            lowest_epoch=int(lowest_epoch) if lowest_epoch is not None else None,
        )

    if match := _COMPLETED.match(text):
        epochs, steps, loss_gen = match.groups()
        return TrainingCompleted(epochs=int(epochs), steps=int(steps), loss_gen=float(loss_gen))

    return None
