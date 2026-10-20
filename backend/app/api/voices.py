"""Training, runs, checkpoints, voice import/export (docs/06 "Training and models")."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, UploadFile
from fastapi.responses import FileResponse, Response
from sqlalchemy import Engine

from app.api.errors import ApiError
from app.config import Settings, get_settings
from app.deps import get_engine, require_csrf
from app.schemas.library import SingerOut
from app.schemas.pipeline import CheckpointOut, ImportedVoice, RunOut, TrainBody, TrainStarted
from app.services import voices as service

router = APIRouter(prefix="/api", tags=["voices"], dependencies=[Depends(require_csrf)])
EngineDep = Annotated[Engine, Depends(get_engine)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
MAX_ZIP_BYTES = 1024 * 2**20


@router.post("/singers/{singer_id}/train", status_code=202)
async def train(singer_id: str, body: TrainBody, engine: EngineDep) -> dict[str, TrainStarted]:
    return {"data": await asyncio.to_thread(service.start_training, engine, singer_id, body)}


@router.get("/singers/{singer_id}/runs")
async def list_runs(singer_id: str, engine: EngineDep) -> dict[str, list[RunOut]]:
    return {"data": await asyncio.to_thread(service.list_runs, engine, singer_id)}


@router.get("/runs/{run_id}")
async def get_run(run_id: str, engine: EngineDep) -> dict[str, RunOut]:
    return {"data": await asyncio.to_thread(service.get_run, engine, run_id)}


@router.get("/runs/{run_id}/checkpoints")
async def list_checkpoints(run_id: str, engine: EngineDep) -> dict[str, list[CheckpointOut]]:
    return {"data": await asyncio.to_thread(service.list_checkpoints, engine, run_id)}


@router.post("/checkpoints/{checkpoint_id}/select")
async def select_checkpoint(checkpoint_id: str, engine: EngineDep) -> dict[str, SingerOut]:
    return {"data": await asyncio.to_thread(service.select_checkpoint, engine, checkpoint_id)}


@router.get("/checkpoints/{checkpoint_id}/sample")
async def checkpoint_sample(checkpoint_id: str, engine: EngineDep) -> FileResponse:
    path = await asyncio.to_thread(service.sample_file, engine, checkpoint_id)
    return FileResponse(path, media_type="audio/wav")


@router.get("/checkpoints/{checkpoint_id}/export")
async def export_voice(checkpoint_id: str, engine: EngineDep) -> Response:
    data, filename = await asyncio.to_thread(service.export_zip, engine, checkpoint_id)
    headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
    return Response(data, media_type="application/zip", headers=headers)


@router.post("/singers/{singer_id}/voices/import", status_code=201)
async def import_voice(
    singer_id: str, file: UploadFile, engine: EngineDep, settings: SettingsDep
) -> dict[str, ImportedVoice]:
    data = await file.read(MAX_ZIP_BYTES + 1)
    if len(data) > MAX_ZIP_BYTES:
        raise ApiError(413, "file_too_large", "Voice zips over 1 GB are refused.")
    result = await asyncio.to_thread(service.import_zip, engine, settings, singer_id, data)
    return {"data": result}
