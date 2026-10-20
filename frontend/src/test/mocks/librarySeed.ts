/**
 * Seed records for the mock library: three singers, their songs, QC clips, runs,
 * checkpoints and one finished cover. Pure data builders — the store owns the state.
 */
import type { Checkpoint, Clip, Cover, Era, Run, Song } from '@/api/schemas';
import type { JobStatus } from '@/api/events';
import { peaksFor } from './audio';
import { checkpointId } from '@/test/fixtures/makeRun';
import { DEMO_JOB, DEMO_RUN, DONE_JOB, DONE_RUN, SINGER_ARIF, SINGER_GULZAR, SINGER_RAHIM } from './ids';

export interface SingerRecord {
  id: string;
  name: string;
  consent: { living_consent: boolean; estate_permission: boolean; notes: string | null };
  active_checkpoint_id: string | null;
  active_voice_label: string | null;
  model_count: number;
  /** Minutes before any QC override adjustments. */
  base_minutes: number;
  /** Fallback when no mock job exists for the singer. */
  fallback_status: JobStatus | null;
  prepared: boolean;
  f0: { median: number; p05: number; p95: number } | null;
  era_minutes: Partial<Record<Era, number>>;
  created_at: string;
}

const day = (n: number) => new Date(Date.UTC(2026, 9, 19 - n, 9, 30)).toISOString();

export function seedSingers(): SingerRecord[] {
  return [
    {
      id: SINGER_ARIF, name: 'Arif Baloch',
      consent: { living_consent: false, estate_permission: true, notes: 'Permission from the family, letter dated 2026-08-02.' },
      active_checkpoint_id: checkpointId(DONE_RUN, 20), active_voice_label: 'run 2 · epoch 20',
      model_count: 1, base_minutes: 27.4, fallback_status: 'running', prepared: true,
      f0: { median: 196, p05: 131, p95: 329 },
      era_minutes: { studio: 12.1, cassette: 9.8, live: 5.5 },
      created_at: day(40),
    },
    {
      id: SINGER_GULZAR, name: 'Gulzar Bibi',
      consent: { living_consent: true, estate_permission: false, notes: null },
      active_checkpoint_id: null, active_voice_label: null,
      model_count: 0, base_minutes: 8.2, fallback_status: 'done', prepared: true,
      f0: { median: 262, p05: 196, p95: 440 },
      era_minutes: { cassette: 6.9, live: 1.3 },
      created_at: day(21),
    },
    {
      id: SINGER_RAHIM, name: 'Rahim Marri',
      consent: { living_consent: false, estate_permission: true, notes: null },
      active_checkpoint_id: null, active_voice_label: null,
      model_count: 0, base_minutes: 3.1, fallback_status: null, prepared: true,
      f0: { median: 147, p05: 110, p95: 220 },
      era_minutes: { vinyl: 3.1 },
      created_at: day(6),
    },
  ];
}

type SongSeed = [title: string, era: Era, seconds: number, codec: string, bitrate: number | null];

const ARIF_SONGS: SongSeed[] = [
  ['Laila o Majnun (Quetta 1984).mp3', 'live', 412, 'mp3', 128],
  ['Hani o Sheh Mureed.mp3', 'cassette', 365, 'mp3', 96],
  ['Dana Pa Dana.mp3', 'studio', 288, 'mp3', 192],
  ['Mehr Gonj.wav', 'studio', 301, 'pcm_s16le', null],
  ['Zahirok.flac', 'studio', 356, 'flac', null],
  ['Shabe Mahtab.m4a', 'cassette', 274, 'aac', 128],
  ['Kech Makoran.mp3', 'cassette', 330, 'mp3', 128],
  ['Sheedi Lal.mp3', 'live', 248, 'mp3', 112],
  ['Nazink.ogg', 'cassette', 219, 'vorbis', 160],
  ['Leewa (Radio Pakistan).mp3', 'studio', 391, 'mp3', 128],
  ['Dil Kasha.mp3', 'studio', 262, 'mp3', 192],
  ['Dana Pa Dana (copy).mp3', 'studio', 288, 'mp3', 192],
];
const GULZAR_SONGS: SongSeed[] = [
  ['Lolee (lullaby).mp3', 'cassette', 198, 'mp3', 96],
  ['Sepat.mp3', 'cassette', 240, 'mp3', 96],
  ['Mastani.wav', 'cassette', 205, 'pcm_s16le', null],
  ['Halo halo (wedding).m4a', 'live', 310, 'aac', 128],
  ['Zaheeri.mp3', 'cassette', 187, 'mp3', 128],
];
const RAHIM_SONGS: SongSeed[] = [
  ['Sheh Mureed (78 rpm).flac', 'vinyl', 176, 'flac', null],
  ['Kalaat.mp3', 'vinyl', 154, 'mp3', 128],
];

function songsFor(singerId: string, slug: string, seeds: SongSeed[], status: string): Song[] {
  return seeds.map(([title, era, seconds, codec, bitrate], i) => ({
    id: `song-${slug}-${String(i + 1).padStart(2, '0')}`,
    singer_id: singerId,
    original_filename: title,
    duration_s: seconds,
    codec,
    bitrate,
    era,
    status,
    duplicate_of: null,
    created_at: day(30 - i),
  }));
}

export function seedSongs(): Song[] {
  const arif = songsFor(SINGER_ARIF, 'arif', ARIF_SONGS, 'prepared').map((song) =>
    song.original_filename === 'Dana Pa Dana (copy).mp3' ? { ...song, duplicate_of: 'song-arif-03' } : song,
  );
  return [
    ...arif,
    ...songsFor(SINGER_GULZAR, 'gulzar', GULZAR_SONGS, 'prepared'),
    ...songsFor(SINGER_RAHIM, 'rahim', RAHIM_SONGS, 'prepared'),
  ];
}

const REJECT_REASONS = ['silence', 'bleed', 'other_singer', 'clipping', 'duplicate', 'noisy'] as const;

function clipsFor(singerId: string, slug: string, songs: Song[], count: number, rejectEvery: number): Clip[] {
  const own = songs.filter((s) => s.singer_id === singerId);
  const clips: Clip[] = [];
  for (let i = 0; i < count; i += 1) {
    const song = own[i % own.length];
    if (!song) break;
    const id = `clip-${slug}-${String(i + 1).padStart(3, '0')}`;
    const rejected = i % rejectEvery === 1;
    const reason = rejected ? REJECT_REASONS[Math.floor(i / rejectEvery) % REJECT_REASONS.length] ?? 'other' : null;
    clips.push({
      id,
      song_id: song.id,
      song_title: song.original_filename.replace(/\.[a-z0-9]+$/i, ''),
      start_s: Math.round(((i * 37) % 240) * 10) / 10,
      duration_s: 3,
      verdict: rejected ? 'reject' : 'keep',
      reason,
      user_override: false,
      scores: { voiced: rejected ? 0.42 : 0.9, clipped: rejected && i % 2 === 0 ? 0.03 : 0 },
      audio_url: `/api/clips/${id}/audio`,
      peaks: peaksFor(id),
    });
  }
  return clips;
}

export function seedClips(songs: Song[]): Clip[] {
  return [...clipsFor(SINGER_ARIF, 'arif', songs, 60, 3), ...clipsFor(SINGER_GULZAR, 'gulzar', songs, 20, 4)];
}

export const RUN_CONFIG = { save_every: 5, sample_rate: 40000, vocoder: 'HiFi-GAN' } as const;
export const APPLIO_COMMIT = '5379cf2';

export function seedRuns(): Run[] {
  return [
    {
      id: DEMO_RUN, singer_id: SINGER_ARIF, job_id: DEMO_JOB, status: 'running',
      config: { epochs: 40, batch_size: 4, ...RUN_CONFIG }, applio_commit: APPLIO_COMMIT, checkpoint_count: 0,
      created_at: new Date(Date.UTC(2026, 9, 19, 8, 0)).toISOString(),
    },
    {
      id: DONE_RUN, singer_id: SINGER_ARIF, job_id: DONE_JOB, status: 'done',
      config: { epochs: 30, batch_size: 4, ...RUN_CONFIG }, applio_commit: APPLIO_COMMIT, checkpoint_count: 6,
      created_at: day(3),
    },
  ];
}

const DONE_SIMILARITY: Record<number, number> = { 5: 0.6, 10: 0.64, 15: 0.68, 20: 0.72, 25: 0.71, 30: 0.69 };

export function seedCheckpoints(): Checkpoint[] {
  return [5, 10, 15, 20, 25, 30].map((epoch) => {
    const id = checkpointId(DONE_RUN, epoch);
    return {
      id,
      run_id: DONE_RUN,
      epoch,
      step: epoch * 160,
      mel_loss: Math.round((28 - epoch * 0.31) * 100) / 100,
      similarity: DONE_SIMILARITY[epoch] ?? null,
      recommended: epoch === 20,
      has_sample: true,
      sample_url: `/api/checkpoints/${id}/sample`,
      active: false,
      created_at: day(3),
    };
  });
}

export function seedCovers(): Cover[] {
  return [
    {
      id: 'cov-dana-pa-dana', singer_id: SINGER_ARIF,
      checkpoint_id: checkpointId(DONE_RUN, 20), job_id: null, status: 'done',
      settings: { octave_auto: true, semitones: 0, timbre_strength: 0.4, protect: 0.4, vocal_level: 1, reverb: 'light' },
      created_at: day(2),
      audio: { mix: null, mp3: null, vocal: null, backing: null, original: null },
    },
  ];
}
