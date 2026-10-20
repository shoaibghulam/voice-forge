# 04 — ML pipeline

Every stage from uploaded song to finished cover, with defaults sized for a
**6 GB RTX 4050 Laptop**. Numbers marked **[est.]** are not published anywhere and are
replaced by the results of benchmark task 0.1 before they become app defaults.
All defaults live in one config file (`backend/app/pipeline_defaults.toml`), not in code.

```
TRAINING                                                    CONVERSION
upload ─► validate ─► separate lead ─► de-echo ─► denoise   song ─► validate ─► separate lead + backing
                                              │                                  │
                                         slice + QC                       de-reverb lead
                                              │                                  │
                      preprocess ─► f0 + features ─► train ─► index      convert (RVC) ─► re-reverb
                                                       │                         │
                                          checkpoints + samples ─► export   mix over backing ─► WAV/MP3
```

## 1. Validate (CPU)

1. Server-generated UUID name; original filename kept as metadata.
2. Magic-byte sniff (`filetype`); reject non-audio.
3. `ffprobe -v error -show_format -show_streams -of json` with a 30 s timeout. Require an
   audio stream, duration 20 s – 20 min, known codec.
4. Transcode to canonical **44.1 kHz stereo 16-bit WAV** (separators expect 44.1k). Keep the original.
5. Fingerprint with Chromaprint (`fpcalc`). Same fingerprint as an existing song of this
   singer → mark as duplicate, ask the user.
6. Tag each song with **source era** (user picks: cassette / vinyl / studio / live / unknown).
   Used for balancing in §4.

## 2. Separate and clean (GPU, one model at a time over all songs)

Load a model once, run it over every song, unload, next model. Model load is the fixed
cost; this also keeps only one model in VRAM.

| Step | Default model | Keep stem | Notes |
|---|---|---|---|
| 2a Lead vocal | `bs_roformer_karaoke_frazer_becruily.ckpt` on the **full mix** | lead vocal | Removes chorus responses and harmonies — common in Balochi folk |
| 2b Bleed clean-up (optional, on by default for cassette) | `mel_band_roformer_kim_ft2_bleedless_unwa.ckpt` on 2a's output | vocals | Bleed hurts training more than lost fullness |
| 2c De-echo / de-reverb | `dereverb-echo_mel_band_roformer_sdr_13.4843_v2.ckpt` (tape/PA echo) or `dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt` | no-reverb | Run **before** denoise, else hiss is treated as reverb tail |
| 2d Denoise | `denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt` (normal) | dry | Aggressive variant only for clips failing the noise-floor check in §4 |

Separator settings (6 GB): `use_native_fp16=True`, `batch_size=1`, `segment_size=256`,
`overlap=2` for training data (speed), `4` for covers (quality). On OOM → segment 128 and
retry once. Never `use_torch_compile` on Windows. `chunk_duration` only for files > 10 min.
[est.] 2–4 min per 4-min song for the full chain.

**Pick stems by label**, never by "newest file" or substring: each model writes the kept
stem *and* what it removed. `separate.py` reads the model's two stem labels after loading
it, names outputs `<song>~<stem>.wav`, and reports them keyed by label. Labels observed
(case differs between models, so matching is case-insensitive):

| Model | Kept | Removed |
|---|---|---|
| `bs_roformer_karaoke_frazer_becruily` | `Vocals` | `Instrumental` (backing for covers) |
| `mel_band_roformer_kim_ft2_bleedless_unwa` | `vocals` | `other` |
| `dereverb-echo_mel_band_roformer_sdr_13.4843_v2` | `dry` | `No dry` |
| `denoise_mel_band_roformer_aufr33_sdr_27.9959` | `dry` | `other` (to confirm) |

The chain is a **preset** (`cassette`, `studio`, `live`). Task 2.4 A/B tests the order
(karaoke-first vs vocal-first) on real songs before the presets are frozen.

## 3. Slice (CPU)

- Silence-based slicing (Applio's Automatic: −42 dB threshold, 1.5 s minimum, 0.5 s max
  silence), with a **15 s cap** — long held notes otherwise make over-long clips.
- Drop clips under 1.5 s.

## 4. Quality control (CPU + small GPU models)

Every clip gets a verdict and a reason. The QC report is a screen (doc 07), and the user
can override any verdict by listening.

| Check | Rule (starting threshold, tuned in task 2.5) | Reason code |
|---|---|---|
| Voice activity | Silero VAD voiced frames < 50% → reject | `silence` |
| Clipping | > 0.1% of samples within 0.5 dB of full scale → reject | `clipping` |
| Instrument bleed | energy ratio of the separator's residual to the vocal stem over clip > −15 dB → reject | `bleed` |
| Noise floor | inter-phrase noise floor > −50 dBFS → send to aggressive denoise, re-check | `noisy` |
| Other singer | singer embedding per clip; HDBSCAN cluster; keep dominant cluster; reject cosine < threshold to its centroid | `other_singer` |
| Duplicate | embedding near-duplicate of an earlier clip (cosine > 0.98) → reject | `duplicate` |
| Tape wow | slow periodic drift (0.5–4 Hz) in F0 of sustained notes → warn | `wow_flutter` |

Then:

- **Loudness**: normalise each kept clip to −20 LUFS integrated, −1 dBTP ceiling (pyloudnorm).
  Do not stack Applio's `noisereduce` on top of RoFormer denoise.
- **Balance eras**: if one era exceeds 70% of minutes, warn; option to cap it. Mixing a
  1970s cassette with a 1990s studio record teaches the model the rooms.
- **Singer profile**: RMVPE over kept clips → median F0, 5th–95th percentile range. Stored
  with the dataset; used for auto-key in §9.
- **Gate**: < 5 min usable → cannot train. 5–10 min → warn and suggest more songs.
  Target 20–30 min. Diminishing returns past ~60 min.

Embedding model for "other singer": start with a speech ECAPA model (fast, available);
evaluate the singing-specific encoder from arXiv 2401.05064 in task 2.5. Validate the
threshold on ~50 hand-labelled clips — singer-ID models degrade on processed audio.

## 5. Preprocess and extract (GPU)

Called directly (not via `core.py`, which swallows output), with the same arguments
`core.py` builds:

| Setting | Default | Why |
|---|---|---|
| Sample rate | **40000** | Cassette has nothing above ~15 kHz; 48k only for wideband studio sources |
| Cut mode | Automatic, chunk 3.0 s, overlap 0.3 s | Proven in the notebook |
| f0 method | **rmvpe** | Best for singing; same in inference |
| Embedder | **contentvec** | Baseline; A/B `spin-v2` in task 2.6 |
| CPU cores | 4 | Laptop thermals |

**Verify, don't trust exit code:** `filelist.txt` must exist and be non-empty, `f0/` and
feature dirs must hold one file per clip. Empty file list = failed pitch extraction
(missing `rmvpe.pt`) — fail with that hint.

Prerequisites check (once, at install and before each run): `rmvpe.pt` > 100 MB,
ContentVec `pytorch_model.bin` > 100 MB, pretrained `f0G*.pth` / `f0D*.pth` > 10 MB.
A 404 leaves a small file behind; check sizes.

## 6. Train (GPU)

| Setting | Default for 6 GB | Notes |
|---|---|---|
| Vocoder | HiFi-GAN | Compatible with every client; RefineGAN A/B in task 2.6 |
| Pretrained | TITAN-Medium 40k (HiFi-GAN) | A/B Snowie v3.1 and Ov2Super on Balochi |
| Batch size | **4** | OOM → 2 automatically (one retry) |
| Gradient checkpointing | off; on after an OOM at batch 2 | Trades speed for memory |
| `cache_data_in_gpu` | **off** | Costs 2–4 GB |
| Precision | auto (bf16/fp16 — Ada supports bf16) | |
| Epochs | 100 max, early stop (§7) | Cassette/noisy data: best often 20–50 |
| Save every | **5 epochs**, keep all exported small models, keep last 2 `G_/D_` | Crash costs ≤ 5 epochs; disk stays bounded |
| `--save-every-weights` | on | Exported `.pth` at each save, so a cancel still leaves a usable voice |

[est.] Epoch time ~1–3 min for 15–30 min of audio at batch 4 → 100 epochs ≈ 2–5 h.
Laptop power limits throttle long runs; the dashboard shows temperature and clocks.

**Export check:** a usable voice is an exported `<name>_<e>e_<s>s.pth` (has `config` and
`weight` keys), not a `G_*.pth`. If none exists after an interrupted run, rebuild from the
newest `G_*.pth` with Applio's `extract_model`. Copy `assets/config_template.json` to
`assets/config.json` at install — without it, export fails silently via the CLI.

## 7. Checkpoint scoring and early stopping (ours — Applio's detector is not in train.py)

At every save epoch the worker, **on the CPU while training continues on the GPU**
(the GPU stays single-tenant):

1. Exports the TensorBoard audio sample (`gen/audio_*`) to Opus.
2. Every 10 epochs, runs a **probe conversion**: three fixed 10 s clips — one held-out clip
   of the target singer, one male and one female clip of other singers — through the
   exported checkpoint with fixed settings, `device=cpu`, 2 threads. [est.] 20–60 s.
3. Scores: singer-embedding cosine to the held-out target clips (similarity), F0 RMSE in
   cents vs the source (melody), and mel loss trend from TensorBoard.

Early stop when the 50-step mel loss has not improved by > 1% over 20 epochs **and**
similarity has not improved for two probes. The best-scoring checkpoint gets a
"recommended" badge — the user still chooses by ear (metrics don't track listeners well).

Early stop = the worker cancels `train.py` right after a save (doc 03 §Cancellation) and
moves on to indexing. Task 1.6 checks that CPU probes don't slow training by more than
~10% (dataloader contention); if they do, probes are deferred to after training.

## 8. Index and export (CPU/GPU)

- Index: Applio `index`, algorithm Auto (KMeans for large datasets).
- Bundle: chosen `.pth` + `.index` + `profile.json` (median F0, range, sample rate,
  vocoder, embedder, pretrained, epochs, Applio commit) into `<singer>_voice.zip`.
  Import accepts old notebook zips (no `profile.json` → profile computed on first use).

## 9. Conversion ("cover")

| Step | What | Default |
|---|---|---|
| 9a Separate | Karaoke model on the full mix → lead vocal + backing (instruments **and** backing vocals stay in backing) | `bs_roformer_karaoke_frazer_becruily.ckpt`, overlap 4 |
| 9b De-reverb lead | So the model converts a dry voice | same as §2c |
| 9c Auto key | `shift = 12 × round(log2(target_median / source_median))` — **octave only** by default so the vocal stays in key with the unshifted backing. User can add semitones; then the backing is pitch-shifted too (warned: quality cost) | |
| 9d Convert | Applio infer | `f0_method=rmvpe`, `index_rate=0.4`, `protect=0.4`, `volume_envelope=0.35`, `f0_autotune=off`, `split_audio=on`, `clean_audio=off`, `hop` default |
| 9e Re-reverb | Short algorithmic reverb sized to the song (light/medium/heavy, user choice, default light) | Do **not** reuse the removed reverb stem — it contains the original singer |
| 9f Mix | Match converted vocal loudness to the original lead (LUFS); vocal level control (default 1.0) | |
| 9g Master | −1 dBTP limiter; export WAV + MP3 320 kbps; tag "AI-converted" in metadata | |

User controls on the convert screen: checkpoint, pitch (octave toggle + fine semitones),
**timbre strength** (= `index_rate`, 0–1), **breath/consonant protection** (= `protect`),
vocal level, reverb amount. Everything else hidden under "Advanced".

[est.] 4-min song: 9a–9b ~1.5 min, 9d ~1–2 min, rest < 30 s.

## 10. Evaluation

- **Regression set**: 5 fixed songs per singer, converted with each new model version;
  similarity + F0 RMSE stored; a drop beyond 5% flags the run.
- **Blind A/B screen**: plays real vs converted clips unlabelled, records guesses.
  At ~50–60% correct the voice is done.
- UTMOS/SingMOS naturalness: optional, informational only — trained on Chinese/Japanese.

## 11. Optional fallback engine (phase 3)

Seed-VC singing (`seed-uvit-whisper-base`, 44.1 kHz) for an **instant preview** while
Applio trains, and for singers with too little clean audio. Settings: `--f0-condition True`,
30–50 diffusion steps, `--semi-tone-shift` from §9c. GPL-3.0 and archived — kept in its own
venv and directory, pinned commit, not distributed. Fit on 6 GB to be measured first.

## 12. Analyse pipeline (lyrics + music style)

Job type `analyze`, stages `separate → lyrics → style → sections`, each in its own engine
subprocess (GPU models never share VRAM). Folder `data/analyses/<id>/`. Each stage writes
its own part of the result into the `analyses` row as soon as it finishes, so the page fills
in live; every engine result is validated (`app/schemas/analysis.py`) before it is stored.

| Stage | What | Engine |
|---|---|---|
| separate | input → `song.wav` (44.1 kHz stereo); `mel_band_roformer_kim_ft2_bleedless_unwa` → `vocals.wav` + `accompaniment.wav`; Demucs `htdemucs_ft` (1 shift) on the accompaniment → `stems/accompaniment~{drums,bass,other,vocals}.wav` (its "vocals" = residue, counted as other). OOM → segment 128 once | `separate.py` |
| lyrics | faster-whisper `large-v3-turbo` float16 on the vocal stem. Sung regions come from the stem's level (0.1 s frames > −40 dBFS, gaps < 1.5 s bridged) passed as `clip_timestamps`: Whisper's speech VAD skipped a whole sung verse. Clean-up: music markers (موسیقی) and stock hallucinations dropped, word loops cut to two, Arabic letter variants unified (ي→ی, ك→ک), segment edges trimmed to audible singing. A region with no lyric is retried once in the other Arabic-script language (fa↔ur). CUDA failure → CPU int8, recorded as `device`/`fallback`. Instrumental (vocal stem silent) → empty lyrics, `note: no_singing` | `transcribe.py` |
| style | tempo: librosa beat track, confidence = share of frames agreeing with it (or double/half); key + scale: Krumhansl–Schmuckler on mean CQT chroma of the accompaniment (no Eastern scale name: not reliable from chroma); loudness: mean dBFS + integrated LUFS (ffmpeg ebur128, in the worker); stem energy shares; CLAP `laion/clap-htsat-unfused` zero-shot tags (≤ 12 ten-second windows, per-window softmax, mean) for instruments (accompaniment), genre and mood (full mix), top 3 each | `style.py` |
| sections | vocal activity on the vocal stem (> −45 dBFS); agglomerative segmentation of beat-synchronous chroma + MFCC (~1 per 24 s, 6–12), < 4 s merged; labels: no singing → intro / outro / instrumental; sung segments whose chroma repeats (top quarter, ≥ 0.8) and are at least median-loud → chorus, else verse; neighbours joined. CPU | `sections.py` |

**Language.** Whisper has no Balochi, and its language-ID head calls sung Balochi
"English" (0.6–0.86 on the first real song, even on vocal-only audio). So `auto` decodes up
to 60 s of the loudest singing in ur, fa and en and keeps the language with the best mean
token log-probability (first song: fa −0.21, ur −0.49, en −1.2 → Persian, share 0.94);
`language_probability` is that softmax share. Hint `bal` transcribes with Urdu and marks the
result `approximate`: a draft in Arabic script the user corrects in the app.

**First real run** (2026-10-19, 3:13 Balochi song, RTX 4050): separate 108 s, lyrics 16 s,
style 24 s, sections 8 s, 159 s wall; peak VRAM 2.8 GB (Whisper ~2.4 GB, separation ~1 GB).
Result: Persian-script lyrics in all four sung regions, 108 BPM (0.87), A# major (0.60),
−10.8 LUFS, stems vocals 49 % / other 45 % / drums 6 % / bass 0 %, tags dhol · rubab ·
banjo, genre pop ≈ Pakistani folk, mood happy; 7 sections verse / instrumental / chorus /
instrumental / verse / instrumental / chorus. Genre and mood are approximate (CLAP knows
little Balochi music).
