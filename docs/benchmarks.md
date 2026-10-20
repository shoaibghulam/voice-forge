# Benchmarks — RTX 4050 Laptop (6 GB), measured 2026-10-19

Replaces the **[est.]** values in [04-ml-pipeline.md](04-ml-pipeline.md). Measured with
`python -m app.worker.benchmark` (backend/app/worker/benchmark.py). Peak VRAM is NVML
whole-GPU usage minus the baseline before the step, so it includes the CUDA context.

**Inputs were synthetic** (no real songs yet): separation was measured on generated
tones (2 × 90 s), training on Windows text-to-speech (3 × 141 s). Speed and memory scale
with audio length, not content, so these numbers hold; **quality** numbers need real
songs (tasks 2.4–2.6).

## Separation chain (segment 256, overlap 2, fp16, batch 1; models already cached)

| Step | Model | RTF (s per s of audio) | Peak VRAM |
|---|---|---|---|
| Lead vocal (karaoke) | `bs_roformer_karaoke_frazer_becruily` | 0.25 | 2.1 GB |
| Bleed | `mel_band_roformer_kim_ft2_bleedless_unwa` | 0.22 | 2.8 GB |
| De-echo | `dereverb-echo_mel_band_roformer_sdr_13.4843_v2` | 0.21 | 1.6 GB |
| Denoise | `denoise_mel_band_roformer_aufr33_sdr_27.9959` | 0.21 | 2.8 GB |
| **Whole chain** | | **≈ 0.9** → 4-min song ≈ 3.6 min | max 2.8 GB |

Every model fits with > 3 GB to spare; segment 128 fallback has not been needed.

## Training pipeline (40 kHz, RMVPE, ContentVec, HiFi-GAN base)

| Stage | Measured on 7.1 min of audio | Scaled to 20 min |
|---|---|---|
| Preprocess (slice) | 14 s → 177 clips (CPU) | ~40 s |
| Extract (f0 + features) | 96 s, 0.7 GB VRAM | ~4.5 min |
| Train, batch 4 | **34.5 s/epoch**, **3.3 GB** VRAM | ~100 s/epoch → 50 epochs ≈ 1.4 h, 100 ≈ 2.8 h |
| Index | 5 s | ~15 s |
| Convert (infer) | 32 s for 141 s of vocal (RTF 0.23), 1.8 GB | 4-min vocal ≈ 55 s |

Batch 4 leaves ~2.7 GB free, so batch 6 may fit — try it on real data before changing
the default. Batch 2 fallback was not needed.

## End-to-end estimates for the app (20 min of usable singing from ~8 songs)

| Job | Time |
|---|---|
| Prepare dataset (clean 8 × 4-min songs) | ≈ 30 min |
| Train 50 epochs (+ extract, index) | ≈ 1.5 h |
| Convert one 4-min song (separate + convert + mix) | ≈ 3 min |

## Findings while benchmarking (now in 05-problems-and-solutions.md)

- A12: separator filenames grew past Windows' 260-char path limit by the 4th step.
- A13: NVML intermittently returns "Unknown Error" for utilisation on this laptop.
- B14: non-voice input is removed entirely (-18 dB in, -91 dB out), and Applio's
  preprocess then writes 0 clips while printing "preprocessed successfully".
