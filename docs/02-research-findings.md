# 02 — Research findings (October 2026)

Three research passes, run 2026-10-19: voice engines, audio pipeline, system stack.
Repo status (stars, last commit, licence, archived) was checked live against GitHub.
**[est.]** marks an engineering estimate with no published source — confirm it with
benchmark task 0.1. There are **no published VRAM or timing figures for any of these
tools on a 6 GB laptop GPU**.

## 1. Where the field is

- **SVCC 2025** moved from identity to *style* conversion. Five systems were
  statistically tied with real recordings on singer identity; naturalness peaked
  around 3.7 vs 3.9 for real audio. Hardest styles: **breathy 37%, glissando 43%,
  vibrato 44%** — exactly Balochi folk ornaments.
  ([arXiv 2509.15629](https://arxiv.org/html/2509.15629v1))
- Top challenge systems (Vevo1.5 variants, S2Voice) are research code, not trainable
  products. They show direction, not what to ship.
- SVCC 2023 found **few objective metrics correlate with listeners**
  ([arXiv 2306.14422](https://arxiv.org/pdf/2306.14422)). Human listening stays the final judge.

## 2. Voice engines

| Engine | Licence / status | Trains per singer | 6 GB fit | Progress for dashboard | Verdict |
|---|---|---|---|---|---|
| **Applio 3.7.x** (RVC v2 fork) | MIT; release 3.7.0 on 2026-10-16; "maintenance mode" but active | Yes, 10–30 min audio | Train: yes (batch 4, no GPU cache, checkpointing on OOM). Infer: yes (≤4 GB path) | stdout `epoch/step/batch` lines + TensorBoard scalars & audio | **Primary** |
| RVC-Project WebUI | MIT; release Jul 2026 | Yes | Yes | stdout | Same family; Applio's CLI is richer |
| Seed-VC singing (`seed-uvit-whisper-base`) | **GPL-3.0, archived** (Apr 2025) | Zero-shot, or fine-tune in minutes | Infer ≥4 GB; fine-tune batch 1–2 [est.] | stdout only, no fp16 | Fallback / instant preview (phase 3) |
| DDSP-SVC 6.3 | MIT, active (Oct 2026) | Yes, ~1000 clips, hours | fp16, batch 24–32 [est.] | TensorBoard | Permissive fallback if GPL unwanted |
| so-vits-svc / fork | AGPL / archived; fork says "use Applio" | — | — | — | Avoid |
| CoMoSVC, NeuCoSVC | stale 2024; NeuCoSVC unlicensed | — | — | — | Research only |
| HQ-SVC (AAAI 2026) | no licence, no training code | No | <6 GB claimed | — | Watch |
| YingMusic-SVC (MIT), SoulX-Singer-SVC (Apache-2.0) | Dec 2025 / Mar 2026 | Zero-shot only | Not stated | — | Watch for preview engine |

Sources: [Applio](https://github.com/IAHispano/Applio),
[Applio releases](https://github.com/IAHispano/Applio/releases),
[Applio training docs](https://mintlify.wiki/IAHispano/Applio/features/training),
[RVC WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI),
[Seed-VC](https://github.com/Plachtaa/seed-vc),
[Seed-VC EVAL](https://github.com/Plachtaa/seed-vc/blob/main/EVAL.md),
[DDSP-SVC](https://github.com/yxlllc/DDSP-SVC),
[HQ-SVC](https://arxiv.org/html/2511.08496v3),
[YingMusic-SVC](https://github.com/GiantAILab/YingMusic-SVC),
[SoulX-Singer](https://github.com/Soul-AILab/SoulX-Singer).

**Head-to-head (Seed-VC's own singing benchmark):** RVCv2-48k beat zero-shot Seed-VC on
F0 correlation (0.940 vs 0.938), F0 RMSE (30.4 vs 33.4) and DNSMOS (3.12 vs 3.06); lost on
speaker similarity (0.726 vs 0.741) and intelligibility (CER 28.5 vs 19.7). Pitch
accuracy matters most for ornamented singing, which favours RVC.

### Why Applio stays primary

- The only candidate that is MIT, maintained this month, scriptable headless, emits
  parseable progress, and is documented to train in 6 GB.
- One trained model per singer — matches our workflow and our old zips.
- Our previous pipeline; its traps are known and fixed (doc 05).
- Applio 3.7 options we will use: vocoders HiFi-GAN / RefineGAN; sample rates
  32k/40k/48k; f0 crepe/rmvpe/fcpe; `--checkpointing`; `--batch-size`;
  custom pretrained G/D paths; index Auto/Faiss/KMeans.
- Pretrained bases to A/B on Balochi: **TITAN-Medium** (Apache-2.0, 32/40/48k),
  **Snowie v3.1** (non-English pronunciation), **Ov2Super** (small datasets). None has a
  published singing comparison.
- **Caveat:** the docs describe an overtraining detector, but it was not found in the
  current `train.py`. We implement early stopping ourselves (doc 04 §7).

## 3. Separation and clean-up

Leaderboard (MVSEP Multisong vocal SDR, [mvsep.com/algorithms](https://mvsep.com/algorithms)):
best single model BS-RoFormer 124 bands 12.33–12.39, but MVSEP's top models are
**service-only**. Locally we choose from `python-audio-separator`'s registry
([models.json](https://raw.githubusercontent.com/nomadkaraoke/python-audio-separator/main/audio_separator/models.json)).

| Job | Local model filename(s) | Note |
|---|---|---|
| Lead vocal vs backing vocals (karaoke) | `bs_roformer_karaoke_frazer_becruily.ckpt` (lead SDR 10.10), `mel_band_roformer_karaoke_becruily.ckpt` | Run on the **full mix**: vocal-first then karaoke lowers lead SDR for MelBand karaoke models |
| Vocals | `mel_band_roformer_vocals_fv4_gabox.ckpt` (old default), fv5/fv6/fv7b, `mel_band_roformer_kim_ft2_bleedless_unwa.ckpt` | For training data **prefer bleedless**: bleed hurts more than lost fullness |
| De-echo / de-reverb | `dereverb-echo_mel_band_roformer_sdr_13.4843_v2.ckpt`, `dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt`, `..._mono_anvuew.ckpt` | Echo models for old PA/tape |
| Denoise | `denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt` (normal), `..._aggr_sdr_27.9768.ckpt` | Aggressive only on clips failing a noise-floor check |
| Debleed | `mel_band_roformer_denoise_debleed_gabox.ckpt` | Optional |
| Avoid on 6 GB | `melband_roformer_big_beta6x.ckpt`, `MelBandRoformerBigSYHFTV1.ckpt`, SCNet XL | Likely OOM [est.] |

API: `Separator(output_dir, model_file_dir, output_format="WAV", use_native_fp16=True,
mdxc_params={"segment_size":256,"batch_size":1,"overlap":4})`, then `load_model()` and
`separate()`. `use_native_fp16` is verified for RoFormer on CUDA. Don't use
`chunk_duration` except for files > 10 min (no crossfade → clicks). Don't use
`use_torch_compile` on Windows. ([README](https://github.com/nomadkaraoke/python-audio-separator))

6 GB estimates [est.]: 2.5–4.5 GB peak per standard RoFormer at fp16/batch 1/segment
256; 20–60 s per RoFormer pass per 4-min song; 2–4 min per song for a 4-pass chain.

## 4. Features

- **Pitch: RMVPE** — 97.3% raw pitch accuracy on MIR-1K, robust in polyphony
  ([arXiv 2306.15412](https://arxiv.org/pdf/2306.15412)). FCPE is faster (96.8%) — use
  only if RMVPE makes octave errors on a source. Same method in training and inference.
- **Embedder: ContentVec** baseline; A/B **SPIN-v2** for Balochi phoneme clarity — no
  singing benchmark exists ([SPIN](https://www.isca-archive.org/interspeech_2023/chang23_interspeech.html)).
- **Sample rate: 40 kHz.** Cassette rarely carries content above 12–15 kHz; 48k gains nothing.
- **Data:** ≥10 min, 20–30 min noticeably better, diminishing past ~60 min.

## 5. Dataset QC tools

| Check | Tool |
|---|---|
| Voice activity | [Silero VAD](https://github.com/snakers4/silero-vad) |
| Loudness | [pyloudnorm](https://github.com/csteinmetz1/pyloudnorm) (ITU-R BS.1770) |
| Other singers | Singer embeddings + clustering; singing-specific encoder ([arXiv 2401.05064](https://arxiv.org/pdf/2401.05064)) beats speech ECAPA on singing |
| Duplicate songs | [Chromaprint](https://acoustid.org/chromaprint) fingerprints |

## 6. Evaluation

- Singer similarity: embedding cosine — best objective similarity metric in SVCC 2023,
  still not always significant.
- Melody: F0 RMSE in cents (source after transposition vs output).
- Naturalness: UTMOS / SingMOS-Pro predictors — trained on Chinese/Japanese; may not
  transfer to Balochi.
- Whisper-based intelligibility: unusable (poor Balochi support).
- **Use metrics only as regression checks between model versions**, never as absolute
  quality. Keep the blind listening test.

## 7. System stack

| Area | Finding | Source |
|---|---|---|
| Docker/WSL2 | NVML GPU utilisation not supported under WSL2; pinned memory limited | [NVIDIA CUDA on WSL](https://docs.nvidia.com/cuda/wsl-user-guide/index.html) |
| Celery | No Windows support since 4.x | [Celery FAQ](https://docs.celeryq.dev/en/stable/faq.html) |
| arq / Dramatiq / RQ | Need Redis (no native Windows); RQ uses `fork` | arq docs |
| Huey | Works on Windows with `SqliteHuey` | fallback option |
| SSE | Native in FastAPI ≥0.135: `fastapi.sse.EventSourceResponse`, keep-alive ping, `Last-Event-ID` | [FastAPI SSE](https://fastapi.tiangolo.com/tutorial/server-sent-events/) |
| GPU stats | `nvidia-ml-py` (import `pynvml`); the `pynvml` PyPI package is a deprecated wrapper | PyPI |
| Uploads | `tuspyserver` (FastAPI router) or `tusd` (Go binary, Windows build) | [tus.io](https://tus.io/implementations) |
| Live charts | uPlot is the fastest canvas line chart for streaming | [benchmark](https://apexcharts.com/blog/javascript-chart-library-benchmark/) |
| Applio progress | `train.py` prints `"{model} \| epoch={e} \| step={s} \| batch={b}/{n}"` (flushed) and an end-of-epoch line with `lowest_value`; TensorBoard scalars `loss_avg_50/g/{mel,kl,fm,adv,total}`, `loss_avg_50/d/adv`, audio at save epochs; `core.py` wrappers swallow output | [train.py](https://github.com/IAHispano/Applio/blob/main/rvc/train/train.py) |
| Applio resume | `train.py` resumes from latest `G_*.pth`/`D_*.pth` incl. LR scheduler | same |

### Reusable projects

| Project | Licence | Use |
|---|---|---|
| Applio | MIT + Terms of Use (contact for commercial) | Engine |
| python-audio-separator 0.47.x | MIT (model weights have own licences) | Separation |
| ultimate-rvc | MIT, active | Reference for the cover pipeline |
| AICoverGen, rvc-python | MIT, stale | Reference only |

Package versions as reported on 2026-10-19 are in [03-architecture.md](03-architecture.md).
Re-check them at install time.
