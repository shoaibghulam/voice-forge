"""System routes: GPU status, doctor checks, benchmark results."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends

from app.config import Settings, get_settings
from app.services import system as service

router = APIRouter(prefix="/api/system", tags=["system"])
SettingsDep = Annotated[Settings, Depends(get_settings)]


@router.get("/gpu")
async def gpu() -> dict[str, object]:
    return {"data": await asyncio.to_thread(service.gpu_status)}


@router.get("/doctor")
async def doctor(settings: SettingsDep) -> dict[str, object]:
    return {"data": await asyncio.to_thread(service.doctor, settings)}


@router.get("/benchmarks")
async def benchmarks(settings: SettingsDep) -> dict[str, object]:
    return {"data": await asyncio.to_thread(service.benchmarks, settings)}
