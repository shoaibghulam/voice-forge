"""Analyse routes (docs/06 "Analyses"): lyrics and musical style of an uploaded song."""

import asyncio
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import FileResponse
from sqlalchemy import Engine

from app.config import Settings, get_settings
from app.deps import get_engine, require_csrf
from app.schemas.analysis import AnalysisCreate, AnalysisOut, AnalysisPatch
from app.services import analyses as service

router = APIRouter(
    prefix="/api/analyses", tags=["analyses"], dependencies=[Depends(require_csrf)]
)
EngineDep = Annotated[Engine, Depends(get_engine)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
MEDIA = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4"}


@router.post("", status_code=202)
async def create_analysis(
    body: AnalysisCreate, engine: EngineDep, settings: SettingsDep
) -> dict[str, AnalysisOut]:
    return {"data": await asyncio.to_thread(service.create_analysis, engine, settings, body)}


@router.get("")
async def list_analyses(engine: EngineDep) -> dict[str, list[AnalysisOut]]:
    return {"data": await asyncio.to_thread(service.list_analyses, engine)}


@router.get("/{analysis_id}")
async def get_analysis(analysis_id: str, engine: EngineDep) -> dict[str, AnalysisOut]:
    return {"data": await asyncio.to_thread(service.get_analysis, engine, analysis_id)}


@router.patch("/{analysis_id}")
async def update_analysis(
    analysis_id: str, body: AnalysisPatch, engine: EngineDep
) -> dict[str, AnalysisOut]:
    return {"data": await asyncio.to_thread(service.update_lyrics, engine, analysis_id, body)}


@router.get("/{analysis_id}/audio/{kind}")
async def analysis_audio(analysis_id: str, kind: str, engine: EngineDep) -> FileResponse:
    path = await asyncio.to_thread(service.audio_file, engine, analysis_id, kind)
    media = MEDIA.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(path, media_type=media, filename=f"{kind}{path.suffix}")


@router.get("/{analysis_id}/export")
async def export_analysis(
    analysis_id: str,
    engine: EngineDep,
    fmt: Annotated[Literal["txt", "json"], Query(alias="format")] = "txt",
) -> Response:
    body, media, disposition = await asyncio.to_thread(service.export, engine, analysis_id, fmt)
    return Response(body, media_type=media, headers={"Content-Disposition": disposition})
