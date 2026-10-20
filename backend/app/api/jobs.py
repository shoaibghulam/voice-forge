"""Job routes (docs/06 "Jobs"). The live stream is in app/api/events.py."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy import Engine

from app.deps import get_engine, require_csrf
from app.schemas.jobs import JobOut
from app.services import jobs as service

router = APIRouter(prefix="/api/jobs", tags=["jobs"], dependencies=[Depends(require_csrf)])

EngineDep = Annotated[Engine, Depends(get_engine)]


@router.get("")
async def list_jobs(
    engine: EngineDep,
    status: Annotated[str | None, Query(description="comma-separated statuses")] = None,
    singer_id: str | None = None,
) -> dict[str, list[JobOut]]:
    statuses = [s for s in (status or "").split(",") if s]
    return {"data": await asyncio.to_thread(service.list_jobs, engine, statuses, singer_id)}


@router.get("/{job_id}")
async def get_job(job_id: str, engine: EngineDep) -> dict[str, JobOut]:
    return {"data": await asyncio.to_thread(service.get_job, engine, job_id)}


@router.post("/{job_id}/cancel")
async def cancel_job(job_id: str, engine: EngineDep) -> dict[str, JobOut]:
    return {"data": await asyncio.to_thread(service.cancel, engine, job_id)}


@router.post("/{job_id}/pause")
async def pause_job(job_id: str, engine: EngineDep) -> dict[str, JobOut]:
    return {"data": await asyncio.to_thread(service.pause, engine, job_id)}


@router.post("/{job_id}/resume")
async def resume_job(job_id: str, engine: EngineDep) -> dict[str, JobOut]:
    return {"data": await asyncio.to_thread(service.resume, engine, job_id)}


@router.get("/{job_id}/logs", response_class=PlainTextResponse)
async def job_logs(job_id: str, engine: EngineDep, stage: str | None = None) -> str:
    return await asyncio.to_thread(service.logs, engine, job_id, stage)
