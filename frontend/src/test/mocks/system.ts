/** /api/system/* mocks: GPU snapshot, doctor checks, benchmark results (contract v1). */
import { http } from 'msw';
import type { Benchmarks, Doctor, Gpu } from '@/api/schemas';
import { ok } from './respond';

function gpu(): Gpu {
  const t = Date.now() / 1000;
  return {
    available: true,
    name: 'NVIDIA GeForce RTX 4050 Laptop GPU',
    driver: '566.36',
    mem_total_mb: 6144,
    mem_used_mb: Math.round(4700 + 180 * Math.sin(t / 7)),
    temp_c: Math.round(68 + 3 * Math.sin(t / 11)),
    util: Math.round(80 + 8 * Math.sin(t / 5)),
  };
}

const CHECKS: Doctor['checks'] = [
  { id: 'nvml', label: 'GPU visible (NVML)', ok: true, detail: 'RTX 4050 Laptop GPU · driver 566.36', hint: '' },
  { id: 'cuda', label: 'PyTorch CUDA', ok: true, detail: 'torch 2.7.1+cu128, CUDA available', hint: '' },
  { id: 'ffmpeg', label: 'ffmpeg', ok: true, detail: 'C:\\Users\\owner\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1-full_build\\bin\\ffmpeg.exe', hint: '' },
  { id: 'rmvpe', label: 'rmvpe.pt (pitch model)', ok: true, detail: '181.2 MB, size matches', hint: '' },
  { id: 'contentvec', label: 'ContentVec embedder', ok: true, detail: 'pytorch_model.bin 361.9 MB', hint: '' },
  { id: 'pretrained', label: 'Pretrained generator + discriminator', ok: true, detail: 'f0G40k.pth, f0D40k.pth', hint: '' },
  {
    id: 'sysmem_fallback', label: 'CUDA sysmem fallback', ok: false,
    detail: 'The driver may spill VRAM into shared memory (about 10× slower).',
    hint: 'NVIDIA Control Panel → Manage 3D settings → CUDA - Sysmem Fallback Policy → Prefer No Sysmem Fallback.',
  },
  { id: 'disk', label: 'Free disk space', ok: true, detail: '212 GB free on D:', hint: '' },
];

const DOCTOR: Doctor = { checks: CHECKS, ok: CHECKS.every((c) => c.ok) };

const BENCHMARKS: Benchmarks = {
  measured_at: '2026-10-19T00:07:40Z',
  rows: [
    { stage: 'separate', label: 'default', seconds: 41.2, audio_seconds: 240, rtf: 0.17, peak_vram_mb: 3820, note: 'segment 256, fp16' },
    { stage: 'preprocess', label: 'default', seconds: 62, audio_seconds: 1644, rtf: 0.04, peak_vram_mb: null, note: null },
    { stage: 'extract', label: 'rmvpe split', seconds: 125, audio_seconds: 1644, rtf: 0.08, peak_vram_mb: 2210, note: null },
    { stage: 'train', label: 'batch 4 (s/epoch)', seconds: 101.7, audio_seconds: null, rtf: null, peak_vram_mb: 5480, note: null },
    { stage: 'index', label: 'Auto', seconds: 9.5, audio_seconds: null, rtf: null, peak_vram_mb: null, note: null },
    { stage: 'infer', label: 'default', seconds: 38.9, audio_seconds: 240, rtf: 0.16, peak_vram_mb: 2950, note: null },
  ],
};

export const systemHandlers = [
  http.get('/api/system/gpu', () => ok(gpu())),
  http.get('/api/system/doctor', () => ok(DOCTOR)),
  http.get('/api/system/benchmarks', () => ok(BENCHMARKS)),
];
