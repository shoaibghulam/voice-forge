"""Subprocess runner: line streaming, exit codes, timeouts and process-tree kill.

Uses the test interpreter itself as a fake engine, so no GPU or Applio is needed.
"""

import sys
import threading
import time

import psutil

from app.worker.runner import RunResult, run_streaming

PY = sys.executable


def gone_within(pid: int, seconds: float) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not psutil.pid_exists(pid):
            return True
        time.sleep(0.1)
    return False


def test_streams_every_stdout_line_in_order() -> None:
    lines: list[str] = []

    result = run_streaming(
        [PY, "-c", "for i in range(3): print(f'line {i}', flush=True)"], lines.append
    )

    assert lines == ["line 0", "line 1", "line 2"]
    assert result == RunResult(returncode=0, cancelled=False, timed_out=False, tail=lines)


def test_merges_stderr_into_the_stream() -> None:
    lines: list[str] = []

    run_streaming([PY, "-c", "import sys; sys.stderr.write('boom\\n')"], lines.append)

    assert lines == ["boom"]


def test_reports_nonzero_exit_code() -> None:
    result = run_streaming([PY, "-c", "raise SystemExit(3)"], lambda _: None)

    assert result.returncode == 3
    assert not result.cancelled


def test_keeps_only_the_last_lines_as_tail() -> None:
    result = run_streaming(
        [PY, "-c", "for i in range(100): print(i)"], lambda _: None, tail_lines=5
    )

    assert result.tail == ["95", "96", "97", "98", "99"]


def test_passes_extra_environment() -> None:
    lines: list[str] = []

    run_streaming(
        [PY, "-c", "import os; print(os.environ['APPLIO_LOGS_DIR'])"],
        lines.append,
        env={"APPLIO_LOGS_DIR": "X:/runs"},
    )

    assert lines == ["X:/runs"]


def test_timeout_kills_the_process() -> None:
    started = time.monotonic()

    result = run_streaming([PY, "-c", "import time; time.sleep(30)"], lambda _: None, timeout_s=1)

    assert result.timed_out
    assert time.monotonic() - started < 10


def test_cancel_kills_grandchildren_too() -> None:
    """A dataloader-style grandchild must not survive cancel: it would keep holding VRAM."""
    spawner = (
        "import subprocess, sys, time;"
        "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']);"
        "print(c.pid, flush=True); time.sleep(60)"
    )
    cancel = threading.Event()
    child_pids: list[int] = []

    def on_line(line: str) -> None:
        child_pids.append(int(line))
        cancel.set()

    result = run_streaming([PY, "-c", spawner], on_line, cancel=cancel)

    assert result.cancelled
    assert child_pids
    assert gone_within(child_pids[0], seconds=5)
