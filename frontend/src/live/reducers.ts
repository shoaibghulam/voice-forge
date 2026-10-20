/**
 * Event → state for the live run view. Pure and immutable; events with seq ≤ lastSeq are
 * ignored, so a replay after reconnect can never double-count. High-rate telemetry
 * (train.scalars, gpu.sample, log.lines) is NOT reduced here — it goes to ring buffers.
 */
import { TERMINAL_STATUSES, type EtaMethod, type JobStatus, type QcClip, type RunEvent } from '@/api/events';
import type { StageStatus } from '@/api/schemas';
import { stageLabel, stageWeight } from './stages';
import { formatClock } from './eta';

export interface StageError {
  code: string;
  message: string;
  hint: string | null;
  logTail: string[];
}

export interface StageProgress {
  done: number;
  total: number;
  unit: string;
  item: string | null;
}

export interface StageState {
  name: string;
  status: StageStatus;
  expectedS: number | null;
  startedTs: string | null;
  finishedTs: string | null;
  durationS: number | null;
  progress: StageProgress | null;
  outputs: Record<string, unknown>;
  retries: { reason: string; change: Record<string, unknown> }[];
  error: StageError | null;
  skippedReason: string | null;
  /** Stopped by a pause; resuming starts it again. */
  paused: boolean;
}

export interface CheckpointState {
  checkpointId: string | null;
  epoch: number;
  step: number;
  mel: number | null;
  hasSample: boolean;
  sampleUrl: string | null;
  similarity: number | null;
  recommended: boolean;
}

export interface TrainState {
  epoch: number;
  totalEpochs: number | null;
  step: number;
  batch: number;
  numBatches: number;
  lastEpochS: number | null;
  avgEpochS: number | null;
  epochsTimed: number;
  lowest: { value: number; epoch: number } | null;
}

export interface EtaState {
  stageEtaS: number | null;
  /** Whole-job estimate: the server's, or this stage plus known estimates of later ones. */
  jobEtaS: number | null;
  /** 'stage' when later stages have no estimate yet, so the number covers this stage only. */
  scope: 'job' | 'stage';
  method: EtaMethod;
  ts: string;
}

export interface QcState {
  kept: number;
  rejected: number;
  keptSeconds: number;
  byReason: Record<string, number>;
}

export interface Announcement {
  seq: number;
  text: string;
}

export interface RunState {
  jobId: string;
  status: JobStatus;
  errorCode: string | null;
  positionInQueue: number | null;
  stages: StageState[];
  startedTs: string | null;
  finishedTs: string | null;
  lastTs: string | null;
  lastSeq: number;
  eta: EtaState | null;
  train: TrainState | null;
  checkpoints: CheckpointState[];
  qc: QcState;
  announcement: Announcement | null;
}

export function emptyStage(name: string): StageState {
  return {
    name, status: 'pending', expectedS: null, startedTs: null, finishedTs: null, durationS: null,
    progress: null, outputs: {}, retries: [], error: null, skippedReason: null, paused: false,
  };
}

export function initialRunState(jobId: string, stageNames: readonly string[] = [], status: JobStatus = 'queued'): RunState {
  return {
    jobId, status, errorCode: null, positionInQueue: null,
    stages: stageNames.map(emptyStage),
    startedTs: null, finishedTs: null, lastTs: null, lastSeq: 0,
    eta: null, train: null, checkpoints: [],
    qc: { kept: 0, rejected: 0, keptSeconds: 0, byReason: {} },
    announcement: null,
  };
}

function updateStage(state: RunState, name: string, index: number | null, patch: (stage: StageState) => StageState): StageState[] {
  const at = state.stages.findIndex((s) => s.name === name);
  if (at >= 0) return state.stages.map((s, i) => (i === at ? patch(s) : s));
  const created = patch(emptyStage(name));
  const stages = [...state.stages];
  stages.splice(index !== null && index <= stages.length ? index : stages.length, 0, created);
  return stages;
}

/** The payload names the stage (contract v1); the envelope's `stage` is the fallback. */
function stageName(event: RunEvent): string | null {
  switch (event.type) {
    case 'stage.started':
      return event.data.stage;
    case 'stage.completed':
    case 'stage.failed':
    case 'stage.skipped':
    case 'stage.paused':
      return event.data.stage ?? event.stage ?? null;
    default:
      return event.stage ?? null;
  }
}

function announce(event: RunEvent, text: string): Announcement {
  return { seq: event.seq, text };
}

function reduceStageEvent(state: RunState, event: RunEvent): RunState {
  const name = stageName(event);
  if (!name) return state;
  const label = stageLabel(name);
  switch (event.type) {
    case 'stage.started':
      return {
        ...state,
        stages: updateStage(state, name, event.data.index, (s) => ({
          ...s, status: 'running', startedTs: event.ts, finishedTs: null, durationS: null,
          expectedS: event.data.expected_s ?? s.expectedS, progress: null, error: null, paused: false,
        })),
        announcement: announce(event, `Stage ${event.data.index + 1} of ${event.data.total_stages}: ${label} started`),
      };
    case 'stage.progress':
      return {
        ...state,
        stages: updateStage(state, name, null, (s) => ({
          ...s,
          progress: { done: event.data.done, total: event.data.total, unit: event.data.unit, item: event.data.item ?? null },
        })),
      };
    case 'stage.retry':
      return {
        ...state,
        stages: updateStage(state, name, null, (s) => ({ ...s, retries: [...s.retries, { reason: event.data.reason, change: event.data.change }] })),
        announcement: announce(event, `${label} is retrying (${event.data.reason.replace(/_/g, ' ')})`),
      };
    case 'stage.completed':
      return {
        ...state,
        stages: updateStage(state, name, null, (s) => ({
          ...s, status: 'done', finishedTs: event.ts, durationS: event.data.duration_s, outputs: event.data.outputs, paused: false,
        })),
        announcement: announce(event, `${label} finished in ${formatClock(event.data.duration_s)}`),
      };
    case 'stage.skipped':
      return {
        ...state,
        stages: updateStage(state, name, null, (s) => ({ ...s, status: 'skipped', skippedReason: event.data.reason })),
        announcement: announce(event, `${label} skipped (${event.data.reason.replace(/_/g, ' ')})`),
      };
    case 'stage.paused':
      return {
        ...state,
        stages: updateStage(state, name, null, (s) => ({ ...s, status: 'pending', paused: true, finishedTs: event.ts })),
        announcement: announce(event, `${label} paused`),
      };
    case 'stage.failed':
      return {
        ...state,
        stages: updateStage(state, name, null, (s) => ({
          ...s, status: 'failed', finishedTs: event.ts, durationS: event.data.duration_s ?? s.durationS,
          error: { code: event.data.error_code, message: event.data.message, hint: event.data.hint ?? null, logTail: event.data.log_tail },
        })),
        announcement: announce(event, `${label} failed: ${event.data.message}`),
      };
    default:
      return state;
  }
}

function reduceTrain(state: RunState, event: RunEvent): RunState {
  const prev: TrainState = state.train ?? {
    epoch: 0, totalEpochs: null, step: 0, batch: 0, numBatches: 0,
    lastEpochS: null, avgEpochS: null, epochsTimed: 0, lowest: null,
  };
  if (event.type === 'train.step') {
    const { epoch, step, batch, num_batches: numBatches } = event.data;
    return { ...state, train: { ...prev, epoch, step, batch, numBatches } };
  }
  if (event.type === 'train.epoch') {
    const timed = prev.epochsTimed + 1;
    const avg = prev.avgEpochS === null ? event.data.epoch_s : prev.avgEpochS + (event.data.epoch_s - prev.avgEpochS) / timed;
    return {
      ...state,
      train: {
        ...prev,
        epoch: event.data.epoch,
        totalEpochs: event.data.total_epochs,
        lastEpochS: event.data.epoch_s,
        avgEpochS: avg,
        epochsTimed: timed,
        lowest: event.data.lowest ?? prev.lowest,
      },
    };
  }
  return state;
}

function blankCheckpoint(epoch: number): CheckpointState {
  return { checkpointId: null, epoch, step: 0, mel: null, hasSample: false, sampleUrl: null, similarity: null, recommended: false };
}

function sameCheckpoint(c: CheckpointState, id: string | null | undefined, epoch: number): boolean {
  return id && c.checkpointId ? c.checkpointId === id : c.epoch === epoch;
}

function reduceCheckpoint(state: RunState, event: RunEvent): RunState {
  if (event.type === 'checkpoint.saved') {
    const d = event.data;
    const existing = state.checkpoints.find((c) => sameCheckpoint(c, d.checkpoint_id, d.epoch));
    const others = state.checkpoints.filter((c) => c !== existing);
    const saved: CheckpointState = {
      ...(existing ?? blankCheckpoint(d.epoch)),
      checkpointId: d.checkpoint_id ?? existing?.checkpointId ?? null,
      epoch: d.epoch,
      step: d.step,
      mel: d.mel ?? null,
      hasSample: d.has_sample || Boolean(d.sample_url),
      sampleUrl: d.sample_url ?? null,
    };
    return { ...state, checkpoints: [...others, saved].sort((a, b) => b.epoch - a.epoch) };
  }
  if (event.type === 'checkpoint.scored') {
    const { checkpoint_id: id, epoch, similarity, recommended } = event.data;
    const found = state.checkpoints.some((c) => sameCheckpoint(c, id, epoch));
    const base = found ? state.checkpoints : [...state.checkpoints, { ...blankCheckpoint(epoch), checkpointId: id ?? null }];
    const checkpoints = base
      .map((c) => {
        if (sameCheckpoint(c, id, epoch)) return { ...c, similarity: similarity ?? null, recommended };
        return recommended && c.recommended ? { ...c, recommended: false } : c;
      })
      .sort((a, b) => b.epoch - a.epoch);
    return {
      ...state,
      checkpoints,
      announcement: recommended ? announce(event, `Epoch ${epoch} is now the recommended checkpoint`) : state.announcement,
    };
  }
  return state;
}

function reduceJobStatus(state: RunState, event: Extract<RunEvent, { type: 'job.status' }>): RunState {
  const status = event.data.status;
  const terminal = TERMINAL_STATUSES.has(status);
  return {
    ...state,
    status,
    errorCode: event.data.error_code ?? (status === 'failed' ? state.errorCode : null),
    positionInQueue: event.data.position_in_queue ?? null,
    startedTs: state.startedTs ?? (status === 'running' ? event.ts : null),
    finishedTs: terminal ? event.ts : null,
    announcement: status === state.status ? state.announcement : announce(event, `Job ${status}`),
  };
}

function addQcClip(qc: QcState, clip: QcClip): QcState {
  if (clip.verdict === 'keep') return { ...qc, kept: qc.kept + 1, keptSeconds: qc.keptSeconds + clip.duration_s };
  const key = clip.reason ?? 'other';
  return { ...qc, rejected: qc.rejected + 1, byReason: { ...qc.byReason, [key]: (qc.byReason[key] ?? 0) + 1 } };
}

/** Job ETA = the server's figure, else this stage's plus what later stages are expected to take. */
function etaState(state: RunState, event: Extract<RunEvent, { type: 'eta' }>): EtaState {
  const { stage_eta_s: stageEta, job_eta_s: jobEta, method } = event.data;
  const base = { stageEtaS: stageEta, method, ts: event.ts };
  if (jobEta !== null && jobEta !== undefined) return { ...base, jobEtaS: jobEta, scope: 'job' };
  const at = state.stages.findIndex((s) => s.status === 'running');
  const later = at >= 0 ? state.stages.slice(at + 1).filter((s) => s.status === 'pending') : [];
  const isPartial = later.some((s) => s.expectedS === null);
  const laterS = later.reduce((sum, s) => sum + (s.expectedS ?? 0), 0);
  return { ...base, jobEtaS: stageEta === null ? null : stageEta + laterS, scope: isPartial ? 'stage' : 'job' };
}

export function reduceEvent(state: RunState, event: RunEvent): RunState {
  if (event.seq <= state.lastSeq) return state;
  const base: RunState = { ...state, lastSeq: event.seq, lastTs: event.ts };
  switch (event.type) {
    case 'job.status':
      return reduceJobStatus(base, event);
    case 'train.step':
    case 'train.epoch':
      return reduceTrain(base, event);
    case 'checkpoint.saved':
    case 'checkpoint.scored':
      return reduceCheckpoint(base, event);
    case 'eta':
      return { ...base, eta: etaState(base, event) };
    case 'qc.clip':
      return { ...base, qc: event.data.clips.reduce(addQcClip, base.qc) };
    case 'train.scalars':
    case 'gpu.sample':
    case 'log.lines':
      return base;
    default:
      return reduceStageEvent(base, event);
  }
}

/** Order stages as the job snapshot lists them, keeping any state events already built. */
export function withStageOrder(state: RunState, names: readonly string[]): RunState {
  const byName = new Map(state.stages.map((s) => [s.name, s]));
  const ordered = names.map((name) => byName.get(name) ?? emptyStage(name));
  const extra = state.stages.filter((s) => !names.includes(s.name));
  const stages = [...ordered, ...extra];
  const same = stages.length === state.stages.length && stages.every((s, i) => s === state.stages[i]);
  return same ? state : { ...state, stages };
}

export function reduceEvents(state: RunState, events: readonly RunEvent[]): RunState {
  return events.reduce(reduceEvent, state);
}

/* ---------- selectors ---------- */

export function stageFraction(stage: StageState, train: TrainState | null): number {
  if (stage.status === 'done' || stage.status === 'skipped') return 1;
  if (stage.status !== 'running') return 0;
  if (stage.name === 'train' && train?.totalEpochs) {
    const within = train.numBatches > 0 ? train.batch / train.numBatches : 0;
    return Math.min(1, Math.max(0, (Math.max(0, train.epoch - 1) + within) / train.totalEpochs));
  }
  const p = stage.progress;
  return p && p.total > 0 ? Math.min(1, p.done / p.total) : 0;
}

/** Weighted progress 0..1 for the job bar. */
export function jobProgress(state: RunState): number {
  if (state.status === 'done') return 1;
  let total = 0;
  let done = 0;
  for (const stage of state.stages) {
    const weight = stage.expectedS ?? stageWeight(stage.name) * 60;
    total += weight;
    done += weight * stageFraction(stage, state.train);
  }
  return total > 0 ? done / total : 0;
}

export function runningStage(state: RunState): StageState | null {
  return state.stages.find((s) => s.status === 'running') ?? null;
}

export function failedStage(state: RunState): StageState | null {
  return state.stages.find((s) => s.status === 'failed') ?? null;
}
