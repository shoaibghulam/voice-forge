"""Singers and songs routes (docs/06 "Singers and songs")."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy import Engine

from app.config import Settings, get_settings
from app.deps import get_engine, require_csrf
from app.schemas.library import SingerCreate, SingerOut, SingerUpdate, SongOut, SongUpdate
from app.services import singers as service

router = APIRouter(prefix="/api", tags=["singers"], dependencies=[Depends(require_csrf)])

EngineDep = Annotated[Engine, Depends(get_engine)]
SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.get("/singers")
async def list_singers(engine: EngineDep) -> dict[str, object]:
    rows = await asyncio.to_thread(service.list_singers, engine)
    return {"data": rows, "page": {"total": len(rows), "limit": len(rows), "offset": 0}}


@router.post("/singers", status_code=201)
async def create_singer(body: SingerCreate, engine: EngineDep) -> dict[str, SingerOut]:
    return {"data": await asyncio.to_thread(service.create_singer, engine, body)}


@router.get("/singers/{singer_id}")
async def get_singer(singer_id: str, engine: EngineDep) -> dict[str, SingerOut]:
    return {"data": await asyncio.to_thread(service.get_singer, engine, singer_id)}


@router.patch("/singers/{singer_id}")
async def update_singer(
    singer_id: str, body: SingerUpdate, engine: EngineDep
) -> dict[str, SingerOut]:
    return {"data": await asyncio.to_thread(service.update_singer, engine, singer_id, body)}


@router.delete("/singers/{singer_id}", status_code=204)
async def delete_singer(singer_id: str, engine: EngineDep, settings: SettingsDep) -> Response:
    await asyncio.to_thread(service.delete_singer, engine, settings, singer_id)
    return Response(status_code=204)


@router.get("/singers/{singer_id}/songs")
async def list_songs(singer_id: str, engine: EngineDep) -> dict[str, list[SongOut]]:
    return {"data": await asyncio.to_thread(service.list_songs, engine, singer_id)}


@router.patch("/songs/{song_id}")
async def update_song(song_id: str, body: SongUpdate, engine: EngineDep) -> dict[str, SongOut]:
    return {"data": await asyncio.to_thread(service.update_song_era, engine, song_id, body.era)}


@router.delete("/songs/{song_id}", status_code=204)
async def delete_song(song_id: str, engine: EngineDep, settings: SettingsDep) -> Response:
    await asyncio.to_thread(service.delete_song, engine, settings, song_id)
    return Response(status_code=204)
