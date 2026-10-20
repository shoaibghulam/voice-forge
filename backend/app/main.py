"""Music Trainer — FastAPI entry point.

`create_app()` builds the application; tests call it and override dependencies.
`app` is the instance uvicorn serves: `uvicorn app.main:app`.
"""

from fastapi import FastAPI
from pydantic import BaseModel
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api import analyses, covers, dataset, events, jobs, singers, system, uploads, voices
from app.api.errors import install_error_handlers
from app.api.frontend import mount_frontend
from app.config import Settings, get_settings


class HealthResponse(BaseModel):
    """Shape of the health payload, declared so it appears in the OpenAPI schema."""

    status: str
    environment: str


async def health() -> HealthResponse:
    """Liveness probe. Deliberately does not touch the database.

    A health check that depends on downstream services turns one outage into a
    cascade of restarts.
    """
    settings: Settings = get_settings()
    return HealthResponse(status="ok", environment=settings.environment)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Build the app. Passing `settings` (tests do) also makes every route use them."""
    resolved = settings or get_settings()
    app = FastAPI(
        title="Music Trainer",
        description="Singing voice trainer and converter",
        version="1.0.0",
    )
    if settings is not None:
        app.dependency_overrides[get_settings] = lambda: settings
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=resolved.allowed_hosts)
    install_error_handlers(app)
    app.add_api_route("/health", health, response_model=HealthResponse, tags=["ops"])
    app.include_router(events.router)
    app.include_router(jobs.router)
    app.include_router(singers.router)
    app.include_router(dataset.router)
    app.include_router(voices.router)
    app.include_router(covers.router)
    app.include_router(analyses.router)
    app.include_router(system.router)
    app.include_router(uploads.build_router(resolved))
    mount_frontend(app, resolved.frontend_dist)  # last: catch-all for the web app
    return app


app = create_app()
