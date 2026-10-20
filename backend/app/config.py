"""Application settings.

Every value comes from the environment, never from a literal in source. Add each new
variable to `.env.example` at the same time you add it here, or onboarding silently
breaks for the next person.
"""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Environment-backed configuration."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Music Trainer"
    environment: str = "development"
    debug: bool = False

    # Paths default to the project layout (docs/03); override in .env if moved.
    data_dir: Path = PROJECT_ROOT / "data"
    applio_root: Path = PROJECT_ROOT / "engine" / "applio"
    engine_python: Path = PROJECT_ROOT / "engine" / ".venv" / "Scripts" / "python.exe"
    engine_scripts_dir: Path = PROJECT_ROOT / "backend" / "engine_scripts"
    max_upload_mb: int = 1024
    frontend_dist: Path = PROJECT_ROOT / "frontend" / "dist"
    # Host header allow-list: blocks DNS-rebinding pages (docs/03 "Security").
    allowed_hosts: list[str] = ["127.0.0.1", "localhost"]

    @property
    def separator_models_dir(self) -> Path:
        return self.data_dir / "models_cache" / "separator"

    @property
    def whisper_models_dir(self) -> Path:
        return self.data_dir / "models_cache" / "whisper"

    @property
    def clap_models_dir(self) -> Path:
        return self.data_dir / "models_cache" / "clap"

    @property
    def database_url(self) -> str:
        return f"sqlite:///{(self.data_dir / 'app.db').as_posix()}"


@lru_cache
def get_settings() -> Settings:
    """Cached accessor so settings are parsed once per process."""
    return Settings()
