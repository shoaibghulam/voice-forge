# Music Trainer

Singing voice trainer and converter (FastAPI + React/Vite + Applio)

## What this is

A local web app: upload many songs of one singer, train an RVC voice model of that
singer (Applio engine), then upload any song and get it re-sung in the trained voice,
mixed over the original backing. Runs on one RTX 4050 Laptop (6 GB VRAM), Windows 11,
for the owner and a small team. "Working" means a full run — upload → clean → train →
convert — completes without a terminal, and every stage is visible live.

Design docs are the source of truth: `docs/README.md` (index), `docs/08-task-list.md`
(build order). Read the relevant doc before changing a stage.

## Commands

| Task | Command (from the directory shown) |
|------|---------|
| Backend install | `backend/`: `uv venv --python 3.12 .venv` then `uv pip install --python .venv/Scripts/python.exe -e ".[dev]"` |
| Backend tests | `backend/`: `.venv/Scripts/python.exe -m pytest -q` |
| Backend lint / types | `backend/`: `.venv/Scripts/python.exe -m ruff check app tests` · `.venv/Scripts/python.exe -m mypy app` |
| Frontend install | `frontend/`: `npm install` |
| Frontend dev / test / types / build | `frontend/`: `npm run dev` · `npm test` · `npm run typecheck` · `npm run build` |
| Engine venv (Applio + separator) | `engine/`: `uv venv --python 3.12 .venv` then `uv pip install --python .venv/Scripts/python.exe -r applio/requirements-engine.txt "audio-separator[gpu]" --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match` |
| Applio weights | `engine/applio/`: `../.venv/Scripts/python.exe core.py prerequisites --models --pretraineds-hifigan --exe` |
| GPU benchmark | `backend/`: `.venv/Scripts/python.exe -m app.worker.benchmark --songs ../data/inbox/<singer>` |

## Architecture

- **Two venvs, never one.** `backend/.venv` (API + worker, no torch) and `engine/.venv`
  (Applio's pinned torch cu128 + audio-separator). The worker calls the engine
  interpreter by absolute path. Installing Applio's requirements elsewhere has replaced
  CUDA torch with CPU torch before.
- **Only the worker touches the GPU, one job at a time**, each stage in its own
  subprocess (`app/worker/runner.py`) so VRAM is freed when it ends.
- `engine/applio/` is a checkout pinned at commit `5379cf2`; `engine/` and `data/` are
  gitignored local state.
- `backend/engine_scripts/` run inside the engine venv and talk to the worker in JSON
  lines on stdout.

## Constraints

- **Never trust an exit code from Applio** — verify the files a stage should produce.
- **Applio's script arguments are positional.** Build them only through
  `app/worker/applio.py`; `tests/test_applio_commands.py` pins the order to the commit.
  Upgrading Applio means re-checking `core.py`'s `run_*_script` functions.
- **Pick separator stems by label from the paths the separator returns**, case-insensitive
  (models disagree: `Vocals` vs `vocals`). Never scan a folder for "the newest file".
- Subprocess arguments are lists, never shell strings — song names contain `(`, `)`, spaces.
- Defaults must fit 6 GB: batch 4 (2 on OOM), `cache_data_in_gpu` off, fp16 separation,
  segment 256 (128 on OOM). Don't run two GPU things at once, including in tests.
- Windows-native only; no Docker/WSL2 (NVML utilisation is unavailable there).

## Conventions

Workspace-wide conventions live in the root `CLAUDE.md` one level up and apply here
too. This file overrides them where they conflict.

- Secrets go in `.env` (gitignored). Never in tracked files — a workspace hook
  blocks that, and it blocks for a reason. v1 has no secrets; `.env` holds paths only.
- Follow the existing code in this repo over any general style guide.
- Tests first; frozen dataclasses for records; ruff + mypy strict must stay clean.
