/**
 * Generates a recorded-style SSE event stream (docs/06 v1, contract payloads) for one job:
 * prepare_dataset (validate → qc), train (preprocess → samples), convert or analyze. Preparing and
 * training are separate jobs.
 *
 * Deterministic for a given seed. Timestamps follow plausible real durations (a 40-epoch
 * run spans ~1h50m); the mock server compresses them when replaying.
 */
import { runEventSchema, type RunEvent, type RunEventType, type WireEventData } from '@/api/events';
import { ANALYZE_STAGES, CONVERT_STAGES, PREPARE_STAGES, TRAIN_STAGES } from '@/live/stages';
import { lossAt, mulberry32, SONG_TITLES } from './runShape';

export type RunKind = 'prepare' | 'train' | 'convert' | 'analyze';

export interface MakeRunOptions {
  jobId: string;
  kind?: RunKind;
  /** Run id the checkpoints belong to (ids are `<runId>-ep<epoch>`). */
  runId?: string;
  epochs?: number;
  batchesPerEpoch?: number;
  songs?: number;
  startIso?: string;
  seed?: number;
  /** Stop the run with a stage.failed at this stage. */
  failAt?: string;
  singerSlug?: string;
}

interface Emitter {
  at: number;
  emit<T extends RunEventType>(type: T, stage: string | null, data: WireEventData<T>): void;
  advance(seconds: number): void;
  events: RunEvent[];
}

function createEmitter(jobId: string, startMs: number): Emitter {
  const events: RunEvent[] = [];
  const emitter: Emitter = {
    at: 0,
    events,
    advance(seconds) {
      emitter.at += seconds;
    },
    emit(type, stage, data) {
      const ts = new Date(startMs + Math.round(emitter.at * 1000)).toISOString();
      // parsed, so every generated event is checked against the contract schema
      events.push(runEventSchema.parse({ v: 1, seq: events.length + 1, job_id: jobId, ts, type, stage, data }));
    },
  };
  return emitter;
}

interface Ctx {
  e: Emitter;
  rnd: () => number;
  opts: Required<Omit<MakeRunOptions, 'failAt'>> & { failAt?: string | undefined };
  stages: string[];
  remainingS: number;
}

const EXPECTED_S: Record<string, number> = {
  validate: 40, separate: 620, dereverb: 300, denoise: 260, slice: 30, qc: 180,
  preprocess: 120, extract: 300, index: 60, export: 20, samples: 40,
  convert: 110, rereverb: 8, mix: 6, encode: 10,
  lyrics: 16, style: 24, sections: 8,
};

export function checkpointId(runId: string, epoch: number): string {
  return `${runId}-ep${epoch}`;
}

function gpu(ctx: Ctx, load: number): void {
  const util = Math.min(99, Math.max(3, Math.round(load * 100 + (ctx.rnd() - 0.5) * 10)));
  const memUsed = Math.round(1200 + load * 3500 + ctx.rnd() * 300);
  ctx.e.emit('gpu.sample', ctx.e.events.at(-1)?.stage ?? null, {
    util,
    mem_used_mb: memUsed,
    mem_total_mb: 6144,
    temp_c: Math.round(58 + load * 16 + ctx.rnd() * 3),
    power_w: Math.round(18 + load * 62),
    clock_mhz: Math.round(1500 + load * 420 - ctx.rnd() * 60),
  });
}

function eta(ctx: Ctx, stageEta: number, method: 'seed' | 'count' | 'ema'): void {
  ctx.e.emit('eta', null, { stage_eta_s: Math.max(0, Math.round(stageEta)), method });
}

function log(ctx: Ctx, stage: string, lines: string[]): void {
  ctx.e.emit('log.lines', stage, { lines });
}

function fail(ctx: Ctx, stage: string): void {
  log(ctx, stage, [
    `[${stage}] loading rmvpe from assets/rmvpe/rmvpe.pt`,
    'Traceback (most recent call last):',
    '  File "rvc/train/extract/extract.py", line 212, in run_pitch_extraction',
    'RuntimeError: PytorchStreamReader failed reading zip archive: failed finding central directory',
  ]);
  ctx.e.emit('stage.failed', stage, {
    stage,
    error_code: 'missing_prerequisite',
    message: 'Pitch extraction produced no files: rmvpe.pt is incomplete (4.1 KB).',
    hint: 'Re-download the Applio prerequisites (System → Doctor shows the file), then retry this stage.',
    duration_s: 4,
  });
  ctx.e.emit('job.status', null, { status: 'failed', error_code: 'missing_prerequisite', resume: true });
}

function itemStage(ctx: Ctx, name: string, index: number, total: number, unit: string, items: (i: number) => string, load: number): boolean {
  const expected = EXPECTED_S[name] ?? 60;
  ctx.remainingS -= expected;
  ctx.e.emit('stage.started', name, { stage: name, index, total_stages: ctx.stages.length });
  log(ctx, name, [`[${name}] starting · ${total} ${unit}`]);
  if (ctx.opts.failAt === name) {
    ctx.e.advance(4);
    fail(ctx, name);
    return false;
  }
  const per = expected / total;
  const tick = Math.max(1, Math.round(total / 12));
  let actual = 0;
  for (let done = 0; done < total; done += tick) {
    const step = Math.min(tick, total - done);
    const dt = per * step * (0.85 + ctx.rnd() * 0.3);
    ctx.e.advance(dt);
    actual += dt;
    const now = done + step;
    ctx.e.emit('stage.progress', name, { done: now, total, unit, item: items(now - 1) });
    if (load > 0) gpu(ctx, load);
    if (name === 'qc') qcBatch(ctx, done, step);
    log(ctx, name, [`[${name}] ${now}/${total} ${unit} · ${items(now - 1)}`]);
    eta(ctx, (actual / now) * (total - now), now >= 3 ? 'count' : 'seed');
  }
  ctx.e.advance(1);
  ctx.e.emit('stage.completed', name, { stage: name, duration_s: Math.round(actual * 10) / 10, outputs: outputsFor(name, total) });
  return true;
}

const REASONS = ['silence', 'bleed', 'other_singer', 'clipping', 'duplicate', 'noisy'];
const QC_BATCH = 20;

/** Verdicts for `count` clips, coalesced into batches of at most 20 (contract `qc.clip`). */
function qcBatch(ctx: Ctx, from: number, count: number): void {
  for (let start = 0; start < count; start += QC_BATCH) {
    const n = Math.min(QC_BATCH, count - start);
    const clips = Array.from({ length: n }, (_, i) => {
      const index = from + start + i;
      const rejected = ctx.rnd() < 0.18;
      const songNo = index % ctx.opts.songs;
      return {
        song_id: `song-${songNo + 1}`,
        path: `clips/song-${songNo + 1}/${String(index).padStart(5, '0')}.wav`,
        start_s: Math.round(((index * 37) % 240) * 10) / 10,
        duration_s: Math.round((2 + ctx.rnd() * 11) * 10) / 10,
        verdict: rejected ? ('reject' as const) : ('keep' as const),
        reason: rejected ? (REASONS[Math.floor(ctx.rnd() * REASONS.length)] ?? 'silence') : null,
        scores: { voiced: Math.round((rejected ? 0.4 : 0.9) * 100) / 100, clipped: rejected ? 0.02 : 0 },
      };
    });
    ctx.e.emit('qc.clip', 'qc', { clips });
  }
}

function outputsFor(name: string, total: number): Record<string, unknown> {
  if (name === 'slice') return { clips: 1284 };
  if (name === 'qc') return { kept: 1053, rejected: 231, usable_minutes: 27.4 };
  if (name === 'separate') return { stems: total * 2 };
  return { files: total };
}

function trainStage(ctx: Ctx, index: number): boolean {
  const { epochs, batchesPerEpoch: nb, singerSlug } = ctx.opts;
  const epochS = 100;
  const t0 = ctx.e.at;
  ctx.remainingS -= epochs * epochS;
  ctx.e.emit('stage.started', 'train', { stage: 'train', index, total_stages: ctx.stages.length });
  log(ctx, 'train', ['[train] pretrained TITAN-Medium 40k · batch 4 · fp16', '[train] starting epoch 1']);
  ctx.e.advance(12);
  log(ctx, 'train', ['WARNING: CUDA out of memory. Tried to allocate 386.00 MiB', '[train] retrying with batch_size=2']);
  ctx.e.emit('stage.retry', 'train', { reason: 'cuda_oom', change: { batch_size: 2 } });
  let ema = epochS;
  let lowest = { value: Number.POSITIVE_INFINITY, epoch: 0 };
  let bestSim = 0;
  for (let epoch = 1; epoch <= epochs; epoch += 1) {
    const thisEpoch = epochS * (0.92 + ctx.rnd() * 0.16) + epoch * 0.15;
    const slice = thisEpoch / 8;
    let melSum = 0;
    for (let k = 1; k <= 8; k += 1) {
      ctx.e.advance(slice);
      const batch = Math.round((k / 8) * nb);
      const step = (epoch - 1) * nb + batch;
      ctx.e.emit('train.step', 'train', { epoch, step, batch, num_batches: nb });
      const loss = lossAt(step / nb, ctx.rnd);
      melSum += loss.mel;
      ctx.e.emit('train.scalars', 'train', { step, ...loss });
      if (k % 2 === 0) gpu(ctx, 0.86);
      if (k % 4 === 0) {
        log(ctx, 'train', [`${singerSlug} | epoch=${epoch} | step=${step} | batch=${batch}/${nb} | mel=${loss.mel.toFixed(3)} | g_total=${loss.g_total.toFixed(3)}`]);
      }
    }
    const mel = melSum / 8;
    if (mel < lowest.value) lowest = { value: Math.round(mel * 1000) / 1000, epoch };
    ema = 0.3 * thisEpoch + 0.7 * ema;
    ctx.e.emit('train.epoch', 'train', { epoch, total_epochs: epochs, epoch_s: Math.round(thisEpoch * 10) / 10, lowest });
    ctx.e.emit('stage.progress', 'train', { done: epoch, total: epochs, unit: 'epochs', item: null });
    eta(ctx, ema * (epochs - epoch), 'ema');
    if (epoch % 5 === 0) bestSim = checkpoint(ctx, epoch, epoch * nb, mel, bestSim);
  }
  ctx.e.advance(3);
  ctx.e.emit('stage.completed', 'train', { stage: 'train', duration_s: Math.round(ctx.e.at - t0), outputs: { epochs, checkpoints: Math.floor(epochs / 5) } });
  return true;
}

function checkpoint(ctx: Ctx, epoch: number, step: number, mel: number, bestSim: number): number {
  const id = checkpointId(ctx.opts.runId, epoch);
  ctx.e.emit('checkpoint.saved', 'train', {
    checkpoint_id: id, epoch, step, mel: Math.round(mel * 1000) / 1000, has_sample: true, sample_url: `/api/checkpoints/${id}/sample`,
  });
  log(ctx, 'train', [`[train] saved ${ctx.opts.singerSlug}_${epoch}e_${step}s.pth`]);
  if (epoch % 10 !== 0) return bestSim;
  const similarity = Math.round((0.58 + 0.16 * (1 - Math.exp(-epoch / 14)) - Math.max(0, epoch - 30) * 0.004 + ctx.rnd() * 0.01) * 100) / 100;
  const recommended = similarity >= bestSim;
  ctx.e.emit('checkpoint.scored', 'train', { checkpoint_id: id, epoch, similarity, recommended });
  return Math.max(bestSim, similarity);
}

export function makeRun(options: MakeRunOptions): RunEvent[] {
  const opts = {
    kind: 'train' as RunKind,
    runId: 'mock',
    epochs: 40,
    batchesPerEpoch: 160,
    songs: 12,
    startIso: '2026-10-19T12:00:00.000Z',
    seed: 7,
    singerSlug: 'arif',
    ...options,
  };
  const byKind: Record<RunKind, readonly string[]> = {
    convert: CONVERT_STAGES, prepare: PREPARE_STAGES, train: TRAIN_STAGES, analyze: ANALYZE_STAGES,
  };
  const stages: string[] = [...byKind[opts.kind]];
  const e = createEmitter(opts.jobId, Date.parse(opts.startIso));
  const remainingS = stages.reduce((sum, s) => sum + (s === 'train' ? opts.epochs * 100 : EXPECTED_S[s] ?? 60), 0);
  const ctx: Ctx = { e, rnd: mulberry32(opts.seed), opts, stages, remainingS };

  e.emit('job.status', null, { status: 'queued', position_in_queue: 0 });
  e.advance(2);
  e.emit('job.status', null, { status: 'running' });

  const songTitle = (i: number) => SONG_TITLES[i % SONG_TITLES.length] ?? `song ${i + 1}`;
  for (const [index, name] of stages.entries()) {
    const ok = runStage(ctx, name, index, songTitle);
    if (!ok) return e.events;
  }
  e.advance(1);
  e.emit('job.status', null, { status: 'done' });
  return e.events;
}

function runStage(ctx: Ctx, name: string, index: number, songTitle: (i: number) => string): boolean {
  const songs = ctx.opts.songs;
  switch (name) {
    case 'train':
      return trainStage(ctx, index);
    case 'validate':
    case 'separate':
    case 'dereverb':
    case 'denoise':
      return itemStage(ctx, name, index, ctx.opts.kind === 'prepare' ? songs : 1, 'songs', songTitle, name === 'validate' ? 0 : 0.78);
    case 'slice':
    case 'qc':
      return itemStage(ctx, name, index, 1284, 'clips', (i) => `clip ${i + 1}`, name === 'qc' ? 0.35 : 0);
    case 'preprocess':
    case 'extract':
      return itemStage(ctx, name, index, 1053, 'files', (i) => `clip ${i + 1}`, name === 'extract' ? 0.7 : 0.1);
    default:
      return itemStage(ctx, name, index, 1, 'files', () => name, name === 'convert' || name === 'lyrics' ? 0.8 : 0.05);
  }
}
