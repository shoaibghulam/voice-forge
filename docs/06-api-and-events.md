# 06 — API and events

Base path `/api`. JSON in and out. **No authentication** — single user, localhost only
(docs/03 "Security"). Mutating routes (POST/PATCH/DELETE) need header
`X-Requested-With: music-trainer`; without it they return 403 `missing_csrf_header`.

## Response envelope

```json
{ "data": { ... } }                       // success
{ "error": { "code": "dataset_too_small", "message": "Only 4.2 minutes of usable singing. Add songs to reach at least 5.", "details": {} } }
```

List endpoints return `{ "data": [...], "page": { "total": 42, "limit": 50, "offset": 0 } }`.
Error codes are stable strings; the UI maps them to help text.

## Endpoints

### Singers and songs

| Method | Path | Notes |
|---|---|---|
| GET | `/singers` | list with model count, usable minutes, last job status |
| POST | `/singers` | `{name, consent: {living_consent: bool, estate_permission: bool, notes}}` |
| GET / PATCH / DELETE | `/singers/{id}` | delete refuses while a job runs for this singer |
| GET | `/singers/{id}/songs` | uploaded songs, era tag, duration, status |
| PATCH | `/songs/{id}` | `{era}` |
| DELETE | `/songs/{id}` | removes stems and clips derived from it |
| POST/PATCH/HEAD | `/uploads/*` | tus protocol (tuspyserver router). Upload metadata: `singer_id`, `filename`, `era`, `purpose` (`dataset`\|`cover`\|`analysis`) |

### Dataset

| Method | Path | Notes |
|---|---|---|
| POST | `/singers/{id}/prepare` | `{preset: "cassette"\|"studio"\|"live"}` → 202 `{data: Job}`; 409 `singer_busy`, 422 `no_songs` |
| GET | `/singers/{id}/dataset` | `{usable_minutes, kept_clips, rejected_clips, rejected: {reason: n}, era_minutes, era_warning, gate, f0: {median_hz, p05_hz, p95_hz}, no_voice_songs}` |
| GET | `/singers/{id}/clips?verdict=keep\|reject&reason=&limit=&offset=` | `[{id, song_id, start_s, duration_s, verdict, reason, user_override, scores, audio_url}]` (`kept`/`rejected` accepted as aliases) |
| PATCH | `/clips/{id}` | `{verdict: "keep"\|"reject"}` user override → the clip |
| GET | `/clips/{id}/audio` | WAV (HTTP Range supported) |

### Training and models

| Method | Path | Notes |
|---|---|---|
| POST | `/singers/{id}/train` | `{epochs=100, batch_size=4, save_every=5, sample_rate=40000, vocoder="HiFi-GAN"}` → 202 `{data: {job, run}}`; 422 `dataset_too_small` / `dataset_not_prepared`, 409 `singer_busy` |
| GET | `/singers/{id}/runs` | `[Run]`, Run = `{id, singer_id, job_id, status, config, applio_commit, created_at, checkpoint_count}` |
| GET | `/runs/{id}` | Run |
| GET | `/runs/{id}/checkpoints` | `[{id, run_id, epoch, step, mel_loss, similarity, recommended, has_sample, sample_url, active, created_at}]` by epoch |
| POST | `/checkpoints/{id}/select` | makes it the singer's active voice → the Singer |
| GET | `/checkpoints/{id}/sample` | WAV sample of that checkpoint |
| GET | `/checkpoints/{id}/export` | zip: `.pth` + `.index` + `profile.json` |
| POST | `/singers/{id}/voices/import` | multipart field `file` (.zip, old notebook zips accepted) → 201 `{data: {run, checkpoint}}`; 422 `invalid_voice_zip` (zip-slip, missing .pth/.index, oversized) |

### Covers

| Method | Path | Notes |
|---|---|---|
| POST | `/covers` | `{upload_id, singer_id, checkpoint_id?, settings: {octave_auto=true, semitones=0, timbre_strength=0.4, protect=0.4, vocal_level=1.0, reverb="light"}}` → 202 `{data: Cover}`; 404 `upload_not_found`, 422 `no_voice_model`. May queue behind the same singer's training |
| GET | `/covers?singer_id=` / `/covers/{id}` | Cover = `{id, singer_id, checkpoint_id, job_id, status, settings, created_at, audio: {mix, mp3, vocal, backing, original}}` (URLs, null until ready) |
| GET | `/covers/{id}/audio/{mix\|mp3\|vocal\|backing\|original}` | file (HTTP Range supported) |

### Analyses

Job type `analyze`, stages (signal path): `separate`, `lyrics`, `style`, `sections`.

| Method | Path | Notes |
|---|---|---|
| POST | `/analyses` | `{upload_id, language: "auto"\|"bal"\|"ur"\|"fa"\|"en" = "auto"}` (upload purpose `analysis`, ≤ 20 min) → 202 `{data: Analysis}`; 404 `upload_not_found` |
| GET | `/analyses` / `/analyses/{id}` | newest first (max 200) / one; 404 `analysis_not_found` |
| PATCH | `/analyses/{id}` | `{lyrics_text: string ≤ 50,000 \| null}`: the user's corrected lyrics (`null` = back to the detected lines) |
| GET | `/analyses/{id}/audio/{original\|vocals\|accompaniment}` | file (Range supported); 404 `audio_missing` until written |
| GET | `/analyses/{id}/export?format=txt\|json` | download: lyrics (edited text if any, else detected lines, one per line) or the whole Analysis |

```
Analysis = {id, job_id, status, original_filename, created_at, language_hint, lyrics_text,
            audio: {original, vocals, accompaniment},            // URLs, null until written
            result: {duration_s,
              lyrics:   {language: bal|ur|fa|en|null, language_probability, approximate,
                         device: cuda|cpu, fallback, note: "no_singing"|null,
                         segments: [{start, end, text}]} | null,
              style:    {tempo_bpm, tempo_confidence, key: C..B, scale: major|minor,
                         key_confidence, loudness_dbfs, loudness_lufs,
                         instruments: {stems: {vocals, drums, bass, other: %},
                                       tags: [{label, score}]},
                         genre: [{label, score}], mood: [{label, score}]} | null,  // top 3
              sections: [{start, end, label: intro|verse|chorus|instrumental|outro,
                          has_vocals, vocal_share}] | null}}
```

Each part is `null` until its stage is done; a stored part that fails validation is served
as `null`. Job objects carry `analysis_id` for analyze jobs.

### Jobs

Job = `{id, type, singer_id, singer_name, label, run_id, cover_id, status, params, resume, error_code, created_at, started_at, finished_at, stages: [{name, position, status, started_at, finished_at, attempts, outputs}]}`.
Statuses: `queued`, `running`, `pausing`, `paused`, `cancelling`, `cancelled`, `failed`, `done`.

| Method | Path | Notes |
|---|---|---|
| GET | `/jobs?status=queued,running&singer_id=` | queue view (newest first, max 200) |
| GET | `/jobs/{id}` | Job |
| POST | `/jobs/{id}/cancel` | queued → `cancelled`; running → `cancelling` (worker kills the process tree) |
| POST | `/jobs/{id}/pause` | running → `pausing`; training stops at its next checkpoint → `paused`. 409 `job_not_running` |
| POST | `/jobs/{id}/resume` | failed/cancelled/paused → `queued`, unfinished stages reset; 409 `job_not_resumable` |
| GET | `/jobs/{id}/events` | **SSE stream** (below) |
| GET | `/jobs/{id}/logs?stage=train` | text/plain |

### System

| Method | Path | Notes |
|---|---|---|
| GET | `/system/gpu` | `{available, name, driver, mem_total_mb, mem_used_mb, temp_c, util}` |
| GET | `/system/doctor` | `{ok, checks: [{id, label, ok, detail, hint}]}` — engine python, Applio, config.json, RMVPE, ContentVec, pretrained, ffmpeg, disk, separation models, engine CUDA |
| GET | `/system/benchmarks` | `{measured_at, rows: [{stage, label, seconds, audio_seconds, rtf, peak_vram_mb, note}]}` from the newest `data/benchmarks/*` |

Non-`/api` GET paths serve the built web app (`frontend/dist`, SPA fallback).

## SSE stream

`GET /api/jobs/{id}/events` — `text/event-stream`, FastAPI `EventSourceResponse`.

- Each message: `id: <seq>`, `event: <type>`, `data: <json>`.
- On reconnect the browser sends `Last-Event-ID`; the server replays every event with
  `seq >` that id, then tails live. Opening with no id replays the whole job — this is how a
  page refresh redraws the full timeline and loss curves.
- After the stored history has been sent, one `replay.done` event (data `{}`, **no id**)
  marks the switch from replay to live.
- Keep-alive ping every 15 s. The stream closes after the job reaches a terminal status
  and every event is flushed.

### Event envelope (v1)

```json
{
  "v": 1,
  "seq": 18234,
  "job_id": "5f0c…",
  "ts": "2026-10-19T14:03:22.418Z",
  "type": "train.epoch",
  "stage": "train",
  "data": { }
}
```

### Event types

| type | data | Rate |
|---|---|---|
| `job.status` | `{status, error_code?, resume?}` | on change |
| `stage.started` | `{stage, index, total_stages}` | per stage |
| `stage.progress` | `{done, total, unit: "songs"\|"clips", item}` | ≤ 2/s |
| `stage.retry` | `{reason: "cuda_oom", change: {batch_size, checkpointing}}` | rare |
| `stage.completed` | `{stage, outputs, duration_s}` | per stage |
| `stage.skipped` | `{stage, reason: "already_done"}` | on resume |
| `stage.paused` | `{stage}` | on pause |
| `stage.failed` | `{stage, error_code, message, hint, duration_s}` | once |
| `train.step` | `{epoch, step, batch, num_batches}` | ≤ 0.5/s |
| `train.scalars` | `{step, mel, kl, fm, adv, g_total, d_adv, grad_g?, grad_d?}` (keys may be missing; never NaN) | every 50 steps, pulled each epoch |
| `train.epoch` | `{epoch, total_epochs, epoch_s, lowest: {value, epoch}}` | per epoch |
| `checkpoint.saved` | `{checkpoint_id, epoch, step, mel, has_sample, sample_url}` | per save |
| `checkpoint.scored` | `{checkpoint_id, epoch, similarity, recommended}` | after training |
| `qc.clip` | `{clips: [{song_id, path, start_s, duration_s, verdict, reason, scores}]}` | batches of ≤ 20 |
| `eta` | `{stage_eta_s, method: "seed"\|"count"\|"ema"}` | per epoch |
| `gpu.sample` | `{util, mem_used_mb, mem_total_mb, temp_c, power_w, clock_mhz}` (all but memory may be null; NVML gives no shared-memory figure) | ≤ 1/s |
| `log.lines` | `{lines: [..]}` — stdout and stderr merged, in order | batched: flushed every 0.5 s or 200 lines; never dropped |

Pydantic models in `backend/app/schemas/events.py` are a discriminated union on `type`;
TypeScript types in `frontend/src/api/events.ts` are generated from the OpenAPI schema
(`openapi-typescript`) so the two cannot drift.

### ETA

- Stages before training: `elapsed / done × remaining` once ≥ 3 items are done; before
  that, the benchmark's per-item estimate.
- Training: exponential moving average (α = 0.3) of `epoch_s` × remaining epochs.
- Job ETA: sum of stage ETAs, using benchmark estimates for stages not yet started.
- `method` tells the UI whether to show "about" (estimate) or a firm countdown.

## Data model (SQLite)

All ids are UUIDv7 text. Timestamps are ISO-8601 UTC text.

```
users(id, username UNIQUE, password_hash, created_at)
sessions(id, user_id, expires_at, created_at)

singers(id, name, consent_json, active_checkpoint_id NULL, f0_median_hz NULL,
        f0_p05_hz NULL, f0_p95_hz NULL, created_at, updated_at)
songs(id, singer_id, original_filename, stored_path, duration_s, codec, bitrate,
      era, fingerprint, status, created_at)
clips(id, singer_id, song_id, path, start_s, duration_s, verdict, reason,
      user_override BOOL, scores_json, created_at)

jobs(id, type, singer_id NULL, status, params_json, resume BOOL, lease_until NULL,
     worker_pid NULL, error_code NULL, created_at, started_at NULL, finished_at NULL)
job_stages(id, job_id, name, index, status, started_at NULL, finished_at NULL,
           attempts, outputs_json)
job_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id, ts, type, stage NULL,
           payload_json)           -- INDEX (job_id, seq)

runs(id, singer_id, job_id, config_json, applio_commit, status, created_at)
checkpoints(id, run_id, epoch, step, model_path, sample_path, mel_loss,
            similarity NULL, f0_rmse_cents NULL, recommended BOOL, created_at)

covers(id, singer_id, checkpoint_id, job_id, input_song_path, settings_json,
       mix_path NULL, mp3_path NULL, vocal_path NULL, backing_path NULL, created_at)
analyses(id, job_id NULL, original_filename, input_path, language_hint, result_json,
         lyrics_text NULL, created_at)          -- migration 0002
benchmarks(id, item, settings_json, peak_vram_mb, seconds, created_at)
```

Pragmas at connect: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON`.
