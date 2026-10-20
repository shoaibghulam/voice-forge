"""Cover routes (docs/06 "Covers")."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy import Engine

from app.config import Settings, get_settings
from app.deps import get_engine, require_csrf
from app.schemas.pipeline import CoverCreate, CoverOut
from app.services import covers as service

router = APIRouter(prefix="/api/covers", tags=["covers"], dependencies=[Depends(require_csrf)])
EngineDep = Annotated[Engine, Depends(get_engine)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
MEDIA = {"mp3": "audio/mpeg"}


@router.post("", status_code=202)
async def create_cover(
    body: CoverCreate, engine: EngineDep, settings: SettingsDep
) -> dict[str, CoverOut]:
    return {"data": await asyncio.to_thread(service.create_cover, engine, settings, body)}


@router.get("")
async def list_covers(engine: EngineDep, singer_id: str | None = None) -> dict[str, list[CoverOut]]:
    return {"data": await asyncio.to_thread(service.list_covers, engine, singer_id)}


@router.get("/{cover_id}")
async def get_cover(cover_id: str, engine: EngineDep) -> dict[str, CoverOut]:
    return {"data": await asyncio.to_thread(service.get_cover, engine, cover_id)}


@router.get("/{cover_id}/audio/{kind}")
async def cover_audio(cover_id: str, kind: str, engine: EngineDep) -> FileResponse:
    path = await asyncio.to_thread(service.audio_file, engine, cover_id, kind)
    media = MEDIA.get(kind, "audio/wav" if path.suffix == ".wav" else "application/octet-stream")
    return FileResponse(path, media_type=media, filename=f"{kind}{path.suffix}")
