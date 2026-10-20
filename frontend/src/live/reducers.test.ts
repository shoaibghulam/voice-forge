import { describe, expect, it } from 'vitest';
import { runEventSchema, type RunEvent, type WireEventData } from '@/api/events';
import { makeRun } from '@/test/fixtures/makeRun';
import {
  failedStage, initialRunState, jobProgress, reduceEvent, reduceEvents, runningStage, withStageOrder,
} from './reducers';
import { PREPARE_STAGES, TRAIN_STAGES } from './stages';

let seq = 0;
/** A wire event, parsed like the stream parses it (so contract defaults apply). */
function ev<T extends RunEvent['type']>(type: T, data: WireEventData<T>, stage: string | null = null, ts = '2026-10-19T12:00:00.000Z'): RunEvent {
  seq += 1;
  return runEventSchema.parse({ v: 1, seq, job_id: 'j', ts, type, stage, data });
}

describe('reduceEvent', () => {
  it('runs a stage through started → progress → completed', () => {
    const state = reduceEvents(initialRunState('j', ['validate', 'separate']), [
      ev('job.status', { status: 'running' }),
      ev('stage.started', { stage: 'validate', index: 0, total_stages: 2 }, 'validate'),
      ev('stage.progress', { done: 3, total: 12, unit: 'songs', item: 'a.mp3' }, 'validate'),
    ]);
    expect(state.status).toBe('running');
    expect(runningStage(state)?.name).toBe('validate');
    expect(state.stages[0]?.progress).toEqual({ done: 3, total: 12, unit: 'songs', item: 'a.mp3' });
    expect(state.announcement?.text).toContain('validate started');

    const done = reduceEvent(state, ev('stage.completed', { stage: 'validate', duration_s: 42, outputs: { files: 12 } }, 'validate'));
    expect(done.stages[0]).toMatchObject({ status: 'done', durationS: 42, outputs: { files: 12 } });
    expect(done.announcement?.text).toBe('validate finished in 0:42');
  });

  it('ignores events at or below lastSeq (replay after reconnect)', () => {
    const events = [
      ev('stage.started', { stage: 'qc', index: 0, total_stages: 1 }, 'qc'),
      ev('qc.clip', { clips: [{ song_id: 's1', duration_s: 3, verdict: 'reject', reason: 'bleed' }] }, 'qc'),
      ev('qc.clip', { clips: [{ song_id: 's1', duration_s: 6, verdict: 'keep', reason: null }] }, 'qc'),
    ];
    const once = reduceEvents(initialRunState('j'), events);
    const twice = reduceEvents(once, events);
    expect(twice).toBe(once);
    expect(once.qc).toEqual({ kept: 1, rejected: 1, keptSeconds: 6, byReason: { bleed: 1 } });
  });

  it('counts every clip of a coalesced qc.clip batch', () => {
    const clips = Array.from({ length: 20 }, (_, i) => ({
      song_id: 's1', duration_s: 2, verdict: i < 15 ? ('keep' as const) : ('reject' as const), reason: i < 15 ? null : 'silence',
    }));
    const state = reduceEvent(initialRunState('j'), ev('qc.clip', { clips }, 'qc'));
    expect(state.qc).toEqual({ kept: 15, rejected: 5, keptSeconds: 30, byReason: { silence: 5 } });
  });

  it('records a failure with hint, duration and the job error code', () => {
    const state = reduceEvents(initialRunState('j', ['extract']), [
      ev('stage.started', { stage: 'extract', index: 0, total_stages: 1 }, 'extract'),
      ev('stage.failed', { stage: 'extract', error_code: 'missing_prerequisite', message: 'rmvpe.pt is incomplete', hint: 'Re-download', duration_s: 7 }, 'extract'),
      ev('job.status', { status: 'failed', error_code: 'missing_prerequisite', resume: true }),
    ]);
    expect(failedStage(state)?.error).toEqual({ code: 'missing_prerequisite', message: 'rmvpe.pt is incomplete', hint: 'Re-download', logTail: [] });
    expect(failedStage(state)?.durationS).toBe(7);
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('missing_prerequisite');
    expect(state.finishedTs).not.toBeNull();
  });

  it('takes the stage name from the payload when the envelope has none', () => {
    const state = reduceEvents(initialRunState('j', ['slice']), [
      ev('stage.started', { stage: 'slice', index: 0, total_stages: 1 }, null),
      ev('stage.completed', { stage: 'slice', duration_s: 5, outputs: {} }, null),
    ]);
    expect(state.stages[0]).toMatchObject({ name: 'slice', status: 'done', durationS: 5 });
  });

  it('puts a paused stage back to pending and marks it paused, until it starts again', () => {
    const paused = reduceEvents(initialRunState('j', ['train']), [
      ev('stage.started', { stage: 'train', index: 0, total_stages: 1 }, 'train'),
      ev('job.status', { status: 'pausing' }),
      ev('stage.paused', { stage: 'train' }, 'train'),
      ev('job.status', { status: 'paused', resume: true }),
    ]);
    expect(paused.stages[0]).toMatchObject({ status: 'pending', paused: true });
    expect(paused.status).toBe('paused');
    expect(paused.announcement?.text).toBe('Job paused');
    const resumed = reduceEvent(paused, ev('stage.started', { stage: 'train', index: 0, total_stages: 1 }, 'train'));
    expect(resumed.stages[0]).toMatchObject({ status: 'running', paused: false });
  });

  it('marks skipped stages and retries', () => {
    const state = reduceEvents(initialRunState('j', ['denoise', 'train']), [
      ev('stage.skipped', { stage: 'denoise', reason: 'already_done' }, 'denoise'),
      ev('stage.retry', { reason: 'cuda_oom', change: { batch_size: 2 } }, 'train'),
    ]);
    expect(state.stages[0]).toMatchObject({ status: 'skipped', skippedReason: 'already_done' });
    expect(state.stages[1]?.retries).toEqual([{ reason: 'cuda_oom', change: { batch_size: 2 } }]);
  });

  it('keeps exactly one recommended checkpoint, newest epochs first', () => {
    const state = reduceEvents(initialRunState('j'), [
      ev('checkpoint.saved', { checkpoint_id: 'c5', epoch: 5, step: 800, mel: 21.5, has_sample: true, sample_url: '/s5' }, 'train'),
      ev('checkpoint.saved', { checkpoint_id: 'c10', epoch: 10, step: 1600, mel: 19.2, has_sample: false, sample_url: null }, 'train'),
      ev('checkpoint.scored', { checkpoint_id: 'c5', epoch: 5, similarity: 0.6, recommended: true }, 'train'),
      ev('checkpoint.scored', { checkpoint_id: 'c10', epoch: 10, similarity: 0.7, recommended: true }, 'train'),
    ]);
    expect(state.checkpoints.map((c) => c.epoch)).toEqual([10, 5]);
    expect(state.checkpoints.filter((c) => c.recommended).map((c) => c.epoch)).toEqual([10]);
    expect(state.checkpoints[0]).toMatchObject({ checkpointId: 'c10', similarity: 0.7, mel: 19.2, hasSample: false, sampleUrl: null });
    expect(state.checkpoints[1]).toMatchObject({ checkpointId: 'c5', hasSample: true, sampleUrl: '/s5' });
  });

  it('matches a score to its checkpoint by id, not only by epoch', () => {
    const state = reduceEvents(initialRunState('j'), [
      ev('checkpoint.saved', { checkpoint_id: 'a', epoch: 5, step: 800, has_sample: true }, 'train'),
      ev('checkpoint.scored', { checkpoint_id: 'a', epoch: 5, similarity: 0.66, recommended: false }, 'train'),
    ]);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.checkpoints[0]).toMatchObject({ checkpointId: 'a', similarity: 0.66, hasSample: true });
  });

  it('tracks epochs with an average epoch time', () => {
    const state = reduceEvents(initialRunState('j'), [
      ev('train.step', { epoch: 1, step: 80, batch: 80, num_batches: 160 }, 'train'),
      ev('train.epoch', { epoch: 1, total_epochs: 100, epoch_s: 100, lowest: { value: 30, epoch: 1 } }, 'train'),
      ev('train.epoch', { epoch: 2, total_epochs: 100, epoch_s: 110, lowest: { value: 28, epoch: 2 } }, 'train'),
    ]);
    expect(state.train).toMatchObject({ epoch: 2, totalEpochs: 100, lastEpochS: 110, avgEpochS: 105, lowest: { value: 28, epoch: 2 } });
  });

  it('stores ETA with its method and timestamp; a stage-only figure is scoped to the stage', () => {
    const running = reduceEvent(initialRunState('j', ['train', 'index']), ev('stage.started', { stage: 'train', index: 0, total_stages: 2 }, 'train'));
    const state = reduceEvent(running, ev('eta', { stage_eta_s: 10, method: 'ema' }, null, '2026-10-19T13:00:00.000Z'));
    expect(state.eta).toEqual({ stageEtaS: 10, jobEtaS: 10, scope: 'stage', method: 'ema', ts: '2026-10-19T13:00:00.000Z' });
  });

  it('uses the server job ETA when one is sent, and a null stage ETA stays unknown', () => {
    const withJob = reduceEvent(initialRunState('j'), ev('eta', { stage_eta_s: 10, job_eta_s: 300, method: 'count' }));
    expect(withJob.eta).toMatchObject({ jobEtaS: 300, scope: 'job' });
    const unknown = reduceEvent(initialRunState('j'), ev('eta', { stage_eta_s: null, method: 'seed' }));
    expect(unknown.eta).toMatchObject({ stageEtaS: null, jobEtaS: null });
  });

  it('a last-stage ETA covers the whole job', () => {
    const running = reduceEvent(initialRunState('j', ['mix', 'encode']), ev('stage.started', { stage: 'encode', index: 1, total_stages: 2 }, 'encode'));
    const state = reduceEvent(running, ev('eta', { stage_eta_s: 4, method: 'count' }));
    expect(state.eta).toMatchObject({ jobEtaS: 4, scope: 'job' });
  });

  it('creates stages it was not told about, at the reported index', () => {
    const state = reduceEvent(initialRunState('j', ['a', 'c']), ev('stage.started', { stage: 'b', index: 1, total_stages: 3 }, 'b'));
    expect(state.stages.map((s) => s.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('withStageOrder', () => {
  it('orders stages by the snapshot and keeps event-built state', () => {
    const state = reduceEvent(initialRunState('j'), ev('stage.started', { stage: 'slice', index: 4, total_stages: 6 }, 'slice'));
    const ordered = withStageOrder(state, ['validate', 'slice', 'qc']);
    expect(ordered.stages.map((s) => [s.name, s.status])).toEqual([['validate', 'pending'], ['slice', 'running'], ['qc', 'pending']]);
    expect(withStageOrder(ordered, ['validate', 'slice', 'qc'])).toBe(ordered);
  });
});

describe('a whole recorded run', () => {
  it('ends done with every stage done, checkpoints scored and progress at 100%', () => {
    const events = makeRun({ jobId: 'j', runId: 'r', epochs: 20 });
    const state = reduceEvents(initialRunState('j', [...TRAIN_STAGES]), events);
    expect(state.status).toBe('done');
    expect(state.stages.every((s) => s.status === 'done')).toBe(true);
    expect(state.checkpoints.map((c) => c.epoch)).toEqual([20, 15, 10, 5]);
    expect(state.checkpoints.map((c) => c.checkpointId)).toEqual(['r-ep20', 'r-ep15', 'r-ep10', 'r-ep5']);
    expect(state.checkpoints.filter((c) => c.recommended)).toHaveLength(1);
    expect(state.train?.epoch).toBe(20);
    expect(state.lastSeq).toBe(events.length);
    expect(jobProgress(state)).toBe(1);
  });

  it('a prepare_dataset job counts every QC verdict from the batched events', () => {
    const events = makeRun({ jobId: 'j', kind: 'prepare' });
    const state = reduceEvents(initialRunState('j', [...PREPARE_STAGES]), events);
    expect(state.status).toBe('done');
    expect(state.stages.map((s) => s.status)).toEqual(PREPARE_STAGES.map(() => 'done'));
    expect(state.qc.kept + state.qc.rejected).toBe(1284);
    expect(state.train).toBeNull();
  });

  it('reports partial progress mid-run, weighted by stage', () => {
    const events = makeRun({ jobId: 'j', epochs: 20 });
    const mid = events.findIndex((e) => e.type === 'train.epoch' && e.data.epoch === 10);
    const state = reduceEvents(initialRunState('j', [...TRAIN_STAGES]), events.slice(0, mid + 1));
    const p = jobProgress(state);
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.9);
    expect(runningStage(state)?.name).toBe('train');
  });

  it('stops at the failed stage when the fixture fails', () => {
    const state = reduceEvents(initialRunState('j'), makeRun({ jobId: 'j', failAt: 'extract', epochs: 5 }));
    expect(state.status).toBe('failed');
    expect(failedStage(state)?.name).toBe('extract');
    expect(state.stages.find((s) => s.name === 'train')).toBeUndefined();
  });
});
