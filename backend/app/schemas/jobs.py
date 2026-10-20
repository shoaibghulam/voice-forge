"""Response models for jobs and their stages."""

from pydantic import BaseModel


class StageOut(BaseModel):
    name: str
    position: int
    status: str
    started_at: str | None
    finished_at: str | None
    attempts: int
    outputs: dict[str, object]


class JobOut(BaseModel):
    id: str
    type: str
    singer_id: str | None
    singer_name: str | None
    label: str
    run_id: str | None
    cover_id: str | None
    analysis_id: str | None = None
    status: str
    params: dict[str, object]
    resume: bool
    error_code: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None
    stages: list[StageOut]
