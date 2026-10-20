# Install and run

For one Windows 11 laptop with an NVIDIA GPU (built and measured on an RTX 4050 Laptop,
6 GB). Everything runs locally; nothing is uploaded anywhere. No login: the app only
listens on `127.0.0.1`.

## 1. Prerequisites

| Tool | Version used | Check |
|---|---|---|
| NVIDIA driver | 610 or newer (CUDA 12.8 capable) | `nvidia-smi` |
| Python | 3.12 | `py -3.12 --version` |
| uv | 0.12+ | `uv --version` (install: `winget install astral-sh.uv`) |
| Node.js | 22+ | `node --version` |
| Git | any | `git --version` |
| ffmpeg + ffprobe | 7+ | `ffmpeg -version` (install: `winget install Gyan.FFmpeg`) |

Free disk: about **15 GB** for the engine, models and a first singer; more as you train.

**Recommended NVIDIA setting:** NVIDIA Control Panel → Manage 3D settings → Program
settings → add `engine\.venv\Scripts\python.exe` → *CUDA – Sysmem Fallback Policy* =
**Prefer No Sysmem Fallback**. Without it, a job that runs short of VRAM silently spills
into system RAM and becomes 5–10× slower instead of failing (docs/05 A11).

## 2. Get the code

```bat
git clone https://github.com/shoaibghulam/voice-forge.git
cd voice-forge
```

## 3. Backend (API + worker)

```bat
cd backend
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
.venv\Scripts\alembic.exe upgrade head
cd ..
```

## 4. Engine (Applio + vocal separation) — a separate environment on purpose

```bat
mkdir engine
git clone https://github.com/IAHispano/Applio.git engine\applio
git -C engine\applio checkout 5379cf261fa7d8085c3b077aa42dabca7c85310b
copy engine\applio\assets\config_template.json engine\applio\assets\config.json

cd engine
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r applio\requirements-engine.txt "audio-separator[gpu]" --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
cd applio
..\.venv\Scripts\python.exe core.py prerequisites --models --pretraineds-hifigan --exe
cd ..\..
```

Lyrics for the Analyse tab use faster-whisper, also in the ENGINE venv. Install it without
its CPU `onnxruntime` dependency: that package would overwrite the `onnxruntime-gpu` files
audio-separator uses (faster-whisper's VAD works with either):

```bat
uv pip install --python engine\.venv\Scripts\python.exe --no-deps faster-whisper==1.2.1 ctranslate2==4.8.3 av==19.0.1
```

CTranslate2 finds cuBLAS/cuDNN in the `nvidia-*` wheels and `torch\lib` already in the
engine venv; if CUDA still fails, lyrics run on the CPU (int8) and the result says so.

Never install Applio's requirements into `backend\.venv` — it has replaced CUDA PyTorch
with a CPU-only build before (docs/05 A6).

## 5. Models (about 5.5 GB, once)

```bat
cd backend
.venv\Scripts\python.exe -m app.worker.fetch_models
cd ..
```

This downloads the separation models (RoFormer + Demucs `htdemucs_ft`, ~3.3 GB) into
`data\models_cache\separator`, Whisper large-v3-turbo (~1.6 GB) into
`data\models_cache\whisper` and CLAP `laion/clap-htsat-unfused` (~0.6 GB) into
`data\models_cache\clap`, skipping what is already there. Jobs would otherwise download
models on first use, and a dropped connection would fail the job. The doctor (System
screen) checks all of them.

Upgrading an existing install: run `.venv\Scripts\python.exe -m alembic upgrade head` in
`backend\` once (adds the `analyses` table).

## 6. Frontend

```bat
cd frontend
npm install
npm run build
cd ..
```

## 7. Check and start

```bat
start.bat
```

It migrates the database, starts the API (which also serves the web app) and the GPU
worker in two windows, and opens **http://127.0.0.1:8000/**. Open **System** in the app:
every doctor check should be green. Close the two windows to stop.

Optional, to measure your own GPU (writes `data/benchmarks/`):

```bat
cd backend
.venv\Scripts\python.exe -m app.worker.benchmark --songs ..\data\inbox\<singer folder>
```

## Using it

1. **Singers → New singer.** Record the consent you have (living singer, estate).
2. **Songs:** drop full songs (with music). Mark each with its era (cassette, studio…).
3. **Prepare:** pick a preset (cassette for old tapes). Watch the live view; then review
   the **Dataset** tab — at least 5 minutes of usable singing, 20–30 is better.
4. **Train:** start with the defaults. Training can be paused and resumed; checkpoints
   arrive every 5 epochs with a sample to listen to.
5. **Voice:** listen, A/B, pick the checkpoint you like (★ is only a suggestion).
6. **New cover:** upload any song; you get the mix, the converted vocal and the backing.

Typical times on the RTX 4050 Laptop (docs/benchmarks.md): cleaning ≈ 0.9× song length,
training ≈ 100 s per epoch for 20 min of singing, a 4-minute cover ≈ 3 minutes.

## Development

| Task | Command |
|---|---|
| Backend tests | `backend\.venv\Scripts\python.exe -m pytest -q` (in `backend`) |
| Backend lint / types | `ruff check app tests` · `mypy app` (in `backend`, with the venv) |
| Frontend dev server (hot reload, proxies `/api` to :8000) | `npm run dev` (in `frontend`) |
| Frontend demo without a GPU | `npm run dev:mock` |
| Frontend tests / types / E2E | `npm test` · `npm run typecheck` · `npm run test:e2e` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| System page: *Engine sees the GPU* is red | Reinstall step 4; check `nvidia-smi` |
| *Separation models* is red | Run step 5 again |
| Job fails with `cuda_oom` | Close other GPU programs (games, browsers with video), then **Resume** |
| Training much slower than the times above | Laptop on battery or thermal throttling; plug in, set Windows power mode to Best performance; check the NVIDIA setting in step 1 |
| `frontend_not_built` at :8000 | Run step 6, or use `npm run dev` on :5173 |
| Port 8000 in use | Close the other program, or change the port in `start.bat` and `frontend/vite.config.ts` |
