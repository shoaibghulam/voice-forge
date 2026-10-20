"""The worker's main loop: recover, claim, run, repeat. One job at a time, one GPU.

    cd backend
    .venv/Scripts/python.exe -m app.worker.loop

While a job runs, a Heartbeat thread renews its lease and watches for the user's
cancel request. The stage functions see that request as `ctx.cancel` and pass it to
`run_streaming`, which kills the engine subprocess tree (docs/03 "Cancellation").
"""

import logging
import os
import threading
from types import TracebackType

from sqlalchemy import Engine

from app.db import utc_now
from app.worker.awake import stay_awake, windows_setter
from app.worker.events import EventWriter
from app.worker.job_queue import claim_next, job_status, renew_lease, requeue_expired
from app.worker.stage_runner import Pipeline, run_job

LEASE_S = 60.0
HEARTBEAT_S = 20.0
IDLE_POLL_S = 2.0

log = logging.getLogger("worker")


class Heartbeat:
    """Renew the job's lease and translate a cancel request into `cancel.set()`."""

    def __init__(
        self,
        engine: Engine,
        job_id: str,
        cancel: threading.Event,
        pause: threading.Event | None = None,
        interval_s: float = HEARTBEAT_S,
        lease_s: float = LEASE_S,
    ) -> None:
        self._engine = engine
        self._job_id = job_id
        self._cancel = cancel
        self._pause = pause or threading.Event()
        self._interval_s = interval_s
        self._lease_s = lease_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="heartbeat", daemon=True)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval_s * 2 + 1)

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                renew_lease(self._engine, self._job_id, now=utc_now(), lease_s=self._lease_s)
                status = job_status(self._engine, self._job_id)
                if status == "cancelling":
                    self._cancel.set()
                elif status == "pausing":
                    self._pause.set()
            except Exception:
                # a locked or briefly unavailable database must not kill the heartbeat;
                # the lease is long enough to survive a missed beat
                log.exception("heartbeat failed for job %s", self._job_id)
            self._stop.wait(self._interval_s)


def recover(engine: Engine) -> list[str]:
    """On start: put back any job whose previous worker died mid-run."""
    recovered = requeue_expired(engine, now=utc_now())
    for job_id in recovered:
        log.warning("recovered job %s from a dead worker; it will resume", job_id)
    return recovered


def run_once(engine: Engine, pipeline: Pipeline, heartbeat_s: float = HEARTBEAT_S) -> str | None:
    """Claim and run one job; None when the queue is empty."""
    job_id = claim_next(engine, worker_pid=os.getpid(), now=utc_now(), lease_s=LEASE_S)
    if job_id is None:
        return None
    cancel, pause = threading.Event(), threading.Event()
    events = EventWriter(engine, job_id)
    with (
        stay_awake(windows_setter()),
        Heartbeat(engine, job_id, cancel, pause=pause, interval_s=heartbeat_s),
    ):
        status = run_job(engine, job_id, pipeline, events, cancel, pause)
    log.info("job %s finished: %s", job_id, status)
    return job_id


def tick(engine: Engine, pipeline: Pipeline) -> str | None:
    """One pass of the loop: recover abandoned jobs, then run the next one.

    Recovery runs on every pass, not just at startup: when a worker is restarted while
    a job runs, the old lease is still valid at startup and only expires a minute later.
    """
    recover(engine)
    return run_once(engine, pipeline)


def run_forever(engine: Engine, pipeline: Pipeline, stop: threading.Event) -> None:
    while not stop.is_set():
        if tick(engine, pipeline) is None:
            stop.wait(IDLE_POLL_S)


def main() -> None:
    from app.deps import get_engine
    from app.worker.pipelines import PIPELINES

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    log.info("worker started, pid %s", os.getpid())
    try:
        run_forever(get_engine(), PIPELINES, threading.Event())
    except KeyboardInterrupt:
        log.info("worker stopped")


if __name__ == "__main__":
    main()
