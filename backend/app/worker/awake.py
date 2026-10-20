"""Keep Windows from sleeping while a job runs (docs/05 C5, docs/08 task 0.4).

A laptop that sleeps mid-training loses the lease and the run stalls. While the worker
holds a job it asks Windows to stay awake (SetThreadExecutionState with
ES_SYSTEM_REQUIRED), and releases the request afterwards so normal power settings
apply again. The display may still turn off; only system sleep is prevented.
"""

import contextlib
import ctypes
import os
from collections.abc import Callable, Iterator

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001

Setter = Callable[[int], object]


def windows_setter() -> Setter | None:
    if os.name != "nt":
        return None
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function: Setter = kernel32.SetThreadExecutionState
    return function


@contextlib.contextmanager
def stay_awake(setter: Setter | None = None) -> Iterator[None]:
    """Hold the system awake for the duration of the block.

    The setter is called from the thread that runs the job: Windows ties the request
    to that thread.
    """
    if setter is None:
        yield
        return
    setter(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
    try:
        yield
    finally:
        setter(ES_CONTINUOUS)
