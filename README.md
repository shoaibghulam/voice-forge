# Voice Forge

**Train a singer's AI voice, sing any song in that voice, and pull the lyrics and musical
style out of any track — all on your own GPU.**

![version](https://img.shields.io/badge/version-1.0.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-Windows%2011%20%2B%20NVIDIA-lightgrey)

Voice Forge is a local web app (FastAPI + React) built on the
[Applio](https://github.com/IAHispano/Applio) RVC v2 engine. It runs on a single
laptop GPU with 6 GB of VRAM, needs no cloud and no login, and shows every stage live
— from the first upload to the finished cover.

## What it does

| Feature | What you get |
|---|---|
| **Train a voice** | Upload many songs of one singer. The app separates the vocals from the music, cleans them (echo, reverb, noise, cassette hiss), checks the dataset and trains an RVC voice model with a live loss chart, ETA and audio samples every 5 epochs. Pause, resume, early stop. |
| **Make a cover** | Upload any song. The lead vocal is extracted, re-sung in the trained voice (pitch matched to the singer's range) and mixed back over the original music in stereo, at the original loudness. |
| **Analyse a song** | Upload any song and get **lyrics** with timestamps (Urdu, Persian, English; Balochi as an editable draft) and the **music style**: tempo, key and scale, instruments, genre and mood, and a timeline of verses, choruses and instrumental breaks. |

Voice training and covers work for **any language** — the model learns how the singer
sounds, not the words.

## Requirements

- Windows 11 with an NVIDIA GPU (6 GB VRAM or more; built on an RTX 4050 Laptop)
- NVIDIA driver 610+ (CUDA 12.8), Python 3.12, [uv](https://docs.astral.sh/uv/),
  Node.js 22+, Git, ffmpeg 7+
- About 15 GB of free disk for the engine and models

## Quick start

Full step-by-step guide: **[docs/INSTALL.md](docs/INSTALL.md)**. In short:

```bat
git clone https://github.com/shoaibghulam/voice-forge.git
cd voice-forge

rem 1. backend (API + GPU worker)
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
cd ..

rem 2. engine (Applio + vocal separation) - see docs/INSTALL.md step 4

rem 3. models, about 5.5 GB, once
cd backend
.venv\Scripts\python.exe -m app.worker.fetch_models
cd ..

rem 4. web app
cd frontend
npm install
npm run build
cd ..

rem 5. run
start.bat
```

`start.bat` migrates the database, starts the API and the GPU worker, and opens
**http://127.0.0.1:8000/**. Open **System** in the app: every check should be green.

## How to use it

1. **Singers → New singer**, then drop that singer's songs (full songs, with music).
2. **Prepare** the dataset and review it — at least 5 minutes of clean singing, 20–30 is better.
3. **Train** with the defaults; listen to the samples as checkpoints arrive.
4. **Voice:** pick the checkpoint you like best.
5. **New cover:** upload any song and download the mix, the converted vocal or the backing.
6. **Analyse:** upload any song to get its lyrics and music style.

Typical times on an RTX 4050 Laptop: preparing ≈ 0.9× song length, training ≈ 100 s per
epoch for 20 minutes of singing, a 4-minute cover ≈ 3 minutes, a song analysis ≈ 2.5 minutes.

## Project layout

```text
backend/          FastAPI API, SQLite, GPU job worker, pipeline stages, tests
backend/engine_scripts/   scripts that run inside the engine venv (separation, lyrics, style)
frontend/         React 19 + Vite web app, Vitest and Playwright tests
docs/             design docs: architecture, ML pipeline, API, frontend, task list
start.bat         one-click start
engine/, data/    local only (Applio checkout, models, your audio) - not in git
```

The design docs start at [docs/README.md](docs/README.md).

## Architecture in brief

- **Two Python environments:** `backend/.venv` (API + worker, no PyTorch) and
  `engine/.venv` (Applio's CUDA PyTorch + audio-separator + Whisper). They never mix.
- **One GPU job at a time.** The worker runs each stage in its own subprocess so VRAM is
  freed between stages; defaults are sized for 6 GB and retry smaller on out-of-memory.
- **Live view:** the browser follows every job through Server-Sent Events.
- **Local only:** the server listens on `127.0.0.1` and has no accounts.

## Development

| Task | Command |
|---|---|
| Backend tests | `backend\.venv\Scripts\python.exe -m pytest -q` (in `backend`) |
| Lint / types | `ruff check app tests` · `mypy app` (in `backend`) |
| Frontend dev server | `npm run dev` (in `frontend`) |
| Frontend demo without a GPU | `npm run dev:mock` |
| Frontend tests / types / E2E | `npm test` · `npm run typecheck` · `npm run test:e2e` |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the guidelines and [CHANGELOG.md](CHANGELOG.md)
for what changed in each version.

## Responsible use

Only train voices you have the right to use — your own, or a singer (or their estate)
who has agreed. The app asks you to record that consent when you create a singer. Do
not publish covers in someone's voice without permission, and label AI covers as AI.

## License

[MIT](LICENSE) © 2026 Shoaib Ghulam.

Third-party engines and model weights downloaded at install time (Applio, the
separation models, Whisper, CLAP, the RVC pretrained models) keep their own licenses.
