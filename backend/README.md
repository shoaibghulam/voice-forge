# Music Trainer

Singing voice trainer and converter

FastAPI + Pydantic v2, scaffolded 2026-10-19.

## Setup

```bash
python -m venv .venv
.venv\Scripts\activate        # Windows
# source .venv/bin/activate   # macOS / Linux
pip install -e ".[dev]"
```

## Commands

| Task | Command |
|------|---------|
| Dev server | `uvicorn app.main:app --reload` |
| Test | `pytest` |
| Lint | `ruff check .` |
| Format | `ruff format .` |
| Typecheck | `mypy app` |

Interactive API docs run at `http://127.0.0.1:8000/docs`.

## Layout

```
app/
  main.py     route definitions
  config.py   env-backed settings (Pydantic Settings)
tests/
  test_health.py
```

## Conventions

- **Config comes from the environment.** Add each variable to `Settings` *and* to
  `.env.example` in the same change.
- **`/health` stays dependency-free.** A health check that pings the database turns
  one outage into a restart cascade.
- **mypy runs strict.** Annotate as you go; retrofitting types is far more work.
