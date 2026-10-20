/**
 * Mock handlers for /api/analyses (docs/06 "Analyses"). Each analysis owns an `analyze`
 * mock job; its result fills in part by part as that job's stages finish, the way the
 * worker writes it. One finished analysis is seeded, from a real run's recorded result.
 */
import { http, HttpResponse } from 'msw';
import type { Analysis, AnalysisResult } from '@/api/schemas';
import { ANALYSIS_TRACKS, LANGUAGE_HINTS } from '@/api/schemas';
import { REAL_RESULT } from '@/test/fixtures/analysisResult';
import { synthWav } from './audio';
import { audio } from './models';
import { getMockJob, mockClock, mockJobStatus, registerMockJob, snapshot } from './jobRegistry';
import { fail, forbidden, hasXrw, invalid, list, notFound, ok, readBody } from './respond';
import { findUpload, nextId } from './store';

export const SEEDED_ANALYSIS = 'ana-laila';
const SEEDED_JOB = 'job-ana-laila';
const MAX_LYRICS = 50_000;
const SONG_SECONDS = Math.ceil(REAL_RESULT.duration_s ?? 60);

interface AnalysisRecord {
  id: string;
  jobId: string;
  filename: string;
  language: Analysis['language_hint'];
  createdAt: string;
  lyricsText: string | null;
}

let records: AnalysisRecord[] = [];

function ensureSeed(): void {
  if (records.some((r) => r.id === SEEDED_ANALYSIS)) return;
  if (!getMockJob(SEEDED_JOB)) {
    registerMockJob({
      id: SEEDED_JOB, type: 'analyze', singerId: null, label: 'Laila (live).mp3', analysisId: SEEDED_ANALYSIS,
      startedAtMs: mockClock.now() - 2 * 86_400_000, durationMs: 20_000,
    });
  }
  records = [...records, {
    id: SEEDED_ANALYSIS, jobId: SEEDED_JOB, filename: 'Laila (live).mp3', language: 'auto',
    createdAt: new Date(mockClock.now() - 2 * 86_400_000).toISOString(), lyricsText: null,
  }];
}

export function resetAnalysisStore(): void {
  records = [];
}

/** Lyrics as the backend reports them for a language hint (Balochi: an Urdu-script draft). */
function lyricsFor(hint: Analysis['language_hint']): AnalysisResult['lyrics'] {
  const recorded = REAL_RESULT.lyrics ?? null;
  if (!recorded || hint === 'auto') return recorded;
  return { ...recorded, language: hint, language_probability: 1, approximate: hint === 'bal' };
}

/** The parts whose stages are done, like the worker's stage-by-stage writes. */
function partialResult(jobId: string, hint: Analysis['language_hint']): AnalysisResult {
  const entry = getMockJob(jobId);
  const done = new Set(entry ? snapshot(entry).stages.filter((s) => s.status === 'done').map((s) => s.name) : []);
  return {
    duration_s: done.has('separate') ? REAL_RESULT.duration_s ?? null : null,
    lyrics: done.has('lyrics') ? lyricsFor(hint) : null,
    style: done.has('style') ? REAL_RESULT.style ?? null : null,
    sections: done.has('sections') ? REAL_RESULT.sections ?? null : null,
  };
}

function toAnalysis(record: AnalysisRecord): Analysis {
  const entry = getMockJob(record.jobId);
  const status = entry ? mockJobStatus(entry) : 'done';
  const result = partialResult(record.jobId, record.language);
  const url = (track: string) => `/api/analyses/${record.id}/audio/${track}`;
  return {
    id: record.id, job_id: record.jobId, status, original_filename: record.filename, created_at: record.createdAt,
    language_hint: record.language, result, lyrics_text: record.lyricsText,
    audio: {
      original: url('original'),
      vocals: result.duration_s !== null ? url('vocals') : null,
      accompaniment: result.duration_s !== null ? url('accompaniment') : null,
    },
  };
}

function find(id: string): AnalysisRecord | undefined {
  ensureSeed();
  return records.find((r) => r.id === id);
}

async function create(request: Request): Promise<Response> {
  if (!hasXrw(request)) return forbidden();
  const body = (await readBody(request)) ?? {};
  const upload = findUpload(String(body['upload_id'] ?? ''));
  if (!upload || upload.metadata['purpose'] !== 'analysis') return fail(404, 'upload_not_found', 'Upload the song first (purpose: analysis).');
  if (upload.offset < upload.length) return fail(422, 'invalid_upload', 'The upload has not finished.');
  const language = body['language'] ?? 'auto';
  if (!(LANGUAGE_HINTS as readonly unknown[]).includes(language)) {
    return invalid([{ field: 'language', problem: `Use one of ${LANGUAGE_HINTS.join(', ')}.` }]);
  }
  ensureSeed();
  const id = nextId('ana');
  const filename = upload.metadata['filename'] ?? 'song.mp3';
  const entry = registerMockJob({ type: 'analyze', singerId: null, label: filename, analysisId: id, durationMs: 8_000 });
  const record: AnalysisRecord = {
    id, jobId: entry.job.id, filename, language: language as Analysis['language_hint'],
    createdAt: new Date().toISOString(), lyricsText: null,
  };
  records = [...records, record];
  return ok(toAnalysis(record), 202);
}

async function patch(request: Request, id: string): Promise<Response> {
  if (!hasXrw(request)) return forbidden();
  const record = find(id);
  if (!record) return notFound('Analysis', 'analysis_not_found');
  const body = await readBody(request);
  const text = body?.['lyrics_text'];
  if (text !== null && typeof text !== 'string') return invalid([{ field: 'lyrics_text', problem: 'Send text or null.' }]);
  if (typeof text === 'string' && text.length > MAX_LYRICS) return invalid([{ field: 'lyrics_text', problem: 'Too long.' }]);
  const next = { ...record, lyricsText: text };
  records = records.map((r) => (r.id === id ? next : r));
  return ok(toAnalysis(next));
}

function exportFile(id: string, format: string): Response {
  const record = find(id);
  if (!record) return notFound('Analysis', 'analysis_not_found');
  const analysis = toAnalysis(record);
  if (format === 'json') {
    return new HttpResponse(JSON.stringify(analysis, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="analysis.json"` },
    });
  }
  if (format !== 'txt') return invalid([{ field: 'format', problem: 'Use txt or json.' }]);
  const lines = analysis.lyrics_text ?? (analysis.result.lyrics?.segments ?? []).map((s) => s.text).join('\n');
  return new HttpResponse(lines ? `${lines}\n` : '', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="lyrics.txt"` },
  });
}

const TRACK_TONE: Record<string, { baseHz?: number; noise?: number; toneless?: boolean }> = {
  original: { baseHz: 165, noise: 0.35 },
  vocals: { baseHz: 196 },
  accompaniment: { noise: 0.6, toneless: true },
};

export const analysisHandlers = [
  http.get('/api/analyses', () => {
    ensureSeed();
    return list(records.map(toAnalysis).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '')));
  }),
  http.post('/api/analyses', ({ request }) => create(request)),
  http.get('/api/analyses/:id', ({ params }) => {
    const record = find(String(params['id']));
    return record ? ok(toAnalysis(record)) : notFound('Analysis', 'analysis_not_found');
  }),
  http.patch('/api/analyses/:id', ({ request, params }) => patch(request, String(params['id']))),
  http.get('/api/analyses/:id/export', ({ params, request }) =>
    exportFile(String(params['id']), new URL(request.url).searchParams.get('format') ?? 'txt')),
  http.get('/api/analyses/:id/audio/:track', ({ params, request }) => {
    const track = String(params['track']);
    if (!(ANALYSIS_TRACKS as readonly string[]).includes(track)) return notFound('Track');
    const record = find(String(params['id']));
    if (!record) return notFound('Analysis', 'analysis_not_found');
    // as long as the recorded song, so seeking to a late lyric line works in a real browser
    return audio(synthWav(`analysis:${record.id}:${track}`, { seconds: SONG_SECONDS, ...TRACK_TONE[track] }), request);
  }),
];
