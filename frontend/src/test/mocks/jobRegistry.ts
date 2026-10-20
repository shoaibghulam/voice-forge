/**
 * In-memory jobs for mock mode and tests. Each job owns a generated event stream and a
 * replay schedule (ms after the job's start). "Now" decides which events have happened,
 * so a page refresh mid-run replays history instantly and then continues live — the
 * same behaviour the real backend gives via Last-Event-ID / full replay.
 *
 * Controls follow the backend: pause → `pausing`, then `stage.paused` + `paused` after the
 * next checkpoint; cancel → `cancelling` → `cancelled`; resume re-queues the job and
 * continues from the first unfinished stage.
 */
import type { RunEvent } from '@/api/events';
import { TERMINAL_STATUSES, type JobStatus } from '@/api/events';
import type { Job, JobStage, StageStatus } from '@/api/schemas';
import { makeRun, type MakeRunOptions, type RunKind } from '@/test/fixtures/makeRun';
import { stagesForJobType } from '@/live/stages';

export interface MockJobInit {
  id?: string;
  type: 'prepare_dataset' | 'train' | 'convert' | 'analyze';
  singerId: string | null;
  singerName?: string;
  label?: string;
  runId?: string;
  coverId?: string;
  analysisId?: string;
  params?: Record<string, unknown>;
  /** Replay length of the whole stream in ms (wall clock). */
  durationMs?: number;
  /** Wall-clock start; defaults to now. Use a past time for a finished job. */
  startedAtMs?: number;
  run?: Partial<MakeRunOptions>;
}

export interface MockJob {
  job: Omit<Job, 'status' | 'stages' | 'started_at' | 'finished_at'>;
  stageNames: string[];
  events: RunEvent[];
  offsetsMs: number[];
  startedAtMs: number;
  /** Events cut off by a pause or cancel, replayed on resume. */
  parked: { events: RunEvent[]; offsetsMs: number[] };
  listeners: Set<() => void>;
}

type PartialEvent = Omit<RunEvent, 'seq' | 'ts' | 'v' | 'job_id'>;

const jobs = new Map<string, MockJob>();
let counter = 0;

export const mockClock = { now: (): number => Date.now() };

const KIND: Record<MockJobInit['type'], RunKind> = { prepare_dataset: 'prepare', train: 'train', convert: 'convert', analyze: 'analyze' };

/** Compress real timestamps into `durationMs`, keeping a small minimum gap for readability. */
export function scheduleFor(events: RunEvent[], durationMs: number): number[] {
  if (events.length === 0) return [];
  const t0 = Date.parse(events[0]?.ts ?? '');
  const span = Math.max(1, Date.parse(events.at(-1)?.ts ?? '') - t0);
  const scale = durationMs / span;
  const offsets: number[] = [];
  let prev = 0;
  for (const event of events) {
    const scaled = (Date.parse(event.ts) - t0) * scale;
    prev = offsets.length === 0 ? 0 : Math.max(scaled, prev + (durationMs > 0 ? 2 : 0));
    offsets.push(prev);
  }
  return offsets;
}

export function registerMockJob(init: MockJobInit): MockJob {
  counter += 1;
  const id = init.id ?? `job-mock-${counter}-${Math.round(mockClock.now() % 100000)}`;
  const kind = KIND[init.type];
  const events = makeRun({ jobId: id, kind, ...(init.runId ? { runId: init.runId } : {}), ...init.run });
  const entry: MockJob = {
    job: {
      id,
      type: init.type,
      singer_id: init.singerId,
      singer_name: init.singerName ?? null,
      label: init.label ?? null,
      run_id: init.runId ?? null,
      cover_id: init.coverId ?? null,
      analysis_id: init.analysisId ?? null,
      params: init.params ?? {},
      resume: false,
      error_code: null,
      created_at: new Date(init.startedAtMs ?? mockClock.now()).toISOString(),
    },
    stageNames: stagesForJobType(init.type),
    events,
    offsetsMs: scheduleFor(events, init.durationMs ?? 150_000),
    startedAtMs: init.startedAtMs ?? mockClock.now(),
    parked: { events: [], offsetsMs: [] },
    listeners: new Set(),
  };
  jobs.set(id, entry);
  return entry;
}

export function getMockJob(id: string): MockJob | undefined {
  return jobs.get(id);
}

export function allMockJobs(): MockJob[] {
  return [...jobs.values()];
}

export function resetMockJobs(): void {
  jobs.clear();
}

/** Events that have "happened" by now. */
export function visibleEvents(entry: MockJob, now = mockClock.now()): RunEvent[] {
  const elapsed = now - entry.startedAtMs;
  const out: RunEvent[] = [];
  for (const [i, event] of entry.events.entries()) {
    if ((entry.offsetsMs[i] ?? 0) <= elapsed) out.push(event);
    else break;
  }
  return out;
}

function notify(entry: MockJob): void {
  for (const listener of entry.listeners) listener();
}

function nowOffset(entry: MockJob): number {
  return mockClock.now() - entry.startedAtMs;
}

/** Re-number and re-time events so seq stays strictly increasing after the kept prefix. */
function stamp(entry: MockJob, kept: RunEvent[], parts: PartialEvent[], baseTs: number): RunEvent[] {
  return parts.map((part, i) => ({
    ...part, v: 1, seq: kept.length + i + 1, job_id: entry.job.id, ts: new Date(baseTs + 1000 * (i + 1)).toISOString(),
  }) as RunEvent);
}

function lastTs(events: RunEvent[]): number {
  return Date.parse(events.at(-1)?.ts ?? new Date().toISOString());
}

export function mockJobStatus(entry: MockJob, now = mockClock.now()): JobStatus {
  let status: JobStatus = 'queued';
  for (const event of visibleEvents(entry, now)) if (event.type === 'job.status') status = event.data.status;
  return status;
}

function currentStage(entry: MockJob): string | null {
  let stage: string | null = null;
  for (const event of visibleEvents(entry)) {
    if (event.type === 'stage.started') stage = event.data.stage;
    else if (event.type === 'stage.completed' || event.type === 'stage.failed') stage = null;
  }
  return stage;
}

export type ControlResult = { ok: true } | { ok: false; code: 'job_not_running' | 'job_not_resumable'; message: string };

const CONTROLLABLE = new Set<JobStatus>(['queued', 'running']);
const RESUMABLE = new Set<JobStatus>(['paused', 'failed', 'cancelled']);

/** Cancel now: `cancelling` then `cancelled`; the rest of the run is parked for a resume. */
export function cancelMockJob(entry: MockJob): ControlResult {
  const status = mockJobStatus(entry);
  if (!CONTROLLABLE.has(status) && status !== 'pausing') return { ok: false, code: 'job_not_running', message: `The job is ${status}.` };
  const keep = visibleEvents(entry).length;
  const kept = entry.events.slice(0, keep);
  entry.parked = { events: entry.events.slice(keep), offsetsMs: entry.offsetsMs.slice(keep) };
  const at = nowOffset(entry);
  const extra = stamp(entry, kept, [
    { type: 'job.status', stage: null, data: { status: 'cancelling' } },
    { type: 'job.status', stage: null, data: { status: 'cancelled', resume: true } },
  ] as PartialEvent[], lastTs(kept));
  entry.events = [...kept, ...extra];
  entry.offsetsMs = [...entry.offsetsMs.slice(0, keep), at, at + 400];
  notify(entry);
  return { ok: true };
}

/** Pause = `pausing` now, then stop right after the next checkpoint (docs/06). */
export function pauseMockJob(entry: MockJob): ControlResult {
  const status = mockJobStatus(entry);
  if (!CONTROLLABLE.has(status)) return { ok: false, code: 'job_not_running', message: `The job is ${status}.` };
  const from = visibleEvents(entry).length;
  const next = entry.events.findIndex((e, i) => i >= from && e.type === 'checkpoint.saved');
  const until = next === -1 ? from : next + 1;
  const kept = entry.events.slice(0, from);
  const at = nowOffset(entry);
  const pausing = stamp(entry, kept, [{ type: 'job.status', stage: null, data: { status: 'pausing' } }] as PartialEvent[], lastTs(kept));
  const running = entry.events.slice(from, until).map((e, i) => ({ ...e, seq: kept.length + 2 + i }) as RunEvent);
  const before = [...kept, ...pausing, ...running];
  const stage = currentStage(entry) ?? running.at(-1)?.stage ?? null;
  const stop = stamp(entry, before, [
    { type: 'stage.paused', stage, data: { stage } },
    { type: 'job.status', stage: null, data: { status: 'paused', resume: true } },
  ] as PartialEvent[], lastTs(before));
  const runningOffsets = entry.offsetsMs.slice(from, until).map((o) => Math.max(o, at));
  const stopAt = (runningOffsets.at(-1) ?? at) + 200;
  entry.parked = { events: entry.events.slice(until), offsetsMs: entry.offsetsMs.slice(until) };
  entry.events = [...before, ...stop];
  entry.offsetsMs = [...entry.offsetsMs.slice(0, from), at, ...runningOffsets, stopAt, stopAt + 50];
  notify(entry);
  return { ok: true };
}

/** Re-queue and continue: the stopped stage starts again, then the parked events play on. */
export function resumeMockJob(entry: MockJob): ControlResult {
  const status = mockJobStatus(entry);
  if (!RESUMABLE.has(status)) return { ok: false, code: 'job_not_resumable', message: `A ${status} job cannot be resumed.` };
  const kept = visibleEvents(entry);
  const at = nowOffset(entry);
  const parked = entry.parked;
  const restartStage = parked.events.find((e) => e.stage)?.stage ?? null;
  const index = restartStage ? entry.stageNames.indexOf(restartStage) : -1;
  const head: PartialEvent[] = [
    { type: 'job.status', stage: null, data: { status: 'queued', resume: true } },
    { type: 'job.status', stage: null, data: { status: 'running', resume: true } },
  ] as PartialEvent[];
  if (restartStage && index >= 0) {
    head.push({ type: 'stage.started', stage: restartStage, data: { stage: restartStage, index, total_stages: entry.stageNames.length } } as PartialEvent);
  }
  const restarted = stamp(entry, kept, head, lastTs(kept));
  const firstParked = parked.offsetsMs[0] ?? 0;
  const base = [...kept, ...restarted];
  const tail = parked.events.map((e, i) => ({ ...e, seq: base.length + i + 1 }) as RunEvent);
  entry.events = [...base, ...tail];
  entry.offsetsMs = [
    ...entry.offsetsMs.slice(0, kept.length),
    ...restarted.map((_, i) => at + 300 * i),
    ...parked.offsetsMs.map((o) => at + 1000 + (o - firstParked)),
  ];
  entry.parked = { events: [], offsetsMs: [] };
  entry.job = { ...entry.job, resume: true };
  notify(entry);
  return { ok: true };
}

export function subscribe(entry: MockJob, listener: () => void): () => void {
  entry.listeners.add(listener);
  return () => entry.listeners.delete(listener);
}

function stageStatusAfter(type: RunEvent['type'], current: StageStatus): StageStatus {
  switch (type) {
    case 'stage.started': return 'running';
    case 'stage.completed': return 'done';
    case 'stage.failed': return 'failed';
    case 'stage.skipped': return 'skipped';
    case 'stage.paused': return 'pending';
    default: return current;
  }
}

/** GET /jobs/{id}: a snapshot derived from the events that have happened. */
export function snapshot(entry: MockJob, now = mockClock.now()): Job {
  const stageMap = new Map<string, JobStage>(
    entry.stageNames.map((name, position) => [name, { name, position, status: 'pending', attempts: 0, outputs: {} }]),
  );
  let status: JobStatus = 'queued';
  let errorCode: string | null = null;
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  for (const event of visibleEvents(entry, now)) {
    if (event.type === 'job.status') {
      status = event.data.status;
      errorCode = event.data.error_code ?? (status === 'failed' ? errorCode : null);
      if (status === 'running' && !startedAt) startedAt = event.ts;
      finishedAt = TERMINAL_STATUSES.has(status) ? event.ts : null;
      continue;
    }
    const name = event.stage;
    const prev = name ? stageMap.get(name) : undefined;
    if (!name || !prev) continue;
    const changed: JobStage = { ...prev, status: stageStatusAfter(event.type, prev.status) };
    if (event.type === 'stage.started') stageMap.set(name, { ...changed, started_at: event.ts, finished_at: null, attempts: prev.attempts + 1 });
    else if (event.type === 'stage.completed') stageMap.set(name, { ...changed, finished_at: event.ts, outputs: event.data.outputs });
    else stageMap.set(name, changed);
  }
  return { ...entry.job, status, error_code: errorCode, started_at: startedAt, finished_at: finishedAt, stages: [...stageMap.values()] };
}

export function logText(entry: MockJob, stage?: string | null): string {
  const lines: string[] = [];
  for (const event of visibleEvents(entry)) {
    if (event.type !== 'log.lines') continue;
    if (stage && event.stage !== stage) continue;
    lines.push(...event.data.lines);
  }
  return lines.join('\n');
}
