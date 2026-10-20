"""Dataset routes: prepare, QC summary, clips (docs/06 "Dataset")."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy import Engine

from app.deps import get_engine, require_csrf
from app.schemas.jobs import JobOut
from app.schemas.pipeline import ClipOut, ClipVerdictBody, DatasetSummary, PrepareBody
from app.services import dataset as service

router = APIRouter(prefix="/api", tags=["dataset"], dependencies=[Depends(require_csrf)])
EngineDep = Annotated[Engine, Depends(get_engine)]


@router.post("/singers/{singer_id}/prepare", status_code=202)
async def prepare(singer_id: str, body: PrepareBody, engine: EngineDep) -> dict[str, JobOut]:
    return {"data": await asyncio.to_thread(service.prepare, engine, singer_id, body.preset)}


@router.get("/singers/{singer_id}/dataset")
async def dataset_summary(singer_id: str, engine: EngineDep) -> dict[str, DatasetSummary]:
    return {"data": await asyncio.to_thread(service.summary, engine, singer_id)}


@router.get("/singers/{singer_id}/clips")
async def list_clips(
    singer_id: str,
    engine: EngineDep,
    verdict: str | None = None,
    reason: str | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, list[ClipOut]]:
    rows = await asyncio.to_thread(
        service.list_clips, engine, singer_id, verdict, reason, limit, offset
    )
    return {"data": rows}


@router.patch("/clips/{clip_id}")
async def set_verdict(clip_id: str, body: ClipVerdictBody, engine: EngineDep) -> dict[str, ClipOut]:
    return {"data": await asyncio.to_thread(service.set_verdict, engine, clip_id, body.verdict)}


@router.get("/clips/{clip_id}/audio")
async def clip_audio(clip_id: str, engine: EngineDep) -> FileResponse:
    path = await asyncio.to_thread(service.clip_file, engine, clip_id)
    return FileResponse(path, media_type="audio/wav")
