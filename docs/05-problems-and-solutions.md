# 05 — Problems and solutions

Every known way this pipeline fails, and how the system prevents or fixes it. Sources:
the old notebook (each item was hit in practice), Applio source, RVC FAQ, separator
docs, SVCC reports. Each row names the stage that owns the fix and the test that
proves it (task IDs in doc 08).

## A. Silent failures (the notebook's worst class)

| # | Problem | Cause | Solution in the system |
|---|---|---|---|
| A1 | "Trained successfully" but no model | Applio's `core.py` catches worker errors and exits 0 | Worker calls Applio scripts directly and **verifies output files** after every stage; exit code is never proof |
| A2 | Training exits in seconds | Empty `filelist.txt` because pitch extraction wrote nothing (missing `rmvpe.pt`) | Prerequisite size check (> 100 MB) before any run; after extract, assert file list non-empty and one f0 file per clip |
| A3 | Downloaded weights "present" but broken | A 404 or truncated download leaves a small file | Check minimum sizes for rmvpe, ContentVec, pretrained G/D; re-download on failure |
| A4 | Checkpoints but no usable voice | `G_*.pth` has optimiser state, not `config`/`weight`; export skipped on interruption | `--save-every-weights`; on finish/cancel, rebuild export from newest `G_*.pth` with Applio's `extract_model`; a voice is valid only if `config` and `weight` keys load |
| A5 | Export raises, error swallowed | `assets/config.json` only created by Applio's GUI | Installer copies `config_template.json` → `config.json`; doctor check verifies it |
| A6 | Training silently on CPU | Installing Applio requirements replaced CUDA torch with CPU torch | Separate engine venv built by Applio's own installer (cu128); doctor asserts `torch.cuda.is_available()` and device name before every GPU job |
| A7 | `ModuleNotFoundError` in extraction | Skipping packages by `torch*` prefix dropped `torchcrepe`, `torchfcpe` | Never filter Applio's requirements; doctor imports every module Applio needs |
| A8 | Separator output not found / wrong stem used | Stem names accumulate (`_(Vocals)_(noreverb)_(other)`); "newest file" picks the removed noise | Pass explicit `output_names` per stage; select by exact expected path |
| A9 | Commands break on song names | `(Vocals)` and spaces are shell syntax | No shell strings: every subprocess gets an argument list |
| A10 | Flags parsed as stray arguments | `--pretrained true` where Applio expects a bare flag | One typed builder per Applio command, covered by a contract test against the pinned commit |
| A11 | Windows VRAM spill makes runs 5–10× slower, no error | NVIDIA driver falls back to shared system memory | Show dedicated vs shared GPU memory; warn when shared rises during a job; setup guide: disable "CUDA – Sysmem Fallback Policy" for the engine Python |
| A12 | Fourth separation step fails with "No such file or directory" | **Found in the first benchmark run.** The separator appends `_(Stem)_<model>` at every step; four steps down the chain the path passes Windows' 260-char limit | `separate.py` names every output `<song>~<stem>.wav` via `custom_output_names` (not `__`: the separator collapses underscores); the song part is reused, so names never grow |
| A13 | Peak VRAM recorded as 0 MB; GPU panel freezes | **Found in the first benchmark run.** NVML on the 4050 Laptop intermittently returns "Unknown Error" for utilisation under load; the exception killed the sampler thread | Memory is read strictly; utilisation, temperature, power and clock are best-effort (`None`); the sampler counts failed reads and keeps going |

## B. Data quality

| # | Problem | Solution |
|---|---|---|
| B1 | Model learns the room, not the voice | Era tag per song; warn when one era dominates; option to train per era |
| B2 | Chorus/harmony voices in the training set | Karaoke model on the full mix; "other singer" clustering in QC |
| B3 | Instrument bleed teaches noise | Bleedless model for training data; bleed energy check per clip |
| B4 | Training on the removed stem (reverb/hiss) | Only the final `dry` stem goes forward (A8) |
| B5 | Denoising first destroys detail | Fixed order: separate → de-echo/de-reverb → denoise |
| B6 | Over-denoised, "underwater" voice | Normal denoise by default; aggressive only for clips failing the noise-floor check; never stack Applio `noisereduce` |
| B7 | Breaths stripped → robotic output | Never de-breath training data; rely on `protect` at inference |
| B8 | Same song from two cassettes | Chromaprint fingerprint at upload; embedding dedup at clip level |
| B9 | Clipped or silent clips | VAD and clipping checks |
| B10 | Long held notes produce huge clips | 15 s slice cap |
| B11 | Too little data | Hard stop < 5 min, warning < 10 min, target 20–30 min |
| B12 | Tape wow/flutter bends pitch | Detect slow F0 drift on sustained notes; warn per clip |
| B13 | Low-bitrate MP3 artefacts baked in | ffprobe bitrate shown; warn < 128 kbps; prefer lossless uploads |
| B14 | A song with no singing (instrumental, wrong file) silently contributes nothing; if every song is like that, Applio preprocess writes **0 clips and still prints "preprocessed successfully"** | **Found in the benchmark** (synthetic tones were correctly removed as non-voice: -18 dB in, -91 dB out). After the clean-up chain, measure each song's vocal stem; mean below -60 dBFS → mark the song "no voice found" and show it in QC. After preprocess, count `sliced_audios/*.wav`; zero → fail with `no_clips` |

## C. Training

| # | Problem | Solution |
|---|---|---|
| C1 | Overtraining — metallic, copies training audio | Save every 5 epochs; mel-loss plateau + similarity probes; early stop; user picks checkpoint by ear. Noisy/cassette data: expect best at 20–50 epochs |
| C2 | Applio's overtraining detector missing in current `train.py` | Our own early stopping (doc 04 §7) |
| C3 | CUDA out of memory on 6 GB | Batch 4, no GPU cache; on OOM retry once at batch 2, then gradient checkpointing; separation never runs alongside |
| C4 | Laptop thermal throttling slows long runs | Show temp/clock; ETA from moving average adapts; guide: plug in, performance power mode |
| C5 | Crash / sleep / restart loses hours | Lease-based resume; Applio resumes from `G_/D_`; prevent sleep while a job runs (`SetThreadExecutionState`) |
| C6 | Cancel leaves VRAM held | Kill the whole process tree (dataloader children) |
| C7 | Disk fills with checkpoints | Keep last 2 `G_/D_` pairs; keep small exported `.pth` files; disk check before training |
| C8 | Non-English pronunciation mushy | A/B pretrained bases (TITAN, Snowie v3.1) and embedder (ContentVec vs SPIN-v2) — task 2.6 |

## D. Conversion

| # | Problem | Solution |
|---|---|---|
| D1 | Whole mix fed to the model → mush | Always separate first; convert lead vocal only |
| D2 | Voice in the wrong octave | Auto octave from stored singer median F0 vs source median |
| D3 | Vocal out of key with backing | Octave-only shifts by default; semitone shift also shifts the backing, with a warning |
| D4 | Artefacts / lisping timbre | Lower timbre strength (`index_rate`, default 0.4) |
| D5 | Mangled consonants, harsh sibilants, lost breaths | `protect` 0.4; light de-esser after conversion |
| D6 | Pitch glitches on high notes / melisma | RMVPE; per-song fallback to FCPE or hybrid; autotune **off** — it flattens Balochi ornaments |
| D7 | Flat or pumping dynamics | `volume_envelope` 0.35; loudness-match to original lead |
| D8 | Original singer leaks through | Don't reuse the removed reverb stem; lower `index_rate` only if artefacts appear; check separation quality |
| D9 | Dry vocal sits on top of the mix | Re-apply light reverb; vocal level control |
| D10 | Ornaments (vibrato, glissando) weaker than original | Known limit of the field (SVCC 2025: 37–44% style accuracy). Phrasing comes from the **source** performance — choose source singers in the same tradition and range |
| D11 | Clicks at chunk seams on long songs | Applio `split_audio` with its own overlap; separator `chunk_duration` only > 10 min |

## E. Web app and operations

| # | Problem | Solution |
|---|---|---|
| E1 | Upload of 2 GB dies at 90% | tus resumable upload; resume after refresh |
| E2 | Malicious or broken files | Magic-byte sniff, ffprobe with timeout, transcode, UUID paths, path-inside-root assertion |
| E3 | Two GPU jobs at once → OOM | Single worker, single queue for every GPU stage |
| E4 | Refresh loses the live view | Events stored; SSE replay with `Last-Event-ID` |
| E5 | Thousands of events slow the browser | Worker coalesces (GPU 1 Hz, steps ~2 s); charts use ring buffers outside React state |
| E6 | Applio update breaks the integration | Pinned commit; contract test for each command's arguments and stdout format; upgrade is a deliberate task |
| E7 | API dependencies clash with Applio's | Two venvs |
| E8 | SQLite "database is locked" | WAL mode, `busy_timeout=5000`, single writer for events (worker) |
| E9 | Opened on LAN without auth | Binds 127.0.0.1 by default; login required for every route including SSE |

## F. Legal and ethical

| # | Problem | Solution |
|---|---|---|
| F1 | Converting a real singer's voice without consent | Consent checklist when creating a singer (living singer consent, estate permission) — stored with the singer |
| F2 | Publishing a converted song with protected composition/master | Notice on the convert screen; prefer traditional/estate compositions |
| F3 | Undisclosed synthetic media | "AI-converted" metadata tag on every export; reminder to tick platform disclosure |
