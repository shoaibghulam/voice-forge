"""Parsing Applio's train.py stdout into typed progress records.

The sample lines are copied from the format strings in Applio's rvc/train/train.py
at the pinned commit. If Applio changes them, these tests are the alarm.
"""

from app.worker.parsers.applio_stdout import (
    EpochDone,
    StepProgress,
    TrainingCompleted,
    parse_line,
)


def test_parses_batch_progress_line() -> None:
    line = "arif_baloch | epoch=3 | step=120 | batch=16/40"

    assert parse_line(line) == StepProgress(epoch=3, step=120, batch=16, num_batches=40)


def test_parses_first_epoch_line_without_lowest_value() -> None:
    line = "arif_baloch | epoch=1 | step=40 | time=02:31:04 | training_speed=0:01:43"

    assert parse_line(line) == EpochDone(
        epoch=1, step=40, epoch_seconds=103, lowest_value=None, lowest_epoch=None
    )


def test_parses_later_epoch_line_with_lowest_value() -> None:
    line = (
        "arif_baloch | epoch=12 | step=480 | time=03:02:11 | training_speed=0:01:39"
        " | lowest_value=21.734 (epoch 10 and step 400)"
    )

    assert parse_line(line) == EpochDone(
        epoch=12, step=480, epoch_seconds=99, lowest_value=21.734, lowest_epoch=10
    )


def test_parses_epoch_longer_than_an_hour() -> None:
    line = "v | epoch=2 | step=8 | time=10:00:00 | training_speed=1:02:03"

    result = parse_line(line)

    assert isinstance(result, EpochDone)
    assert result.epoch_seconds == 3723


def test_parses_completion_line() -> None:
    line = "Training has been successfully completed with 50 epoch, 2000 steps and 27.415 loss gen."

    assert parse_line(line) == TrainingCompleted(epochs=50, steps=2000, loss_gen=27.415)


def test_unrelated_log_lines_return_none() -> None:
    assert parse_line("Using BFloat16 for training.") is None
    assert parse_line("") is None
    assert parse_line("   ") is None


def test_tolerates_trailing_whitespace_and_carriage_return() -> None:
    line = "v | epoch=3 | step=120 | batch=16/40  \r"

    assert parse_line(line) == StepProgress(epoch=3, step=120, batch=16, num_batches=40)
