# 08 — Task list

Build order. Each task lists what proves it is done. Tests come first for every code
task (TDD, 80% coverage floor). Phase 0 must finish before defaults in doc 04 are trusted.

## Status (2026-10-19)

| Phase | State |
|---|---|
| 0 Foundations | Done — benchmark (docs/benchmarks.md), skeleton, doctor (`/api/system/doctor`), stay-awake |
| 1 Backend core | Done — 1.2 reduced to localhost + header + Host check (owner dropped login) |
| 2 ML pipeline | Built and run end to end on the RTX 4050 through the real API + worker (upload → prepare → train → cover) on synthetic speech. **2.4, 2.5, 2.6 need real Balochi songs and listening** |
| 3 Frontend | Built (all screens, live run view); final contract alignment in progress |
| 4 Hardening | 4.1 security review done and fixed; 4.2 coverage 82%; 4.4 `start.bat` + docs/INSTALL.md; **4.3 needs real singers** |
| 5 Optional | Not started |
| 6 Analyse | Done: lyrics + music style tab (6.1–6.3), verified on a real song on the GPU (docs/04 §12); 6.4 needs more real songs |

Real-run findings fixed: detached ORM rows in `validate`, model downloads mid-job
(now `fetch_models` + one network retry), uvicorn keep-alive race (`--timeout-keep-alive 30`),
probe clips too narrow for scoring (now 3–15 s).

## Phase 0 — Foundations and measurement (week 1)

| ID | Task | Done when |
|---|---|---|
| 0.1 | **Benchmark on the 4050.** Install Applio (pinned 3.7.x commit) and audio-separator in `engine/.venv`. Measure peak VRAM (`torch.cuda.max_memory_allocated`) and wall time: each separation model at segment 256/128 × overlap 2/4 on three 4-min songs; Applio epoch time at batch 4 and 2 on 15 min of clips; inference on a 4-min vocal. Watch shared GPU memory | Table in `docs/benchmarks.md`; doc 04 [est.] values replaced |
| 0.2 | Repo skeleton: `backend/` (uv, Python 3.12), `frontend/` (Vite React TS), `Procfile`, `.env.example`, `.gitignore` (`data/`, `engine/`), `git init` | `uv run pytest` and `npm test` both run (empty) |
| 0.3 | Doctor: checks in doc 05 A3/A5/A6/A7, ffmpeg on PATH, disk free | `GET /api/system/doctor` all green on this machine; unit tests for each check |
| 0.4 | Sleep prevention while jobs run (`SetThreadExecutionState`) | Laptop stays awake through a 30-min dummy job |

## Phase 1 — Backend core (weeks 2–3)

| ID | Task | Done when |
|---|---|---|
| 1.1 | DB models + Alembic migration (doc 06 data model), WAL pragmas | Migration up/down tests pass |
| 1.2 | ~~Auth~~ dropped by owner (single user, own laptop). Kept: localhost bind + `X-Requested-With` check on mutations, error envelope | Mutation without header → 403; errors use the `{error}` envelope |
| 1.3 | Singers / songs CRUD + consent fields | API tests incl. delete-while-running refusal |
| 1.4 | tus uploads + validation pipeline (sniff, ffprobe, transcode, fingerprint, UUID paths) | Tests with good, corrupt, renamed-exe, huge, and path-traversal filenames |
| 1.5 | Worker: lease claim, stage runner, idempotent skip, resume after kill, process-tree cancel, OOM retry | Tests with a fake engine script that prints progress, sleeps, OOMs on demand, and is killed mid-stage |
| 1.6 | Applio adapters: typed argument builders for preprocess/extract/train/index/export; stdout parser; TensorBoard tail; output verification | Contract tests against recorded stdout + a tiny real run (2 epochs, 1 min of audio); CPU probe overhead measured (doc 04 §7) |
| 1.7 | Event writer (coalescing) + SSE endpoint with `Last-Event-ID` replay | Test: write 1,000 events, connect mid-way with an id, receive exactly the rest in order |
| 1.8 | NVML sampler incl. shared-memory reading | Emits `gpu.sample` at 1 Hz during a job |
| 1.9 | ETA calculator | Unit tests for count-based, EMA, and benchmark-seeded estimates |

## Phase 2 — ML pipeline (weeks 3–5)

| ID | Task | Done when |
|---|---|---|
| 2.1 | Separation stage: model-at-a-time over all songs, explicit output names, presets | 3 real songs → expected stems; re-run skips; OOM retry tested |
| 2.2 | Slicing with 15 s cap | Clip duration distribution in bounds |
| 2.3 | QC checks (VAD, clipping, bleed, noise floor, other singer, duplicate, wow) + loudness + era balance + F0 profile | Each rule unit-tested on synthetic audio; report JSON schema tested |
| 2.4 | **A/B the separation order** (karaoke-first vs vocal-first; bleedless vs fullness) on 5 real Balochi songs | Listening notes + chosen presets recorded in `docs/benchmarks.md` |
| 2.5 | Tune QC thresholds on ~50 hand-labelled clips; compare ECAPA vs singing encoder for "other singer" | Precision/recall per rule written down |
| 2.6 | Training A/B: TITAN vs Snowie pretrained; ContentVec vs SPIN-v2; HiFi-GAN vs RefineGAN — one singer, same data | Blind-test results; defaults chosen |
| 2.7 | Train job end-to-end with checkpoints every 5 epochs, samples, CPU probe scoring, early stop, export + profile.json | Full run on 20 min of a real singer; a valid voice zip produced; crash-and-resume tested by killing the worker mid-epoch |
| 2.8 | Convert job: separate → dereverb → auto-octave → convert → re-reverb → loudness match → master | 4-min song converted; output in key; WAV + MP3 with AI-converted tag |
| 2.9 | Voice import/export (incl. old notebook zips) | Round-trip test; old zip imports |

## Phase 3 — Frontend (weeks 4–7, overlaps phase 2)

| ID | Task | Done when |
|---|---|---|
| 3.1 | App shell: tokens, light/dark, router, query client, API client with envelope, generated types | Vitest + type check pass |
| 3.2 | Login, singers library, singer page tabs | Playwright: log in, create singer with consent |
| 3.3 | Upload screen with tus resume | E2E: refresh mid-upload, upload completes |
| 3.4 | Live run view: SignalPath, job bar, ETA, reel, epoch roll, LossChart (uPlot + ring buffer), GPU meters, checkpoint list, log, failure card | MSW replay of a recorded run renders correctly; refresh mid-run restores timeline; 60 fps during replay in Chrome performance panel |
| 3.5 | Dataset QC screen with listen + override | E2E override changes usable minutes |
| 3.6 | Voice screen: checkpoint timeline, A/B player, blind test, export | E2E: select checkpoint, export downloads |
| 3.7 | Cover screens: upload, controls, consent notice, synced players | E2E: convert (mocked) and play |
| 3.8 | Queue and system screens | Shows doctor and benchmark results |
| 3.9 | Accessibility + reduced motion pass | axe has no serious violations; reduced-motion screenshots |

## Phase 4 — Hardening (week 8)

| ID | Task | Done when |
|---|---|---|
| 4.1 | Security review (uploads, paths, auth, CSRF, LAN binding) with the security-reviewer agent | No CRITICAL/HIGH findings open |
| 4.2 | Coverage ≥ 80% backend, reducers/utilities in frontend | Coverage report |
| 4.3 | Real-world run: 2 singers end to end, from upload to published-quality cover | Blind test with someone who knows the voice; notes in `docs/benchmarks.md` |
| 4.4 | `start.bat`, install guide (`docs/INSTALL.md`), NVIDIA sysmem-fallback setting | Fresh Windows user account can install and run |

## Phase 5 — Optional

| ID | Task |
|---|---|
| 5.1 | Seed-VC zero-shot "instant preview" engine in its own venv (measure 6 GB fit first) |
| 5.2 | Re-evaluate YingMusic-SVC / SoulX-Singer-SVC / HQ-SVC as preview engines |
| 5.3 | Cloud worker (RunPod 4090) for long trainings, same job protocol |
| 5.4 | Per-era models and era blending |

## Phase 6 — Analyse (lyrics + music style)

User request: "add another tab where i upload music give me lyric and music style".

| ID | Task | Done when | Status |
|---|---|---|---|
| 6.1 | Engine: `transcribe.py` (faster-whisper large-v3-turbo, decoder-score language choice, own vocal regions), `style.py` (tempo, key, loudness, stems, CLAP tags), `sections.py`; Demucs 4-stem in `separate.py`; `fetch_models` pre-downloads Whisper, CLAP, htdemucs_ft | Real song analysed on the 4050 | Done |
| 6.2 | Backend: `analyses` table (migration 0002), upload purpose `analysis`, `/api/analyses`, `analyze` pipeline with validated stage-by-stage results, CPU fallback, doctor check | pytest + ruff + mypy clean, coverage ≥ 80 % | Done |
| 6.3 | Frontend: Analyse tab, new / list / result screens, live signal path, player + seek, lyric editor, style card, timeline; MSW mocks | Vitest + Playwright analyse flow | Done |
| 6.4 | Tune on more songs: language choice for Balochi, section labels, CLAP prompts | Listening notes | Needs real songs |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| 6 GB too tight for some separation models | Chain slower or lower quality | Benchmark 0.1 first; smaller segment; drop "big" models |
| Training on laptop is slow (2–5 h) | Long feedback loop | Early stopping; checkpoint samples; optional cloud worker (5.3) |
| Applio CLI/stdout changes | Integration breaks | Pinned commit + contract tests (1.6) |
| QC rejects good ornamented singing as "other singer" | Lost data | User override; tune on labelled clips (2.5) |
| Ornament fidelity limited by the field | Results lack vibrato/glissando detail | Set expectations in UI; choose source singers in the same tradition |
