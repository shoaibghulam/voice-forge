/**
 * In-memory library state for mock mode and tests. Records are replaced, never mutated
 * in place. Anything that depends on a running job (run status, last job status, live
 * checkpoints, cover status) is derived from the job registry at read time.
 */
import type { Checkpoint, Clip, Cover, CoverAudio, Dataset, Run, Singer, Song } from '@/api/schemas';
import { TERMINAL_STATUSES, type JobStatus } from '@/api/events';
import { allMockJobs, getMockJob, mockJobStatus, visibleEvents } from './jobRegistry';
import {
  seedCheckpoints, seedClips, seedCovers, seedRuns, seedSingers, seedSongs, type SingerRecord,
} from './librarySeed';

export interface UploadRecord {
  id: string;
  length: number;
  offset: number;
  metadata: Record<string, string>;
  createdAt: string;
}

interface State {
  singers: SingerRecord[];
  songs: Song[];
  clips: Clip[];
  /** Clip verdicts as QC first decided them, to compute minute adjustments. */
  autoVerdicts: Map<string, Clip['verdict']>;
  runs: Run[];
  checkpoints: Checkpoint[];
  covers: Cover[];
  uploads: Map<string, UploadRecord>;
  seq: number;
}

function fresh(): State {
  const songs = seedSongs();
  const clips = seedClips(songs);
  return {
    singers: seedSingers(),
    songs,
    clips,
    autoVerdicts: new Map(clips.map((c) => [c.id, c.verdict])),
    runs: seedRuns(),
    checkpoints: seedCheckpoints(),
    covers: seedCovers(),
    uploads: new Map(),
    seq: 0,
  };
}

let state = fresh();

export function resetLibraryStore(): void {
  state = fresh();
}

export function nextId(prefix: string): string {
  state.seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${state.seq}`;
}

/* ---------- singers ---------- */

export function findSinger(id: string): SingerRecord | undefined {
  return state.singers.find((s) => s.id === id);
}

function jobsFor(singerId: string) {
  return allMockJobs()
    .filter((entry) => entry.job.singer_id === singerId)
    .sort((a, b) => b.startedAtMs - a.startedAtMs);
}

const ACTIVE = new Set(['queued', 'running', 'pausing', 'paused', 'cancelling']);

/** A job is running for the singer — from the registry, or a seeded run still marked running. */
export function singerBusy(singerId: string): boolean {
  if (jobsFor(singerId).some((entry) => !TERMINAL_STATUSES.has(mockJobStatus(entry)))) return true;
  return state.runs.some((r) => r.singer_id === singerId && ACTIVE.has(liveStatus(r)));
}

/** Minutes adjusted by user overrides: each 3 s clip moved in or out counts. */
function usableMinutes(record: SingerRecord): number {
  let delta = 0;
  for (const clip of state.clips) {
    const auto = state.autoVerdicts.get(clip.id);
    if (!auto || auto === clip.verdict || !clipBelongsTo(clip, record.id)) continue;
    delta += (clip.verdict === 'keep' ? 1 : -1) * clip.duration_s;
  }
  return Math.max(0, Math.round((record.base_minutes + delta / 60) * 10) / 10);
}

function clipBelongsTo(clip: Clip, singerId: string): boolean {
  return state.songs.some((s) => s.id === clip.song_id && s.singer_id === singerId);
}

export function toSinger(record: SingerRecord): Singer {
  const latest = jobsFor(record.id)[0];
  const lastStatus: JobStatus | null = latest ? mockJobStatus(latest) : record.fallback_status;
  return {
    id: record.id,
    name: record.name,
    consent: record.consent,
    active_checkpoint_id: record.active_checkpoint_id,
    active_voice_label: record.active_voice_label,
    model_count: record.model_count,
    usable_minutes: usableMinutes(record),
    song_count: state.songs.filter((s) => s.singer_id === record.id).length,
    last_job: latest ? { id: latest.job.id, type: latest.job.type, status: mockJobStatus(latest) } : null,
    last_job_status: lastStatus,
    f0_median_hz: record.f0?.median ?? null,
    f0_p05_hz: record.f0?.p05 ?? null,
    f0_p95_hz: record.f0?.p95 ?? null,
    created_at: record.created_at,
    updated_at: record.created_at,
  };
}

export function listSingers(): Singer[] {
  return state.singers.map(toSinger);
}

export function addSinger(record: SingerRecord): Singer {
  state.singers = [record, ...state.singers];
  return toSinger(record);
}

export function updateSinger(id: string, patch: Partial<SingerRecord>): SingerRecord | undefined {
  const current = findSinger(id);
  if (!current) return undefined;
  const next = { ...current, ...patch };
  state.singers = state.singers.map((s) => (s.id === id ? next : s));
  return next;
}

export function removeSinger(id: string): void {
  const songIds = new Set(state.songs.filter((s) => s.singer_id === id).map((s) => s.id));
  state.singers = state.singers.filter((s) => s.id !== id);
  state.songs = state.songs.filter((s) => s.singer_id !== id);
  state.clips = state.clips.filter((c) => !songIds.has(c.song_id));
  state.runs = state.runs.filter((r) => r.singer_id !== id);
}

/* ---------- songs ---------- */

export function songsOf(singerId: string): Song[] {
  return state.songs.filter((s) => s.singer_id === singerId);
}

export function findSong(id: string): Song | undefined {
  return state.songs.find((s) => s.id === id);
}

export function addSong(song: Song): void {
  state.songs = [...state.songs, song];
}

export function replaceSong(song: Song): void {
  state.songs = state.songs.map((s) => (s.id === song.id ? song : s));
}

export function removeSong(id: string): void {
  state.songs = state.songs.filter((s) => s.id !== id);
  state.clips = state.clips.filter((c) => c.song_id !== id);
}

/* ---------- dataset & clips ---------- */

export function clipsOf(singerId: string): Clip[] {
  return state.clips.filter((c) => clipBelongsTo(c, singerId));
}

export function findClip(id: string): Clip | undefined {
  return state.clips.find((c) => c.id === id);
}

export function replaceClip(clip: Clip): void {
  state.clips = state.clips.map((c) => (c.id === clip.id ? clip : c));
}

const MIN_MINUTES = 5;
const WARN_MINUTES = 10;
const ERA_DOMINANCE = 0.7;

/** Prepared in the seed, or a prepare_dataset job for the singer has finished. */
export function isPrepared(record: SingerRecord): boolean {
  return record.prepared || jobsFor(record.id).some((e) => e.job.type === 'prepare_dataset' && mockJobStatus(e) === 'done');
}

const EMPTY_DATASET: Dataset = {
  usable_minutes: 0, kept_clips: 0, rejected_clips: 0, rejected: {}, era_minutes: {}, era_warning: false,
  gate: 'dataset_too_small', f0: null, no_voice_songs: [],
};

/** GET /singers/{id}/dataset (contract v1). */
export function datasetOf(record: SingerRecord): Dataset {
  if (!isPrepared(record)) return EMPTY_DATASET;
  const clips = clipsOf(record.id);
  const rejected: Record<string, number> = {};
  for (const clip of clips) {
    if (clip.verdict === 'reject') rejected[clip.reason ?? 'other'] = (rejected[clip.reason ?? 'other'] ?? 0) + 1;
  }
  const minutes = usableMinutes(record);
  const eras = Object.values(record.era_minutes).map((v) => v ?? 0);
  const eraTotal = eras.reduce((a, b) => a + b, 0);
  const kept = clips.filter((c) => c.verdict === 'keep').length;
  return {
    usable_minutes: minutes,
    kept_clips: kept,
    rejected_clips: clips.length - kept,
    rejected,
    era_minutes: Object.fromEntries(Object.entries(record.era_minutes).map(([era, v]) => [era, v ?? 0])),
    era_warning: eraTotal > 0 && eras.some((v) => v / eraTotal > ERA_DOMINANCE),
    gate: minutes < MIN_MINUTES ? 'dataset_too_small' : minutes < WARN_MINUTES ? 'warn_small' : null,
    f0: record.f0 ? { median_hz: record.f0.median, p05_hz: record.f0.p05, p95_hz: record.f0.p95 } : null,
    no_voice_songs: songsOf(record.id).filter((s) => s.status === 'no_voice').map((s) => s.id),
  };
}

/* ---------- runs & checkpoints ---------- */

function liveStatus(run: Run): string {
  const entry = run.job_id ? getMockJob(run.job_id) : undefined;
  return entry ? mockJobStatus(entry) : run.status;
}

function liveRun(run: Run): Run {
  return { ...run, status: liveStatus(run), checkpoint_count: checkpointsOf(run.id).length };
}

export function findRun(id: string): Run | undefined {
  const run = state.runs.find((r) => r.id === id);
  return run ? liveRun(run) : undefined;
}

export function runsOf(singerId: string): Run[] {
  return state.runs
    .filter((r) => r.singer_id === singerId)
    .map(liveRun)
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export function addRun(run: Run): void {
  state.runs = [...state.runs, run];
}

function withActive(checkpoints: Checkpoint[], runId: string): Checkpoint[] {
  const run = state.runs.find((r) => r.id === runId);
  const singer = run ? findSinger(run.singer_id) : undefined;
  return checkpoints
    .map((c) => ({ ...c, active: singer?.active_checkpoint_id === c.id }))
    .sort((a, b) => a.epoch - b.epoch);
}

/** Stored checkpoints, or — for a run still streaming — those its events have produced. Sorted by epoch. */
export function checkpointsOf(runId: string): Checkpoint[] {
  const stored = state.checkpoints.filter((c) => c.run_id === runId);
  if (stored.length > 0) return withActive(stored, runId);
  const run = state.runs.find((r) => r.id === runId);
  const entry = run?.job_id ? getMockJob(run.job_id) : undefined;
  if (!entry) return [];
  const byEpoch = new Map<number, Checkpoint>();
  for (const event of visibleEvents(entry)) {
    if (event.type === 'checkpoint.saved') {
      const { epoch, step, mel, has_sample: hasSample, sample_url: sampleUrl } = event.data;
      byEpoch.set(epoch, {
        id: event.data.checkpoint_id ?? `${runId}-ep${epoch}`, run_id: runId, epoch, step, mel_loss: mel ?? null, similarity: null,
        recommended: false, has_sample: hasSample, sample_url: sampleUrl ?? null, active: false, created_at: event.ts,
      });
    } else if (event.type === 'checkpoint.scored') {
      const prev = byEpoch.get(event.data.epoch);
      if (prev) byEpoch.set(event.data.epoch, { ...prev, similarity: event.data.similarity ?? null });
    }
  }
  const list = [...byEpoch.values()];
  const best = list.reduce<Checkpoint | null>((acc, c) => ((c.similarity ?? -1) > (acc?.similarity ?? -1) ? c : acc), null);
  return withActive(list.map((c) => ({ ...c, recommended: best !== null && c.epoch === best.epoch && c.similarity !== null })), runId);
}

export function findCheckpoint(id: string): Checkpoint | undefined {
  for (const run of state.runs) {
    const found = checkpointsOf(run.id).find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

export function addCheckpoint(checkpoint: Checkpoint): void {
  state.checkpoints = [...state.checkpoints, checkpoint];
}

/* ---------- covers ---------- */

const NO_AUDIO: CoverAudio = { mix: null, mp3: null, vocal: null, backing: null, original: null };

/** Output URLs exist once the convert job is done; the uploaded original is there from the start. */
function coverAudio(id: string, isDone: boolean): CoverAudio {
  const url = (track: keyof CoverAudio) => `/api/covers/${id}/audio/${track}`;
  if (!isDone) return { ...NO_AUDIO, original: url('original') };
  return { mix: url('mix'), mp3: url('mp3'), vocal: url('vocal'), backing: url('backing'), original: url('original') };
}

export function toCover(cover: Cover): Cover {
  const entry = cover.job_id ? getMockJob(cover.job_id) : undefined;
  const status = entry ? mockJobStatus(entry) : cover.status;
  return { ...cover, status, audio: coverAudio(cover.id, status === 'done') };
}

export function listCovers(): Cover[] {
  return state.covers.map(toCover).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export function findCover(id: string): Cover | undefined {
  const cover = state.covers.find((c) => c.id === id);
  return cover ? toCover(cover) : undefined;
}

export function addCover(cover: Cover): void {
  state.covers = [...state.covers, cover];
}

/* ---------- uploads ---------- */

export function findUpload(id: string): UploadRecord | undefined {
  return state.uploads.get(id);
}

export function putUpload(upload: UploadRecord): void {
  state.uploads = new Map(state.uploads).set(upload.id, upload);
}
