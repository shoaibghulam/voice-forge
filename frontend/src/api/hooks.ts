/**
 * TanStack Query hooks for every REST endpoint in docs/06.
 * Screens import these; nothing else calls `fetch` for JSON.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, apiList, apiVoid } from './client';
import { TERMINAL_STATUSES } from './events';
import {
  analysisSchema, benchmarksSchema, checkpointSchema, clipSchema, coverReady, coverSchema, datasetSchema, doctorSchema,
  gpuSchema, jobSchema, runSchema, singerSchema, songSchema, trainStartedSchema, voiceImportSchema,
  type ClipVerdict, type Consent, type CoverSettings, type CoverTrack, type Era, type LanguageHint, type Preset,
} from './schemas';

export const keys = {
  singers: ['singers'] as const,
  singer: (id: string) => ['singers', id] as const,
  songs: (singerId: string) => ['singers', singerId, 'songs'] as const,
  dataset: (singerId: string) => ['singers', singerId, 'dataset'] as const,
  clips: (singerId: string, filter: string) => ['singers', singerId, 'clips', filter] as const,
  runs: (singerId: string) => ['singers', singerId, 'runs'] as const,
  run: (runId: string) => ['runs', runId] as const,
  checkpoints: (runId: string) => ['runs', runId, 'checkpoints'] as const,
  covers: ['covers'] as const,
  cover: (id: string) => ['covers', id] as const,
  analyses: ['analyses'] as const,
  analysis: (id: string) => ['analyses', id] as const,
  jobs: (status: string) => ['jobs', 'list', status] as const,
  job: (id: string) => ['jobs', id] as const,
  gpu: ['system', 'gpu'] as const,
  doctor: ['system', 'doctor'] as const,
  benchmarks: ['system', 'benchmarks'] as const,
};

const enc = encodeURIComponent;

/* ---------- singers ---------- */

export function useSingers() {
  return useQuery({ queryKey: keys.singers, queryFn: () => apiList('/singers', singerSchema) });
}

export function useSinger(id: string) {
  return useQuery({ queryKey: keys.singer(id), queryFn: () => api(`/singers/${enc(id)}`, singerSchema) });
}

export interface NewSinger {
  name: string;
  consent: Consent;
}

export function useCreateSinger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewSinger) => api('/singers', singerSchema, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.singers }),
  });
}

export function useRenameSinger(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api(`/singers/${enc(id)}`, singerSchema, { method: 'PATCH', body: { name } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.singers }),
  });
}

export function useDeleteSinger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiVoid(`/singers/${enc(id)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.singers }),
  });
}

/* ---------- songs ---------- */

export function useSongs(singerId: string) {
  return useQuery({
    queryKey: keys.songs(singerId),
    queryFn: () => apiList(`/singers/${enc(singerId)}/songs`, songSchema),
  });
}

export function useSetSongEra(singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ songId, era }: { songId: string; era: Era }) =>
      api(`/songs/${enc(songId)}`, songSchema, { method: 'PATCH', body: { era } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.songs(singerId) }),
  });
}

export function useDeleteSong(singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (songId: string) => apiVoid(`/songs/${enc(songId)}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.songs(singerId) }),
  });
}

/* ---------- dataset ---------- */

export function useDataset(singerId: string) {
  return useQuery({
    queryKey: keys.dataset(singerId),
    queryFn: () => api(`/singers/${enc(singerId)}/dataset`, datasetSchema),
  });
}

export interface ClipFilter {
  verdict?: ClipVerdict;
  reason?: string;
  limit?: number;
  offset?: number;
}

/** Enough rows for one reason group; the backend pages beyond this. */
export const CLIP_PAGE = 200;

export function useClips(singerId: string, filter: ClipFilter) {
  const params = new URLSearchParams();
  if (filter.verdict) params.set('verdict', filter.verdict);
  if (filter.reason) params.set('reason', filter.reason);
  params.set('limit', String(filter.limit ?? CLIP_PAGE));
  if (filter.offset) params.set('offset', String(filter.offset));
  const qs = params.toString();
  return useQuery({
    queryKey: keys.clips(singerId, qs),
    queryFn: () => apiList(`/singers/${enc(singerId)}/clips${qs ? `?${qs}` : ''}`, clipSchema),
  });
}

export function useOverrideClip(singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clipId, verdict }: { clipId: string; verdict: ClipVerdict }) =>
      api(`/clips/${enc(clipId)}`, clipSchema, { method: 'PATCH', body: { verdict } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['singers', singerId, 'clips'] });
      void qc.invalidateQueries({ queryKey: keys.dataset(singerId) });
    },
  });
}

export function usePrepare(singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (preset: Preset) =>
      api(`/singers/${enc(singerId)}/prepare`, jobSchema, { method: 'POST', body: { preset } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: keys.singer(singerId) });
    },
  });
}

/* ---------- training ---------- */

export interface TrainOptions {
  epochs?: number;
  batch_size?: number;
  save_every?: number;
  sample_rate?: number;
  vocoder?: string;
}

/** Answers `{job, run}`: training is its own job; preparing the dataset is a separate one. */
export function useTrain(singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TrainOptions) =>
      api(`/singers/${enc(singerId)}/train`, trainStartedSchema, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.runs(singerId) });
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
}

export function useRuns(singerId: string) {
  return useQuery({ queryKey: keys.runs(singerId), queryFn: () => apiList(`/singers/${enc(singerId)}/runs`, runSchema) });
}

export function useRun(runId: string | null | undefined) {
  return useQuery({
    queryKey: keys.run(runId ?? ''),
    queryFn: () => api(`/runs/${enc(runId ?? '')}`, runSchema),
    enabled: Boolean(runId),
  });
}

export function useCheckpoints(runId: string | null | undefined) {
  return useQuery({
    queryKey: keys.checkpoints(runId ?? ''),
    queryFn: () => apiList(`/runs/${enc(runId ?? '')}/checkpoints`, checkpointSchema),
    enabled: Boolean(runId),
  });
}

/** Make a checkpoint the singer's active voice; answers with the updated singer. */
export function useSelectCheckpoint(runId: string, singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (checkpointId: string) =>
      api(`/checkpoints/${enc(checkpointId)}/select`, singerSchema, { method: 'POST' }),
    onSuccess: (singer) => {
      qc.setQueryData(keys.singer(singerId), singer);
      void qc.invalidateQueries({ queryKey: keys.singers });
      void qc.invalidateQueries({ queryKey: keys.checkpoints(runId) });
    },
  });
}

export function checkpointExportUrl(checkpointId: string): string {
  return `/api/checkpoints/${enc(checkpointId)}/export`;
}

export function checkpointSampleUrl(checkpointId: string): string {
  return `/api/checkpoints/${enc(checkpointId)}/sample`;
}

/** Import a voice zip (field `file`) into a singer: a new run with one checkpoint. */
export function useImportVoice(singerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api(`/singers/${enc(singerId)}/voices/import`, voiceImportSchema, { method: 'POST', body: form });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.singers });
      void qc.invalidateQueries({ queryKey: keys.singer(singerId) });
      void qc.invalidateQueries({ queryKey: keys.runs(singerId) });
    },
  });
}

/* ---------- covers ---------- */

export interface NewCover {
  upload_id: string;
  singer_id: string;
  checkpoint_id?: string;
  settings: CoverSettings;
}

const COVER_POLL_MS = 4000;

export function useCovers() {
  return useQuery({ queryKey: keys.covers, queryFn: () => apiList('/covers', coverSchema) });
}

export function useCover(id: string) {
  return useQuery({
    queryKey: keys.cover(id),
    queryFn: () => api(`/covers/${enc(id)}`, coverSchema),
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return COVER_POLL_MS;
      return coverReady(data) || TERMINAL_STATUSES.has(data.status) ? false : COVER_POLL_MS;
    },
  });
}

export function useCreateCover() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewCover) => api('/covers', coverSchema, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.covers }),
  });
}

export function coverAudioUrl(coverId: string, track: CoverTrack): string {
  return `/api/covers/${enc(coverId)}/audio/${enc(track)}`;
}

/* ---------- jobs ---------- */

const JOBS_POLL_MS = 5000;
/** While a job is pausing or cancelling the list changes within seconds: poll faster. */
const JOBS_FAST_POLL_MS = 1000;
const TRANSITIONAL = new Set(['pausing', 'cancelling']);

export function useJobs(status = 'queued,running,pausing,paused,cancelling') {
  return useQuery({
    queryKey: keys.jobs(status),
    queryFn: () => apiList(`/jobs?status=${enc(status)}`, jobSchema),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => TRANSITIONAL.has(job.status)) ? JOBS_FAST_POLL_MS : JOBS_POLL_MS,
  });
}

export function useJob(id: string) {
  return useQuery({ queryKey: keys.job(id), queryFn: () => api(`/jobs/${enc(id)}`, jobSchema) });
}

export type JobAction = 'cancel' | 'pause' | 'resume';

export function useJobAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, action }: { jobId: string; action: JobAction }) =>
      api(`/jobs/${enc(jobId)}/${action}`, jobSchema, { method: 'POST' }),
    onSuccess: (job) => {
      qc.setQueryData(keys.job(job.id), job);
      void qc.invalidateQueries({ queryKey: ['jobs', 'list'] });
    },
  });
}

export function jobLogUrl(jobId: string, stage?: string): string {
  return `/api/jobs/${enc(jobId)}/logs${stage ? `?stage=${enc(stage)}` : ''}`;
}

/* ---------- system ---------- */

export function useGpu() {
  return useQuery({ queryKey: keys.gpu, queryFn: () => api('/system/gpu', gpuSchema), refetchInterval: 2000 });
}

export function useDoctor() {
  return useQuery({ queryKey: keys.doctor, queryFn: () => api('/system/doctor', doctorSchema) });
}

export function useBenchmarks() {
  return useQuery({ queryKey: keys.benchmarks, queryFn: () => api('/system/benchmarks', benchmarksSchema) });
}

/* ---------- analyses ---------- */

const ANALYSIS_POLL_MS = 3000;

export function useAnalyses() {
  return useQuery({ queryKey: keys.analyses, queryFn: () => apiList('/analyses', analysisSchema) });
}

/** Polled while the analyze job runs: each finished stage adds its part of the result. */
export function useAnalysis(id: string) {
  return useQuery({
    queryKey: keys.analysis(id),
    queryFn: () => api(`/analyses/${enc(id)}`, analysisSchema),
    refetchInterval: (query) => {
      const data = query.state.data;
      return data && TERMINAL_STATUSES.has(data.status) ? false : ANALYSIS_POLL_MS;
    },
  });
}

export interface NewAnalysis {
  upload_id: string;
  language: LanguageHint;
}

export function useCreateAnalysis() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: NewAnalysis) => api('/analyses', analysisSchema, { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.analyses }),
  });
}

/** Save the user's corrected lyrics (`null` goes back to the detected lines). */
export function useSaveLyrics(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (lyricsText: string | null) =>
      api(`/analyses/${enc(id)}`, analysisSchema, { method: 'PATCH', body: { lyrics_text: lyricsText } }),
    onSuccess: (analysis) => qc.setQueryData(keys.analysis(id), analysis),
  });
}

export function analysisExportUrl(id: string, format: 'txt' | 'json'): string {
  return `/api/analyses/${enc(id)}/export?format=${format}`;
}
