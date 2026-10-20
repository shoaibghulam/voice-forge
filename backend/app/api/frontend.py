"""Serve the built frontend (frontend/dist) from the API, so the app is one process
on one port: http://127.0.0.1:8000/.

Registered LAST, after every /api router: any GET that no API route claimed gets either
a real file from dist/ (assets) or index.html, so deep links like /singers/<id> load
the single-page app, whose router takes over. Unknown /api/* paths stay JSON 404s.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

from app.api.errors import ApiError


def mount_frontend(app: FastAPI, dist: Path) -> None:
    root = dist.resolve()

    async def serve(path: str = "") -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise ApiError(404, "not_found", "No such API route.")
        index = root / "index.html"
        if not index.is_file():
            raise ApiError(
                404,
                "frontend_not_built",
                "The web app is not built yet: run `npm run build` "
                "in frontend/ (or use `npm run dev` on port 5173).",
            )
        candidate = (root / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(root):
            return FileResponse(candidate)
        return FileResponse(index, headers={"Cache-Control": "no-cache"})

    app.add_api_route("/", serve, methods=["GET"], include_in_schema=False)
    app.add_api_route("/{path:path}", serve, methods=["GET"], include_in_schema=False)
