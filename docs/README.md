# Music Trainer — design docs

Train a singing-voice model from one singer's songs, then re-sing any song in that
singer's voice. Web app: **FastAPI** backend, **React + Vite** frontend, with a live
A→Z view of training. Runs locally on one **RTX 4050 Laptop (6 GB VRAM)**, Windows 11,
for one owner or a small team.

This replaces the deleted Colab notebook (`BalochiVoice_Colab.ipynb`), which used
Applio (RVC v2) and a three-stage RoFormer clean-up chain. Everything that notebook
learned the hard way is carried forward in [05-problems-and-solutions.md](05-problems-and-solutions.md).

| # | Doc | Read it for |
|---|---|---|
| 01 | [PRD](01-prd.md) | What we are building, for whom, and what "done" means |
| 02 | [Research findings](02-research-findings.md) | Engine comparison, separation models, sources (Oct 2026) |
| 03 | [Architecture](03-architecture.md) | Processes, storage, job queue, why each choice |
| 04 | [ML pipeline](04-ml-pipeline.md) | Every stage from upload to cover, with default settings for 6 GB |
| 05 | [Problems and solutions](05-problems-and-solutions.md) | Known failure modes and the fix for each |
| 06 | [API and events](06-api-and-events.md) | REST endpoints, SSE event schema, data model |
| 07 | [Frontend](07-frontend.md) | Screens, the live training view, animation rules |
| 08 | [Task list](08-task-list.md) | Build order, phases, acceptance checks |

## Decisions in one screen

| Decision | Choice | Why (details in 02/03) |
|---|---|---|
| Voice engine | **Applio 3.7.x (RVC v2)**, pinned commit | MIT, maintained, headless CLI, fits 6 GB, parseable progress, our proven pipeline |
| Fallback engine | Seed-VC singing (zero-shot preview) — phase 3, optional | Different failure profile; GPL-3.0 and archived, so isolated |
| Separation | `python-audio-separator` + RoFormer models | MIT, local, fp16, every model we need |
| Pitch / embedder | RMVPE / ContentVec | Best tested for singing; same method in training and inference |
| Runtime | **Native Windows**, two venvs (API, engine) | WSL2 has no NVML GPU utilisation; Applio ships for Windows |
| Job queue | Custom single GPU worker + SQLite (WAL) | Celery unsupported on Windows; one GPU means one job at a time |
| Live updates | Server-Sent Events from a `job_events` table | One-way stream, auto-reconnect, replay via `Last-Event-ID` |
| Uploads | tus resumable uploads | Multi-GB song batches survive refresh and network drops |
| Frontend | React 19, Vite, TanStack Router + Query, uPlot, Motion, wavesurfer.js, Tailwind | Fast streaming charts, no template look |

## Status (2026-10-19)

Built and running. Install and start: [INSTALL.md](INSTALL.md) (`start.bat`, then
http://127.0.0.1:8000/). Measured speeds: [benchmarks.md](benchmarks.md). Per-task status:
[08-task-list.md](08-task-list.md#status-2026-10-19).

- The whole pipeline has run end to end on the RTX 4050 through the real app
  (upload → prepare → train → cover), on synthetic speech.
- **Analyse tab** (lyrics + music style of any uploaded song) built and run on a real
  Balochi song on the GPU: docs/04 §12.
- Still needs **real Balochi songs**: tuning the clean-up order, the QC thresholds and
  the training defaults by listening (tasks 2.4–2.6, 4.3).
