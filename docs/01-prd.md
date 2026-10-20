# 01 — Product requirements

## Problem

We had a working pipeline in a Colab notebook: clean a singer's songs, train an RVC
voice, convert a new song. It was lost, and it had three standing problems:

1. **Fragile.** Colab disconnects wiped work; Applio failed silently and still reported
   success; every run was manual cell-by-cell.
2. **Opaque.** Training was a wall of log text. No progress, no ETA, no way to hear a
   checkpoint before training ended.
3. **Two places.** Training on Colab, conversion on a laptop app, a zip carried between.

## Goal

One local web app where a user:

1. Creates a **singer**, uploads many full songs (with music).
2. Watches the whole pipeline run **live**, A→Z: upload → clean vocals → quality check →
   slice → pitch/feature extraction → training epochs → index → export — with
   animated stage progress, elapsed time and ETA, loss curves, GPU load, logs, and an
   audio sample at each checkpoint.
3. Picks the best checkpoint by ear.
4. Uploads any song and gets it back **re-sung in the trained singer's voice**, mixed
   over the original backing track.

## Users

- **Owner / small team** (1–5 people) on one machine or LAN. No public sign-up, no billing.
- Primary material: **Balochi folk singers**, often old cassette recordings, with
  ornamentation (vibrato, glissando) and chorus responses.

## Scope

### In (v1)

- Singer library: create, rename, delete; list trained models per singer.
- Resumable multi-file upload (MP3/WAV/FLAC/M4A/OGG/OPUS/AAC), up to ~2 GB per batch.
- Automatic clean-up chain: lead-vocal extraction, de-echo/de-reverb, denoise.
- **Dataset QC report**: minutes of usable singing, rejected clips with reason
  (silence, clipping, other singer, instrument bleed, duplicate), pitch range of the singer.
  User can listen to and override rejections.
- Training with live dashboard; pause/cancel/resume; survives app restart and crash.
- Checkpoint list with audio samples and A/B against the real voice.
- Conversion ("cover"): separate → convert vocal → remix; auto octave matching;
  a few user controls (pitch shift, timbre strength, vocal level).
- Export / import a voice as a zip (compatible with the old notebook's zips).
- One GPU job at a time, with a visible queue.

### Out (v1)

- Cloud GPUs, multi-GPU, public users, payments.
- Real-time (microphone) conversion.
- Text-to-singing, lyric editing, style conversion.
- Zero-shot conversion without training (planned phase 3, see 08).

## Requirements

### Functional

| ID | Requirement |
|---|---|
| F1 | Upload resumes after browser refresh or network drop |
| F2 | Every uploaded file is validated (type sniff, ffprobe) before use |
| F3 | Clean-up chain runs one model at a time over all songs; finished stems are reused on re-run |
| F4 | QC report shows usable minutes; training refuses to start under 5 min, warns under 10 |
| F5 | Live view updates within 2 s of the worker emitting an event |
| F6 | Reloading the page restores the full timeline (event replay), not just the current state |
| F7 | A checkpoint is saved at least every 10 epochs, each with a playable sample |
| F8 | Cancel stops all GPU processes within 10 s and frees VRAM |
| F9 | After crash/restart, a training job resumes from the last checkpoint |
| F10 | Conversion of a 4-minute song returns a mixed WAV and MP3 |
| F11 | Out-of-memory errors retry once automatically with a smaller batch |

### Non-functional

| Area | Target |
|---|---|
| Hardware | Must work on 6 GB VRAM, 16 GB RAM laptop |
| Training time | 20 min of clean vocals → usable model in ≤ 3 h (to be confirmed by benchmark 0.1) |
| Conversion time | 4-min song ≤ 5 min end to end (estimate; confirm in 0.1) |
| Reliability | No silent failure: every stage verifies its output files, not just exit codes |
| Security | Bind to 127.0.0.1 by default; session login; uploads stored under server-generated names |
| Tests | 80% backend coverage; Playwright E2E for upload → train (mocked GPU) → convert |

## Success measures

- **Blind listening test** (the notebook's method, kept): play a real recording and a
  converted clip, unlabelled, to someone who knows the voice. Target: they pick the
  real one no better than ~60% of the time.
- Zero "trained successfully but no model" outcomes.
- A full run needs no terminal.

## Ethics and rights

Carried from the notebook and shown in the app before first conversion:

- Get written consent from living singers and permission from a deceased singer's
  family or estate.
- The new song's composition and recording are protected even when the voice is not.
  Prefer traditional or estate-held compositions.
- Disclose synthetic content when publishing (e.g. YouTube's synthetic-content flag).
- Exports carry a metadata tag marking them as AI-converted.
