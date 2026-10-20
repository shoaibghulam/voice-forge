"""Worker-side event writer: the only writer of the job_events table.

Two rates of data come out of a job. State changes (stage started/completed/failed,
checkpoint saved, epoch done) are always written. High-rate telemetry is throttled per
type so a fast loop cannot flood SQLite or the browser (docs/05 E5):

    gpu.sample      at most 1 per second
    train.step      at most 1 per 2 seconds
    stage.progress  at most 2 per second

Log lines are different: dropping them would hide the line that explains a failure,
so they are BATCHED into `log.lines` events of up to LOG_BATCH_MAX lines, flushed at
most every LOG_FLUSH_S and always on `flush()`.
"""

import time
from collections.abc import Callable

from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.models import JobEvent

THROTTLE_S: dict[str, float] = {
    "gpu.sample": 1.0,
    "train.step": 2.0,
    "stage.progress": 0.5,
}
LOG_FLUSH_S = 0.5
LOG_BATCH_MAX = 200


class EventWriter:
    def __init__(
        self, engine: Engine, job_id: str, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._engine = engine
        self._job_id = job_id
        self._clock = clock
        self._last_sent: dict[str, float] = {}
        self._log_buffer: list[str] = []
        self._log_stage: str | None = None
        self._log_flushed_at = clock()

    def emit(self, type_: str, data: dict[str, object], stage: str | None = None) -> bool:
        """Write one event; returns False when a throttled type was skipped."""
        interval = THROTTLE_S.get(type_)
        now = self._clock()
        if interval is not None:
            last = self._last_sent.get(type_)
            if last is not None and now - last < interval:
                return False
            self._last_sent[type_] = now
        self._write(type_, data, stage)
        return True

    def log(self, line: str, stage: str | None = None) -> None:
        if stage != self._log_stage and self._log_buffer:
            self.flush()
        self._log_stage = stage
        self._log_buffer.append(line)
        due = self._clock() - self._log_flushed_at >= LOG_FLUSH_S
        if due or len(self._log_buffer) >= LOG_BATCH_MAX:
            self.flush()

    def flush(self) -> None:
        self._log_flushed_at = self._clock()
        if not self._log_buffer:
            return
        lines, self._log_buffer = self._log_buffer, []
        self._write("log.lines", {"lines": lines}, self._log_stage)

    def _write(self, type_: str, data: dict[str, object], stage: str | None) -> None:
        with Session(self._engine) as session:
            session.add(JobEvent(job_id=self._job_id, type=type_, stage=stage, payload_json=data))
            session.commit()
