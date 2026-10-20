"""SQLAlchemy tables (docs/06 "Data model"). Importing this package registers them all."""

from app.models.analysis import Analysis
from app.models.auth import Session, User
from app.models.jobs import Job, JobEvent, JobStage
from app.models.library import Clip, Singer, Song
from app.models.training import Benchmark, Checkpoint, Cover, Run

__all__ = [
    "Analysis",
    "Benchmark",
    "Checkpoint",
    "Clip",
    "Cover",
    "Job",
    "JobEvent",
    "JobStage",
    "Run",
    "Session",
    "Singer",
    "Song",
    "User",
]
