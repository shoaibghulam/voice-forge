"""Run an engine subprocess, stream its output line by line, and kill it cleanly.

Every GPU stage runs in its own subprocess so that VRAM is fully released when it ends.
Three things here exist because of how training processes behave on Windows:

- Arguments are always a list, never a shell string: song names contain `(Vocals)`,
  spaces and quotes, which the shell treats as syntax (docs/05 A9).
- stderr is merged into stdout and `PYTHONUNBUFFERED=1` is forced, otherwise progress
  arrives in bursts when a buffer fills rather than when it happens.
- Cancel and timeout kill the WHOLE process tree. PyTorch dataloader workers are child
  processes; killing only the parent leaves them alive and holding VRAM (docs/05 C6).
"""

import os
import queue
import subprocess
import threading
import time
from collections import deque
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO

import psutil

TERMINATE_GRACE_S = 5.0
POLL_S = 0.2

_EOF = object()


@dataclass(frozen=True)
class RunResult:
    returncode: int | None
    cancelled: bool
    timed_out: bool
    tail: list[str] = field(default_factory=list)


def kill_tree(pid: int, grace_s: float = TERMINATE_GRACE_S) -> None:
    """Terminate a process and all its descendants; kill whatever outlives the grace period."""
    try:
        root = psutil.Process(pid)
        processes = [*root.children(recursive=True), root]
    except psutil.NoSuchProcess:
        return
    for process in processes:
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            continue
    _, alive = psutil.wait_procs(processes, timeout=grace_s)
    for process in alive:
        try:
            process.kill()
        except psutil.NoSuchProcess:
            continue
    psutil.wait_procs(alive, timeout=grace_s)


def _pump(stream: IO[str], lines: "queue.Queue[object]") -> None:
    for line in stream:
        lines.put(line.rstrip("\r\n"))
    lines.put(_EOF)


def _spawn(
    args: Sequence[str], env: Mapping[str, str] | None, cwd: Path | None
) -> "subprocess.Popen[str]":
    merged_env = {**os.environ, **(env or {}), "PYTHONUNBUFFERED": "1"}
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    return subprocess.Popen(  # noqa: S603 - args is a list from our own builders, no shell
        list(args),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        env=merged_env,
        cwd=cwd,
        creationflags=flags,
    )


def run_streaming(
    args: Sequence[str],
    on_line: Callable[[str], None],
    *,
    env: Mapping[str, str] | None = None,
    cwd: Path | None = None,
    cancel: threading.Event | None = None,
    timeout_s: float | None = None,
    tail_lines: int = 50,
) -> RunResult:
    """Run `args`, calling `on_line` for each output line, until exit, cancel or timeout."""
    process = _spawn(args, env, cwd)
    if process.stdout is None:
        raise RuntimeError("subprocess started without a stdout pipe")
    lines: queue.Queue[object] = queue.Queue()
    threading.Thread(target=_pump, args=(process.stdout, lines), daemon=True).start()

    tail: deque[str] = deque(maxlen=tail_lines)
    deadline = time.monotonic() + timeout_s if timeout_s is not None else None
    cancelled = timed_out = False

    while True:
        if cancel is not None and cancel.is_set():
            cancelled = True
            break
        if deadline is not None and time.monotonic() > deadline:
            timed_out = True
            break
        try:
            item = lines.get(timeout=POLL_S)
        except queue.Empty:
            continue
        if item is _EOF:
            break
        text = str(item)
        tail.append(text)
        on_line(text)

    if cancelled or timed_out:
        kill_tree(process.pid)
    returncode = process.wait()
    return RunResult(
        returncode=None if cancelled or timed_out else returncode,
        cancelled=cancelled,
        timed_out=timed_out,
        tail=list(tail),
    )
