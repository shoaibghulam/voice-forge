"""FastAPI dependencies shared by routers. Tests override these through dependency_overrides."""

from functools import lru_cache

from fastapi import Request
from sqlalchemy import Engine

from app.api.errors import ApiError
from app.config import get_settings
from app.db import make_engine

CSRF_HEADER = "X-Requested-With"
CSRF_VALUE = "music-trainer"
MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def require_csrf(request: Request) -> None:
    """Mutations must carry X-Requested-With: music-trainer (docs/03 "Security").

    A page on another site cannot add a custom header to a cross-origin request without
    a CORS preflight, and this API approves none, so it cannot drive the app on localhost.
    """
    if request.method in MUTATING and request.headers.get(CSRF_HEADER) != CSRF_VALUE:
        raise ApiError(403, "missing_csrf_header", f"Send header {CSRF_HEADER}: {CSRF_VALUE}.")


@lru_cache
def get_engine() -> Engine:
    """One engine per process, pointed at DATA_DIR/app.db."""
    settings = get_settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    return make_engine(settings.database_url)
