import { describe, expect, it } from 'vitest';
import { makeRun } from '@/test/fixtures/makeRun';
import { parseEvent, REPLAY_DONE_EVENT, RUN_EVENT_TYPES, type RunEventType } from './events';

const envelope = (type: string, data: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, seq: 7, job_id: 'job-1', ts: '2026-10-19T14:03:22.418Z', type, stage: 'train', data, ...extra });

/** One sample per type, with exactly the payloads of the backend contract (v1). */
const SAMPLES: Record<RunEventType, unknown> = {
  'job.status': { status: 'failed', error_code: 'cuda_oom', resume: true },
  'stage.started': { stage: 'train', index: 2, total_stages: 6 },
  'stage.progress': { done: 3, total: 12, unit: 'songs', item: 'Song title.mp3' },
  'stage.retry': { reason: 'cuda_oom', change: { batch_size: 2 } },
  'stage.completed': { stage: 'slice', outputs: { clips: 1284 }, duration_s: 42.5 },
  'stage.skipped': { stage: 'denoise', reason: 'already_done' },
  'stage.paused': { stage: 'train' },
  'stage.failed': { stage: 'extract', error_code: 'cuda_oom', message: 'Out of memory', hint: 'Close apps', duration_s: 12 },
  'train.step': { epoch: 34, step: 5440, batch: 112, num_batches: 160 },
  'train.scalars': { step: 5440, mel: 18.2, kl: 1.1, fm: 9.0, adv: 2.6, g_total: 30.9, d_adv: 2.4, grad_g: 40, grad_d: 18 },
  'train.epoch': { epoch: 34, total_epochs: 100, epoch_s: 101, lowest: { value: 17.9, epoch: 31 } },
  'checkpoint.saved': { checkpoint_id: 'ck-30', epoch: 30, step: 4800, mel: 18.1, has_sample: true, sample_url: '/api/checkpoints/ck-30/sample' },
  'checkpoint.scored': { checkpoint_id: 'ck-30', epoch: 30, similarity: 0.71, recommended: true },
  'qc.clip': {
    clips: [
      { song_id: 's1', path: 'clips/s1/00001.wav', start_s: 12, duration_s: 4.2, verdict: 'reject', reason: 'bleed', scores: { voiced: 0.4, clipped: 0 } },
      { song_id: 's1', path: 'clips/s1/00002.wav', start_s: 16.2, duration_s: 3, verdict: 'keep', reason: null, scores: { voiced: 0.9 } },
    ],
  },
  eta: { stage_eta_s: 300, method: 'ema' },
  'gpu.sample': { util: null, mem_used_mb: 4700, mem_total_mb: 6144, temp_c: null, power_w: 78, clock_mhz: null },
  'log.lines': { lines: ['arif | epoch=34 | step=5440'] },
};

describe('parseEvent', () => {
  it.each(RUN_EVENT_TYPES)('accepts a valid %s event', (type) => {
    const result = parseEvent(envelope(type, SAMPLES[type]));
    expect(result.kind).toBe('event');
    if (result.kind === 'event') {
      expect(result.event.type).toBe(type);
      expect(result.event.seq).toBe(7);
    }
  });

  it('covers every event type in docs/06', () => {
    expect([...RUN_EVENT_TYPES].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it('fills documented defaults', () => {
    const saved = parseEvent(envelope('checkpoint.saved', { epoch: 5, step: 800 }));
    expect(saved.kind === 'event' && saved.event.type === 'checkpoint.saved' && saved.event.data.has_sample).toBe(false);
    const failed = parseEvent(envelope('stage.failed', { stage: 'qc', error_code: 'x', message: 'y', hint: null, duration_s: 1 }));
    expect(failed.kind === 'event' && failed.event.type === 'stage.failed' && failed.event.data.log_tail).toEqual([]);
  });

  it('accepts training scalars with any loss key missing', () => {
    const result = parseEvent(envelope('train.scalars', { step: 10, mel: 20 }));
    expect(result.kind).toBe('event');
  });

  it('accepts the transitional statuses pausing and cancelling', () => {
    expect(parseEvent(envelope('job.status', { status: 'pausing' })).kind).toBe('event');
    expect(parseEvent(envelope('job.status', { status: 'cancelling' })).kind).toBe('event');
  });

  it('does not treat replay.done as a run event', () => {
    expect(RUN_EVENT_TYPES).not.toContain(REPLAY_DONE_EVENT);
    expect(parseEvent('{}').kind).toBe('invalid');
  });

  it('reports an unknown event type without throwing', () => {
    expect(parseEvent(envelope('train.histogram', { bins: [] }))).toEqual({ kind: 'unknown', type: 'train.histogram', seq: 7 });
  });

  it('rejects malformed payloads with a reason', () => {
    expect(parseEvent('not json').kind).toBe('invalid');
    const wrong = parseEvent(envelope('train.step', { epoch: 'thirty' }));
    expect(wrong.kind).toBe('invalid');
    if (wrong.kind === 'invalid') expect(wrong.reason).toContain('data.epoch');
    expect(parseEvent(envelope('qc.clip', { clip_id: 'c1', verdict: 'keep', duration_s: 3 })).kind).toBe('invalid');
    expect(parseEvent(envelope('job.status', { status: 'exploded' })).kind).toBe('invalid');
    expect(parseEvent(JSON.stringify({ v: 2, seq: 1, job_id: 'j', ts: 't', type: 'eta', data: {} })).kind).toBe('invalid');
  });

  it('accepts a null stage on job-level events', () => {
    expect(parseEvent(envelope('job.status', { status: 'done' }, { stage: null })).kind).toBe('event');
  });

  it.each(['prepare', 'train', 'convert'] as const)('accepts every event of a generated %s run', (kind) => {
    const events = makeRun({ jobId: 'j', kind, epochs: 10 });
    const bad = events.map((e) => parseEvent(JSON.stringify(e))).filter((r) => r.kind !== 'event');
    expect(bad).toEqual([]);
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    const times = events.map((e) => Date.parse(e.ts));
    expect(times.every((t, i) => i === 0 || t >= (times[i - 1] ?? 0))).toBe(true);
  });
});
