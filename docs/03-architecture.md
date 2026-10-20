# 03 — Architecture

## Constraints that shape everything

- **One GPU, 6 GB.** Two GPU jobs at once will run out of memory. Every GPU stage goes
  through one queue, one at a time, each in its own subprocess so VRAM is fully freed.
- **Windows 11, native.** No Docker/WSL2: NVML cannot read GPU utilisation under WSL2,
  pinned memory is limited, and `/mnt/c` disk I/O is slow on GB-sized datasets.
- **Long jobs (30 min – several hours) on a laptop.** Must survive sleep, crash,
  browser close, and app restart.
- **Small team.** No broker, no Redis, no Postgres. SQLite in WAL mode is enough.

## Processes

```
                 Browser (React + Vite build)
                   │  REST (JSON)   SSE (events)   tus (uploads)
                   ▼
┌──────────────────────────────────────────────┐
│ api  — uvicorn + FastAPI  (venv: .venv-api)   │
│  • auth, singers, datasets, jobs, models      │
│  • tus upload router → validate → data/       │
│  • SSE: tails job_events table                │
│  • serves frontend static build               │
└───────────────┬──────────────────────────────┘
                │ SQLite (WAL): jobs, job_stages, job_events …
                │ data/ folder (audio, models)
┌───────────────▼──────────────────────────────┐
│ worker — job loop (venv: .venv-api)           │
│  • claims one queued job at a time (lease)    │
│  • runs each stage as a subprocess  ─────────────┐
│  • parses stdout + TensorBoard → job_events   │  │
│  • NVML sampler thread (1 Hz) → gpu.sample    │  │
└──────────────────────────────────────────────┘  │
                                                  ▼
                       engine subprocesses (venv: engine/.venv, Python 3.12)
                       • audio-separator  • Applio rvc/train/*.py, rvc/infer
                       • QC scripts (VAD, loudness, embeddings)
```

Only the **worker** touches the GPU. The API never imports torch.

Run both with a `Procfile` (honcho) during development; as two Windows services (NSSM)
or one `start.bat` for daily use.

### Why two virtual environments

Applio pins its own torch (cu128), numpy, librosa. The API needs modern FastAPI and
Pydantic. Sharing one environment means one side's upgrade breaks the other. The worker
calls `engine/.venv/Scripts/python.exe` by absolute path.

## Repository layout

```
music-trainer/
├── backend/
│   ├── app/
│   │   ├── main.py              FastAPI app factory, routers, static files
│   │   ├── config.py            settings from env (.env)
│   │   ├── db.py                engine, session, WAL pragmas
│   │   ├── models/              SQLAlchemy tables
│   │   ├── schemas/             Pydantic request/response + event union
│   │   ├── api/                 routers: auth, singers, uploads, jobs, models, covers, events
│   │   ├── services/            business logic (no FastAPI imports)
│   │   ├── security/            sessions, password hashing, path guards
│   │   └── worker/              (inside the package so it installs and type-checks with the app)
│   │       ├── loop.py          claim → run stages → release
│   │       ├── stages/          one module per stage (separate, qc, preprocess, extract, train, index, export, convert)
│   │       ├── runner.py        subprocess with process-tree kill, stdout streaming
│   │       ├── applio.py        typed argument builders for Applio's scripts
│   │       ├── parsers/         applio_stdout.py, tensorboard_tail.py
│   │       ├── gpu.py           NVML sampler + peak tracker
│   │       ├── benchmark.py     task 0.1 benchmark (python -m app.worker.benchmark)
│   │       └── events.py        write job_events (coalesced)
│   ├── engine_scripts/          small scripts run INSIDE the engine venv (separate.py, qc.py, convert.py)
│   ├── migrations/              Alembic
│   └── tests/
├── frontend/                    React + Vite app (see 07)
├── engine/                      Applio checkout at pinned commit + its venv (gitignored)
├── data/                        runtime data (gitignored, see below)
├── docs/
└── Procfile, start.bat, .env.example
```

## Data on disk

```
data/
├── app.db                       SQLite (WAL)
├── models_cache/                separator + RMVPE + ContentVec + pretrained weights
├── uploads/tmp/                 tus partial uploads
└── singers/<singer_id>/
    ├── songs/<song_id>.wav      canonical 44.1 kHz WAV of each upload (+ original kept)
    ├── stems/<song_id>/         lead.wav, dry.wav, clean.wav, instrumental.wav
    ├── clips/                   sliced, normalised clips used for training
    ├── qc/report.json           per-clip verdicts and stats
    └── runs/<run_id>/           Applio logs dir: G_*.pth, D_*.pth, events.*, model_<e>e_<s>s.pth, *.index, samples/
covers/<cover_id>/               input, stems, converted vocal, mix.wav, mix.mp3
```

Every path is built from server-generated UUIDs and checked to resolve inside `data/`.
The user's original filename is metadata only.

## Job model

A **job** is one pipeline run of a type (`prepare_dataset`, `train`, `convert`,
`benchmark`). It has ordered **stages**. Each stage:

1. Is idempotent: skips work whose verified output already exists (the notebook's
   "don't re-separate a song that already has a dry stem").
2. Verifies outputs by **content**, not exit code (Applio exits 0 after swallowed failures).
3. Writes a `job_stages` row: `pending → running → done | failed | skipped`, with timings.

| Job type | Stages |
|---|---|
| `prepare_dataset` | validate → separate (karaoke/vocal) → dereverb → denoise → slice → qc |
| `train` | preprocess → extract (f0 + embeddings) → train → index → export → samples |
| `convert` | separate → dereverb → convert → re-reverb → mix → encode |
| `benchmark` | measure VRAM/time for each model at candidate settings |

### Queue and leases

- One worker process. It claims the oldest `queued` job with an atomic `UPDATE … WHERE
  status='queued'` and sets `lease_until = now + 60 s`, renewed every 20 s.
- On start, any job with `status='running'` and an expired lease is put back to
  `queued` with `resume=true` → it restarts from its first stage that isn't `done`.
- Training resume is free: Applio's `train.py` resumes from the latest `G_*.pth`/`D_*.pth`.
  With saves every 5–10 epochs, a crash costs at most that many epochs.

### Cancellation (Windows)

- Subprocesses start with `CREATE_NEW_PROCESS_GROUP`.
- Cancel = `psutil` walk of the child tree → `terminate()` → wait 5 s → `kill()`.
  PyTorch dataloader children otherwise keep holding VRAM.
- Status becomes `cancelled`; checkpoints stay, so "Resume" is offered.

### Pause

Pause = cancel after the next checkpoint save, then resume later. Applio has no
in-process pause, and holding VRAM while paused would block the queue.

### Retry

- CUDA OOM (detected by stderr pattern) → retry the stage once with batch halved
  (training) or segment 128 (separation). Emit a `stage.retry` event with the reason.
- Bad data / missing files → fail fast with a hint. No blind retries.

## Progress capture

| Source | What it gives | How |
|---|---|---|
| Applio stdout | epoch, step, batch b/n, epoch duration, lowest loss | `asyncio` subprocess, `PYTHONUNBUFFERED=1`, regex parser |
| TensorBoard event files in run dir | `loss_avg_50/g/{mel,kl,fm,adv,total}`, `loss_avg_50/d/adv`, `grad_avg_50/norm_{g,d}`, audio at save epochs | `EventAccumulator` tailed every 5 s |
| Separator / QC scripts | files done / total | Our own scripts print JSON lines `{"progress":…}` |
| NVML | util %, VRAM used/total, temp, power, clock | `nvidia-ml-py`, 1 Hz thread |

Applio's `core.py` wraps steps in quiet runners, so the worker calls
`rvc/train/preprocess/preprocess.py`, `rvc/train/extract/extract.py`,
`rvc/train/train.py` and the index script **directly** with the argument lists `core.py`
builds. These signatures are pinned to the Applio commit and covered by a contract test.

## Live event flow

```
engine stdout / TB files / NVML
        │  parse + coalesce (GPU 1 Hz, steps ~2 s)
        ▼
job_events (seq autoincrement)  ← single writer: worker
        │  SSE endpoint polls WHERE job_id=? AND seq>? every 300 ms
        ▼
EventSource (browser) — id = seq; reconnect sends Last-Event-ID → exact replay
        ▼
TanStack Query cache (status, stages)  +  uPlot ring buffers (loss, GPU)
```

Old `gpu.sample` and `log.line` rows are pruned to a 1-in-10 sample when a job ends,
so replay of a finished job stays fast.

## Security

- **No login** (owner's decision, 2026-10-19): single user on their own laptop.
- Bind `127.0.0.1` only, so nothing else on the network can reach the API.
- Mutating requests require an `X-Requested-With: music-trainer` header. A web page on
  another site cannot set custom headers on a cross-origin request without a CORS
  preflight, which this API never approves — so a random site open in the browser
  cannot start or delete jobs on localhost.
- If the app is ever exposed beyond localhost, add login first (the `users`/`sessions`
  tables are already in the schema).
- Uploads: per-file cap (1 GB), per-batch cap, free-disk check before accepting, magic-byte
  sniff (`filetype`), `ffprobe` with timeout, transcode to canonical WAV.
- Subprocess arguments always passed as lists, never shell strings (the notebook's
  quoting bug with `(Vocals)` filenames disappears).
- No secrets needed for v1. `.env` holds paths and limits; `.env.example` documents them.

## Stack and versions (reported 2026-10-19, re-check at install)

**API venv (Python 3.12, managed by uv):** fastapi 0.146, pydantic 2.14, sqlalchemy 2.1,
alembic 1.20, tuspyserver 4.4, nvidia-ml-py 13.615, tensorboard 2.21 (reader only),
psutil, pwdlib[argon2], filetype, pytest, httpx. ffmpeg/ffprobe on PATH.

**Engine venv:** Applio at a pinned commit (3.7.x, Python 3.12, torch cu128),
audio-separator 0.47, silero-vad, pyloudnorm, chromaprint (`fpcalc`).

**Frontend:** react 19.3, vite 8.3, typescript (5.9 pinned unless TS 7 tooling works),
@tanstack/react-router 1.170, @tanstack/react-query 5.104, zustand 5, uplot 1.6,
motion 14, wavesurfer.js 8, tus-js-client 4.3, tailwindcss 4.3, Radix primitives,
vitest 5, @playwright/test 1.64, msw.

## Alternatives considered

| Choice | Rejected alternative | Reason |
|---|---|---|
| Custom worker | Celery | Not supported on Windows |
| Custom worker | arq / Dramatiq / RQ | Need Redis; RQ needs `fork` |
| Custom worker | Huey (SqliteHuey) | Viable fallback; stage resume, leases and process-tree kill are custom anyway |
| Custom worker | Temporal | Server to run, far too much for one GPU |
| SSE | WebSocket | Data flows one way; commands are REST; SSE reconnects and replays for free |
| SQLite | Postgres | One machine, few writers; WAL handles it |
| Native Windows | Docker + WSL2 | No NVML utilisation; slow cross-FS I/O; RAM overhead |
| tus | Plain multipart | Multi-GB batches must resume |

## Moving off the laptop later

The worker interface (claim job → run stages → write events) does not care where it
runs. A cloud worker would mount the same `data/` (or sync per job) and write to the
same database through a small API. Keep an optional `Dockerfile` on
`nvidia/cuda:12.x-cudnn-runtime-ubuntu24.04` for that day — not for v1.
