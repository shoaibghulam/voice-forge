/** Mock handlers for runs, checkpoints, voices, covers and every audio URL (contract v1). */
import { http, HttpResponse } from 'msw';
import type { Cover, CoverSettings } from '@/api/schemas';
import { COVER_TRACKS, REVERBS } from '@/api/schemas';
import { checkpointId } from '@/test/fixtures/makeRun';
import { registerMockJob } from './jobRegistry';
import { synthWav, wavResponseInit } from './audio';
import { fail, forbidden, hasXrw, invalid, list, notFound, ok, readBody } from './respond';
import {
  addCheckpoint, addCover, addRun, checkpointsOf, findCheckpoint, findCover, findRun, findSinger, findUpload,
  listCovers, nextId, runsOf, toSinger, updateSinger,
} from './store';
import { APPLIO_COMMIT } from './librarySeed';

export function audio(buffer: ArrayBuffer, request: Request): Response {
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') ?? '');
  if (!range) return HttpResponse.arrayBuffer(buffer, wavResponseInit(buffer.byteLength));
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), buffer.byteLength - 1) : buffer.byteLength - 1;
  const slice = buffer.slice(start, end + 1);
  const init = wavResponseInit(slice.byteLength);
  return HttpResponse.arrayBuffer(slice, {
    ...init, status: 206,
    headers: { ...(init.headers as Record<string, string>), 'content-range': `bytes ${start}-${end}/${buffer.byteLength}` },
  });
}

function zip(name: string, text: string): Response {
  const bytes = new TextEncoder().encode(`PK\u0003\u0004${text}\n`);
  return HttpResponse.arrayBuffer(bytes.buffer, {
    headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${name}.zip"` },
  });
}

/** Make a checkpoint the singer's active voice; answers with the updated singer. */
function selectCheckpoint(id: string): Response {
  const checkpoint = findCheckpoint(id);
  if (!checkpoint) return notFound('Checkpoint', 'checkpoint_not_found');
  const run = findRun(checkpoint.run_id);
  if (!run) return notFound('Run');
  const runs = runsOf(run.singer_id);
  const runNo = runs.length - runs.findIndex((r) => r.id === run.id);
  const singer = findSinger(run.singer_id);
  const next = updateSinger(run.singer_id, {
    active_checkpoint_id: checkpoint.id,
    active_voice_label: `run ${runNo} · epoch ${checkpoint.epoch}`,
    model_count: Math.max(1, singer?.model_count ?? 0),
  });
  return next ? ok(toSinger(next)) : notFound('Singer', 'singer_not_found');
}

/**
 * Filename of a multipart file field. Read from the raw body rather than
 * `request.formData()`, which fails under jsdom (undici builds a File from jsdom's global).
 */
async function uploadedFilename(request: Request, field: string): Promise<string | null> {
  if (!(request.headers.get('content-type') ?? '').startsWith('multipart/form-data')) return null;
  const text = await request.text();
  return new RegExp(`name="${field}"; filename="([^"]*)"`).exec(text)?.[1] ?? null;
}

async function importVoice(request: Request, singerId: string): Promise<Response> {
  if (!hasXrw(request)) return forbidden();
  if (!findSinger(singerId)) return notFound('Singer', 'singer_not_found');
  const filename = await uploadedFilename(request, 'file');
  if (filename === null) return fail(422, 'invalid_voice_zip', 'Send the voice zip as multipart form data in the "file" field.');
  if (!/\.zip$/i.test(filename) || /broken|corrupt/i.test(filename)) {
    return fail(422, 'invalid_voice_zip', 'That file is not a voice zip (it needs a .pth model, optionally with an .index).');
  }
  const runId = nextId('run');
  const now = new Date().toISOString();
  addRun({ id: runId, singer_id: singerId, job_id: null, status: 'done', config: { imported_from: filename }, applio_commit: APPLIO_COMMIT, checkpoint_count: 1, created_at: now });
  const checkpoint = {
    id: checkpointId(runId, 0), run_id: runId, epoch: 0, step: 0, mel_loss: null, similarity: null, recommended: false,
    has_sample: false, sample_url: null, active: false, created_at: now,
  };
  addCheckpoint(checkpoint);
  const singer = findSinger(singerId);
  updateSinger(singerId, { model_count: (singer?.model_count ?? 0) + 1 });
  return ok({ run: findRun(runId), checkpoint }, 201);
}

const runHandlers = [
  http.get('/api/singers/:id/runs', ({ params }) => {
    const id = String(params['id']);
    return findSinger(id) ? list(runsOf(id)) : notFound('Singer', 'singer_not_found');
  }),
  http.get('/api/runs/:id', ({ params }) => {
    const run = findRun(String(params['id']));
    return run ? ok(run) : notFound('Run');
  }),
  http.get('/api/runs/:id/checkpoints', ({ params }) => {
    const id = String(params['id']);
    if (!findRun(id)) return notFound('Run');
    return list(checkpointsOf(id));
  }),
  http.post('/api/checkpoints/:id/select', ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    return selectCheckpoint(String(params['id']));
  }),
  http.get('/api/checkpoints/:id/export', ({ params }) => {
    const checkpoint = findCheckpoint(String(params['id']));
    return checkpoint ? zip(checkpoint.id, `mock voice export for ${checkpoint.id}`) : notFound('Checkpoint', 'checkpoint_not_found');
  }),
  http.post('/api/singers/:id/voices/import', ({ request, params }) => importVoice(request, String(params['id']))),
];

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

type SettingsResult = { settings: CoverSettings } | { problems: { field: string; problem: string }[] };

/** `settings` exactly as the contract has it; ranges checked the way the backend does. */
function parseSettings(raw: unknown): SettingsResult {
  const body = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const settings: CoverSettings = {
    octave_auto: body['octave_auto'] !== false,
    semitones: num(body['semitones'], 0),
    timbre_strength: num(body['timbre_strength'], 0.4),
    protect: num(body['protect'], 0.4),
    vocal_level: num(body['vocal_level'], 1),
    reverb: REVERBS.find((r) => r === body['reverb']) ?? 'light',
  };
  const problems: { field: string; problem: string }[] = [];
  if (!Number.isInteger(settings.semitones) || settings.semitones < -12 || settings.semitones > 12) problems.push({ field: 'settings.semitones', problem: 'Use a whole number from −12 to 12.' });
  if (settings.timbre_strength < 0 || settings.timbre_strength > 1) problems.push({ field: 'settings.timbre_strength', problem: 'Use 0 to 1.' });
  if (settings.protect < 0 || settings.protect > 0.5) problems.push({ field: 'settings.protect', problem: 'Use 0 to 0.5.' });
  if (settings.vocal_level < 0 || settings.vocal_level > 2) problems.push({ field: 'settings.vocal_level', problem: 'Use 0 to 2.' });
  if (body['reverb'] !== undefined && !(REVERBS as readonly unknown[]).includes(body['reverb'])) problems.push({ field: 'settings.reverb', problem: 'Unknown reverb.' });
  return problems.length > 0 ? { problems } : { settings };
}

async function createCover(request: Request): Promise<Response> {
  if (!hasXrw(request)) return forbidden();
  const body = (await readBody(request)) ?? {};
  const upload = findUpload(String(body['upload_id'] ?? ''));
  if (!upload || upload.metadata['purpose'] !== 'cover') return fail(404, 'upload_not_found', 'Upload the song first.');
  if (upload.offset < upload.length) return fail(422, 'invalid_upload', 'The upload has not finished.');
  const singer = findSinger(String(body['singer_id'] ?? ''));
  if (!singer) return notFound('Singer', 'singer_not_found');
  const requested = typeof body['checkpoint_id'] === 'string' ? body['checkpoint_id'] : null;
  if (requested && !findCheckpoint(requested)) return notFound('Checkpoint', 'checkpoint_not_found');
  const checkpoint = requested ?? singer.active_checkpoint_id;
  if (!checkpoint) return fail(422, 'no_voice', `${singer.name} has no trained voice yet.`);
  const parsed = parseSettings(body['settings']);
  if ('problems' in parsed) return invalid(parsed.problems);
  const id = nextId('cov');
  const title = (upload.metadata['filename'] ?? 'Untitled').replace(/\.[a-z0-9]+$/i, '');
  const entry = registerMockJob({ type: 'convert', singerId: singer.id, singerName: singer.name, label: title, coverId: id, durationMs: 25_000 });
  const cover: Cover = {
    id, singer_id: singer.id, checkpoint_id: checkpoint, job_id: entry.job.id, status: 'queued',
    settings: parsed.settings, created_at: new Date().toISOString(),
    audio: { mix: null, mp3: null, vocal: null, backing: null, original: null },
  };
  addCover(cover);
  return ok(findCover(id), 202);
}

const coverHandlers = [
  http.get('/api/covers', () => list(listCovers())),
  http.post('/api/covers', ({ request }) => createCover(request)),
  http.get('/api/covers/:id', ({ params }) => {
    const cover = findCover(String(params['id']));
    return cover ? ok(cover) : notFound('Cover');
  }),
];

const TRACK_TONE: Record<string, { baseHz?: number; noise?: number; toneless?: boolean }> = {
  original: { baseHz: 165, noise: 0.35 },
  mix: { baseHz: 196, noise: 0.35 },
  mp3: { baseHz: 196, noise: 0.35 },
  vocal: { baseHz: 196 },
  backing: { noise: 0.6, toneless: true },
};

const audioHandlers = [
  http.get('/api/clips/:id/audio', ({ params, request }) =>
    audio(synthWav(`clip:${String(params['id'])}`, { seconds: 3 }), request)),
  http.get('/api/checkpoints/:id/sample', ({ params, request }) => {
    const id = String(params['id']);
    const epoch = Number(/-ep(\d+)$/.exec(id)?.[1] ?? 0);
    // later checkpoints drift toward the singer's pitch, so A/B is audible
    return audio(synthWav(`sample:${id}`, { seconds: 6, baseHz: 150 + Math.min(46, epoch * 1.5), noise: Math.max(0, 0.3 - epoch * 0.01) }), request);
  }),
  http.get('/api/covers/:id/audio/:track', ({ params, request }) => {
    const track = String(params['track']);
    if (!(COVER_TRACKS as readonly string[]).includes(track)) return notFound('Track');
    const cover = findCover(String(params['id']));
    if (!cover) return notFound('Cover');
    if (track !== 'original' && cover.audio.mix === null) return fail(409, 'not_ready', 'The cover is still converting.');
    return audio(synthWav(`cover:${cover.id}:${track}`, { seconds: 8, ...TRACK_TONE[track] }), request);
  }),
];

export const modelHandlers = [...runHandlers, ...coverHandlers, ...audioHandlers];
