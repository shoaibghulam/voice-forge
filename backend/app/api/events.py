"""GET /api/jobs/{job_id}/events — the live stream behind the training view.

Replays every stored event after `Last-Event-ID` (all of them when absent), then tails
new ones until the job reaches a terminal status and nothing is left to send. The
browser's EventSource reconnects on its own and sends Last-Event-ID, so a refresh or a
dropped connection redraws the full timeline with no gaps and no duplicates.
"""

import asyncio
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.sse import EventSourceResponse, ServerSentEvent
from sqlalchemy import Engine

from app.deps import get_engine
from app.services.job_events import (
    TERMINAL_STATUSES,
    EventEnvelope,
    events_after,
    job_status,
)

POLL_S = 0.3

router = APIRouter(prefix="/api/jobs", tags=["jobs"])


def _parse_last_event_id(value: str | None) -> int:
    if value is None or not value.strip().isdigit():
        return 0
    return int(value.strip())


def _to_sse(envelope: EventEnvelope) -> ServerSentEvent:
    return ServerSentEvent(data=envelope.body, event=envelope.type, id=str(envelope.seq))


async def existing_job(job_id: str, engine: Annotated[Engine, Depends(get_engine)]) -> str:
    """Runs before streaming starts, so a missing job is a plain 404, not a broken stream."""
    if await asyncio.to_thread(job_status, engine, job_id) is None:
        raise HTTPException(status_code=404, detail="job not found")
    return job_id


@router.get("/{job_id}/events", response_class=EventSourceResponse)
async def job_events(
    job_id: Annotated[str, Depends(existing_job)],
    engine: Annotated[Engine, Depends(get_engine)],
    last_event_id: Annotated[str | None, Header()] = None,
) -> AsyncIterator[ServerSentEvent]:
    after = _parse_last_event_id(last_event_id)
    replayed = False
    while True:
        batch = await asyncio.to_thread(events_after, engine, job_id, after)
        for envelope in batch:
            after = envelope.seq
            yield _to_sse(envelope)
        if batch:
            continue
        if not replayed:
            # Stored history is fully sent; everything after this is live. No id, so it
            # never becomes the browser's Last-Event-ID.
            replayed = True
            yield ServerSentEvent(data={}, event="replay.done")
        status = await asyncio.to_thread(job_status, engine, job_id)
        if status is None or status in TERMINAL_STATUSES:
            # one last read: events written between the empty batch and the status check
            for envelope in await asyncio.to_thread(events_after, engine, job_id, after):
                yield _to_sse(envelope)
            return
        await asyncio.sleep(POLL_S)
