/**
 * REST resource schemas (docs/06 "Endpoints" + "Data model").
 *
 * Fields the docs do not pin down are `nullish()` so a backend that omits them still
 * validates. Unknown fields are stripped. Types are inferred from the schemas.
 */
import { z } from 'zod';
import { jobStatusSchema } from './events';

const id = z.string().min(1);
const iso = z.string();
const maybeNum = z.number().nullish();

export const ERAS = ['cassette', 'vinyl', 'studio', 'live', 'unknown'] as const;
export const eraSchema = z.enum(ERAS);
export type Era = z.infer<typeof eraSchema>;

export const PRESETS = ['cassette', 'studio', 'live'] as const;
export type Preset = (typeof PRESETS)[number];

export const consentSchema = z.object({
  living_consent: z.boolean().default(false),
  estate_permission: z.boolean().default(false),
  notes: z.string().nullish(),
});
export type Consent = z.infer<typeof consentSchema>;

export const jobRefSchema = z.object({ id, type: z.string(), status: jobStatusSchema });

export const singerSchema = z.object({
  id,
  name: z.string(),
  consent: consentSchema.nullish(),
  active_checkpoint_id: z.string().nullish(),
  active_voice_label: z.string().nullish(),
  model_count: z.number().int().nonnegative().default(0),
  usable_minutes: maybeNum,
  song_count: z.number().int().nonnegative().nullish(),
  last_job: jobRefSchema.nullish(),
  last_job_status: jobStatusSchema.nullish(),
  f0_median_hz: maybeNum,
  f0_p05_hz: maybeNum,
  f0_p95_hz: maybeNum,
  created_at: iso.nullish(),
  updated_at: iso.nullish(),
});
export type Singer = z.infer<typeof singerSchema>;

export const songSchema = z.object({
  id,
  singer_id: id,
  original_filename: z.string(),
  duration_s: maybeNum,
  codec: z.string().nullish(),
  bitrate: z.number().nullish(),
  era: eraSchema.catch('unknown'),
  status: z.string(),
  duplicate_of: z.string().nullish(),
  created_at: iso.nullish(),
});
export type Song = z.infer<typeof songSchema>;

export const DATASET_GATES = ['dataset_too_small', 'warn_small'] as const;

const f0Schema = z.object({ median_hz: maybeNum, p05_hz: maybeNum, p95_hz: maybeNum });

export const datasetSchema = z.object({
  usable_minutes: z.number().nonnegative().default(0),
  kept_clips: z.number().int().nonnegative().default(0),
  rejected_clips: z.number().int().nonnegative().default(0),
  /** rejected clip count by reason code */
  rejected: z.record(z.string(), z.number()).default({}),
  era_minutes: z.record(z.string(), z.number()).default({}),
  era_warning: z.boolean().default(false),
  gate: z.enum(DATASET_GATES).nullish(),
  f0: f0Schema.nullish(),
  no_voice_songs: z.array(z.string()).default([]),
});
export type Dataset = z.infer<typeof datasetSchema>;

export const CLIP_VERDICTS = ['keep', 'reject'] as const;
export type ClipVerdict = (typeof CLIP_VERDICTS)[number];

export const clipSchema = z.object({
  id,
  song_id: id,
  song_title: z.string().nullish(),
  start_s: z.number(),
  duration_s: z.number(),
  verdict: z.enum(CLIP_VERDICTS),
  reason: z.string().nullish(),
  user_override: z.boolean().default(false),
  scores: z.record(z.string(), z.number().nullable()).default({}),
  audio_url: z.string().nullish(),
  peaks: z.array(z.number()).nullish(),
});
export type Clip = z.infer<typeof clipSchema>;

export const runSchema = z.object({
  id,
  singer_id: id,
  job_id: z.string().nullish(),
  status: z.string(),
  config: z.record(z.string(), z.unknown()).default({}),
  applio_commit: z.string().nullish(),
  created_at: iso.nullish(),
  checkpoint_count: z.number().int().nonnegative().default(0),
});
export type Run = z.infer<typeof runSchema>;

export const checkpointSchema = z.object({
  id,
  run_id: id,
  epoch: z.number().int().nonnegative(),
  step: z.number().int().nonnegative().default(0),
  mel_loss: maybeNum,
  similarity: maybeNum,
  recommended: z.boolean().default(false),
  has_sample: z.boolean().default(false),
  sample_url: z.string().nullish(),
  active: z.boolean().default(false),
  created_at: iso.nullish(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

export const REVERBS = ['none', 'light', 'medium', 'heavy'] as const;
export type Reverb = (typeof REVERBS)[number];
export const coverSettingsSchema = z.object({
  octave_auto: z.boolean(),
  semitones: z.number().int(),
  timbre_strength: z.number().min(0).max(1),
  protect: z.number().min(0).max(0.5),
  vocal_level: z.number().min(0).max(2),
  reverb: z.enum(REVERBS).catch('light'),
});
export type CoverSettings = z.infer<typeof coverSettingsSchema>;

export const COVER_TRACKS = ['original', 'mix', 'vocal', 'backing', 'mp3'] as const;
export type CoverTrack = (typeof COVER_TRACKS)[number];
const audioUrl = z.string().nullish().transform((v) => v ?? null);
export const coverAudioSchema = z.object({
  mix: audioUrl, mp3: audioUrl, vocal: audioUrl, backing: audioUrl, original: audioUrl,
});
export type CoverAudio = z.infer<typeof coverAudioSchema>;

export const coverSchema = z.object({
  id,
  singer_id: id,
  checkpoint_id: z.string().nullish(),
  job_id: z.string().nullish(),
  status: jobStatusSchema.catch('queued'),
  settings: coverSettingsSchema.nullish(),
  created_at: iso.nullish(),
  audio: coverAudioSchema.default({ mix: null, mp3: null, vocal: null, backing: null, original: null }),
});
export type Cover = z.infer<typeof coverSchema>;

/** The converted mix exists: the cover can be played. */
export function coverReady(cover: Cover): boolean {
  return cover.audio.mix !== null;
}

export const STAGE_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'] as const;
export const stageStatusSchema = z.enum(STAGE_STATUSES);
export type StageStatus = z.infer<typeof stageStatusSchema>;

export const jobStageSchema = z.object({
  name: z.string(),
  position: z.number().int().nonnegative().nullish(),
  status: stageStatusSchema.catch('pending'),
  started_at: iso.nullish(),
  finished_at: iso.nullish(),
  attempts: z.number().int().nonnegative().default(0),
  outputs: z.record(z.string(), z.unknown()).default({}),
});
export type JobStage = z.infer<typeof jobStageSchema>;

export const JOB_TYPES = ['prepare_dataset', 'train', 'convert', 'analyze'] as const;
export const jobSchema = z.object({
  id,
  type: z.string(),
  status: jobStatusSchema,
  singer_id: z.string().nullish(),
  singer_name: z.string().nullish(),
  label: z.string().nullish(),
  run_id: z.string().nullish(),
  cover_id: z.string().nullish(),
  analysis_id: z.string().nullish(),
  params: z.record(z.string(), z.unknown()).default({}),
  resume: z.boolean().nullish(),
  error_code: z.string().nullish(),
  created_at: iso.nullish(),
  started_at: iso.nullish(),
  finished_at: iso.nullish(),
  stages: z.array(jobStageSchema).default([]),
});
export type Job = z.infer<typeof jobSchema>;

/** POST /singers/{id}/train answers with the queued job and the run it will fill. */
export const trainStartedSchema = z.object({ job: jobSchema, run: runSchema });
export type TrainStarted = z.infer<typeof trainStartedSchema>;

export const voiceImportSchema = z.object({ run: runSchema, checkpoint: checkpointSchema });
export type VoiceImport = z.infer<typeof voiceImportSchema>;

export const gpuSchema = z.object({
  available: z.boolean(),
  name: z.string().nullish(),
  driver: z.string().nullish(),
  mem_total_mb: maybeNum,
  mem_used_mb: maybeNum,
  temp_c: maybeNum,
  util: maybeNum,
});
export type Gpu = z.infer<typeof gpuSchema>;

export const doctorCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  ok: z.boolean(),
  detail: z.string().nullish(),
  hint: z.string().nullish(),
});
export const doctorSchema = z.object({
  checks: z.array(doctorCheckSchema),
  ok: z.boolean(),
});
export type Doctor = z.infer<typeof doctorSchema>;
export type DoctorCheck = z.infer<typeof doctorCheckSchema>;

export const benchmarkRowSchema = z.object({
  stage: z.string(),
  label: z.string(),
  seconds: z.number(),
  audio_seconds: maybeNum,
  rtf: maybeNum,
  peak_vram_mb: maybeNum,
  note: z.string().nullish(),
});
export const benchmarksSchema = z.object({
  measured_at: iso.nullish(),
  rows: z.array(benchmarkRowSchema).default([]),
});
export type BenchmarkRow = z.infer<typeof benchmarkRowSchema>;
export type Benchmarks = z.infer<typeof benchmarksSchema>;

/* ---------- analyses (docs/06 "Analyses") ---------- */

export const LANGUAGE_HINTS = ['auto', 'bal', 'ur', 'fa', 'en'] as const;
export type LanguageHint = (typeof LANGUAGE_HINTS)[number];
const share = z.number().min(0).max(1);

export const lyricLineSchema = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string() });
export type LyricLine = z.infer<typeof lyricLineSchema>;

export const lyricsSchema = z.object({
  /** bal | ur | fa | en; null for an instrumental analysed in auto mode */
  language: z.string().nullish(),
  /** auto mode: the decoder's confidence share among ur / fa / en */
  language_probability: share.nullish(),
  /** Balochi is transcribed with Urdu: a rough draft */
  approximate: z.boolean().default(false),
  device: z.string().nullish(),
  fallback: z.string().nullish(),
  note: z.string().nullish(),
  segments: z.array(lyricLineSchema).default([]),
});
export type Lyrics = z.infer<typeof lyricsSchema>;

export const tagScoreSchema = z.object({ label: z.string(), score: share });
export type TagScore = z.infer<typeof tagScoreSchema>;

export const styleSchema = z.object({
  tempo_bpm: z.number(),
  tempo_confidence: share,
  key: z.string(),
  scale: z.string(),
  key_confidence: share,
  loudness_dbfs: z.number(),
  loudness_lufs: z.number().nullish(),
  instruments: z.object({
    stems: z.record(z.string(), z.number()).default({}),
    tags: z.array(tagScoreSchema).default([]),
  }),
  genre: z.array(tagScoreSchema).default([]),
  mood: z.array(tagScoreSchema).default([]),
});
export type Style = z.infer<typeof styleSchema>;

export const SECTION_LABELS = ['intro', 'verse', 'chorus', 'instrumental', 'outro'] as const;
export type SectionLabel = (typeof SECTION_LABELS)[number];
export const sectionSchema = z.object({
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  label: z.enum(SECTION_LABELS).catch('verse'),
  has_vocals: z.boolean(),
  vocal_share: share.default(0),
});
export type Section = z.infer<typeof sectionSchema>;

/** Filled stage by stage: every part is null until its stage is done. */
export const analysisResultSchema = z.object({
  duration_s: z.number().nullish(),
  lyrics: lyricsSchema.nullish(),
  style: styleSchema.nullish(),
  sections: z.array(sectionSchema).nullish(),
});
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export const ANALYSIS_TRACKS = ['original', 'vocals', 'accompaniment'] as const;
export type AnalysisTrack = (typeof ANALYSIS_TRACKS)[number];

export const analysisSchema = z.object({
  id,
  job_id: z.string().nullish(),
  status: jobStatusSchema.catch('queued'),
  original_filename: z.string(),
  created_at: iso.nullish(),
  language_hint: z.enum(LANGUAGE_HINTS).catch('auto'),
  result: z.preprocess((v) => v ?? {}, analysisResultSchema),
  lyrics_text: z.string().nullish(),
  audio: z.object({ original: audioUrl, vocals: audioUrl, accompaniment: audioUrl })
    .default({ original: null, vocals: null, accompaniment: null }),
});
export type Analysis = z.infer<typeof analysisSchema>;
