# Contributing to Voice Forge

Thanks for helping. These are the rules the codebase already follows — please keep to them.

## Setup

Follow [docs/INSTALL.md](docs/INSTALL.md). Read the design doc for the stage you are
changing first ([docs/README.md](docs/README.md) is the index); the docs are the source
of truth and should be updated in the same change.

## Workflow

1. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
2. **Write the test first**, watch it fail, then make it pass.
3. Run every check before opening a pull request — all must pass:

   ```bat
   cd backend
   .venv\Scripts\python.exe -m pytest -q
   .venv\Scripts\python.exe -m ruff check app tests
   .venv\Scripts\python.exe -m mypy app

   cd ..\frontend
   npm run typecheck
   npm test
   npm run build
   npm run test:e2e
   ```

4. Keep backend coverage at **80% or more**.
5. Open a pull request describing what changed, why, and how you tested it (include real
   GPU results when you touch a pipeline stage).

## Commit messages

[Conventional commits](https://www.conventionalcommits.org/):

```text
<type>: <description>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
Example: `fix: keep the lead vocal when de-reverb removes it`.

## Code rules

- **Two venvs, never one.** Nothing in `backend/` imports torch; GPU code lives in
  `backend/engine_scripts/` and runs in `engine/.venv`.
- **Only the worker touches the GPU, one job at a time.** Never run two GPU tasks at
  once, including in tests (tests use fake engine scripts).
- **Never trust an exit code from Applio** — check the files a stage should produce.
- **Applio arguments are positional.** Build them only in `app/worker/applio.py`;
  `tests/test_applio_commands.py` pins the order to the Applio commit.
- **Pick separator stems by label** from the returned paths, case-insensitively.
- Subprocess arguments are **lists**, never shell strings (song names contain spaces and brackets).
- Defaults must fit **6 GB VRAM**.
- Python: type hints everywhere, frozen dataclasses for records, ruff + mypy strict clean.
- Frontend: design tokens in CSS custom properties, animate only `transform` / `opacity`,
  respect `prefers-reduced-motion`, keep `:focus-visible` visible.
- Files around 200–400 lines (800 maximum), functions under ~50 lines, early returns
  over deep nesting. Handle every error explicitly.

## Secrets and data

- No secrets in tracked files — use `.env` (gitignored) and document new variables in
  `.env.example`.
- Never commit audio, models, the database or anything under `data/` or `engine/`.

## Versioning

[Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`. Bump the version in
`backend/pyproject.toml`, `backend/app/main.py` and `frontend/package.json` together,
and add an entry to [CHANGELOG.md](CHANGELOG.md).

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, the job's log
(Live view → Log) and your GPU model and VRAM.
