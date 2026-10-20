/**
 * MSW handlers for the library side of docs/06: singers, songs, dataset QC, clips,
 * prepare/train, runs, checkpoints, covers, uploads (tus), audio and system.
 * `libraryHandlers` is what handlers.ts spreads; `resetLibraryStore` resets state.
 */
import { http, HttpResponse } from 'msw';
import type { AnyHandler } from 'msw';
import type { Clip } from '@/api/schemas';
import { ERAS, PRESETS } from '@/api/schemas';
import { registerMockJob, snapshot } from './jobRegistry';
import { modelHandlers } from './models';
import { systemHandlers } from './system';
import { tusHandlers } from './tus';
import { fail, forbidden, hasXrw, invalid, list, noContent, notFound, ok, readBody } from './respond';
import {
  addRun, addSinger, clipsOf, datasetOf, findClip, findRun, findSinger, findSong, isPrepared, listSingers, nextId,
  removeSinger, removeSong, replaceClip, replaceSong, singerBusy, songsOf, toSinger, updateSinger,
} from './store';
import { APPLIO_COMMIT, RUN_CONFIG } from './librarySeed';

import { resetAnalysisStore } from './analyses';
import { resetLibraryStore as resetStore } from './store';

/** Fresh library and analyses for the next test. */
export function resetLibraryStore(): void {
  resetStore();
  resetAnalysisStore();
}

const singerMissing = () => notFound('Singer', 'singer_not_found');

function consentFrom(value: unknown) {
  const c = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    living_consent: c['living_consent'] === true,
    estate_permission: c['estate_permission'] === true,
    notes: typeof c['notes'] === 'string' && c['notes'].trim() ? c['notes'].trim() : null,
  };
}

const singerHandlers = [
  http.get('/api/singers', () => list(listSingers())),

  http.post('/api/singers', async ({ request }) => {
    if (!hasXrw(request)) return forbidden();
    const body = await readBody(request);
    const name = typeof body?.['name'] === 'string' ? body['name'].trim() : '';
    const consent = consentFrom(body?.['consent']);
    const problems: { field: string; problem: string }[] = [];
    if (!name) problems.push({ field: 'name', problem: 'Name is required.' });
    else if (name.length > 80) problems.push({ field: 'name', problem: 'Name is longer than 80 characters.' });
    if (!consent.living_consent && !consent.estate_permission) {
      problems.push({ field: 'consent', problem: 'Confirm the singer’s consent or the estate’s permission.' });
    }
    if (problems.length > 0) return invalid(problems);
    const singer = addSinger({
      id: nextId('sgr'), name, consent, active_checkpoint_id: null, active_voice_label: null, model_count: 0,
      base_minutes: 0, fallback_status: null, prepared: false, f0: null, era_minutes: {}, created_at: new Date().toISOString(),
    });
    return ok(singer, 201);
  }),

  http.get('/api/singers/:id', ({ params }) => {
    const record = findSinger(String(params['id']));
    return record ? ok(toSinger(record)) : singerMissing();
  }),

  http.patch('/api/singers/:id', async ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const body = await readBody(request);
    const name = typeof body?.['name'] === 'string' ? body['name'].trim() : '';
    if (!name) return invalid([{ field: 'name', problem: 'Name is required.' }]);
    const next = updateSinger(String(params['id']), { name });
    return next ? ok(toSinger(next)) : singerMissing();
  }),

  http.delete('/api/singers/:id', ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const id = String(params['id']);
    const record = findSinger(id);
    if (!record) return singerMissing();
    if (singerBusy(id)) return fail(409, 'singer_busy', `${record.name} has a job running. Cancel it first.`);
    removeSinger(id);
    return noContent();
  }),
];

const songHandlers = [
  http.get('/api/singers/:id/songs', ({ params }) => {
    const id = String(params['id']);
    return findSinger(id) ? list(songsOf(id)) : singerMissing();
  }),

  http.patch('/api/songs/:id', async ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const song = findSong(String(params['id']));
    if (!song) return notFound('Song');
    const body = await readBody(request);
    const era = body?.['era'];
    if (typeof era !== 'string' || !(ERAS as readonly string[]).includes(era)) {
      return invalid([{ field: 'era', problem: `Use one of ${ERAS.join(', ')}.` }]);
    }
    const next = { ...song, era: era as (typeof ERAS)[number] };
    replaceSong(next);
    return ok(next);
  }),

  http.delete('/api/songs/:id', ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const id = String(params['id']);
    if (!findSong(id)) return notFound('Song');
    removeSong(id);
    return noContent();
  }),
];

/** `verdict=keep|reject` (the backend also accepts `kept`/`rejected`), `reason`, `limit`, `offset`. */
function filterClips(clips: Clip[], url: URL): { items: Clip[]; total: number; limit: number; offset: number } {
  const raw = url.searchParams.get('verdict');
  const verdict = raw === 'kept' ? 'keep' : raw === 'rejected' ? 'reject' : raw;
  const reason = url.searchParams.get('reason');
  const matching = clips.filter((clip) => (!verdict || clip.verdict === verdict) && (!reason || clip.reason === reason));
  const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  return { items: matching.slice(offset, offset + limit), total: matching.length, limit, offset };
}

const datasetHandlers = [
  http.get('/api/singers/:id/dataset', ({ params }) => {
    const record = findSinger(String(params['id']));
    return record ? ok(datasetOf(record)) : singerMissing();
  }),

  http.get('/api/singers/:id/clips', ({ params, request }) => {
    const id = String(params['id']);
    if (!findSinger(id)) return singerMissing();
    const page = filterClips(clipsOf(id), new URL(request.url));
    return HttpResponse.json({ data: page.items, page: { total: page.total, limit: page.limit, offset: page.offset } });
  }),

  http.patch('/api/clips/:id', async ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const clip = findClip(String(params['id']));
    if (!clip) return notFound('Clip');
    const body = await readBody(request);
    const verdict = body?.['verdict'];
    if (verdict !== 'keep' && verdict !== 'reject') return invalid([{ field: 'verdict', problem: 'Use "keep" or "reject".' }]);
    const next: Clip = { ...clip, verdict, user_override: true };
    replaceClip(next);
    return ok(next);
  }),

  http.post('/api/singers/:id/prepare', async ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const record = findSinger(String(params['id']));
    if (!record) return singerMissing();
    const body = await readBody(request);
    const preset = body?.['preset'];
    if (typeof preset !== 'string' || !(PRESETS as readonly string[]).includes(preset)) {
      return invalid([{ field: 'preset', problem: `Use one of ${PRESETS.join(', ')}.` }]);
    }
    if (songsOf(record.id).length === 0) return fail(422, 'no_songs', 'Upload at least one song before preparing.');
    if (singerBusy(record.id)) return fail(409, 'singer_busy', `${record.name} already has a job running.`);
    const entry = registerMockJob({
      type: 'prepare_dataset', singerId: record.id, singerName: record.name, label: `prepare (${preset})`,
      params: { preset }, durationMs: 40_000,
    });
    return ok(snapshot(entry), 202);
  }),

  http.post('/api/singers/:id/train', async ({ request, params }) => {
    if (!hasXrw(request)) return forbidden();
    const record = findSinger(String(params['id']));
    if (!record) return singerMissing();
    const body = (await readBody(request)) ?? {};
    if (!isPrepared(record)) return fail(422, 'dataset_not_prepared', 'Prepare the dataset before training.');
    const dataset = datasetOf(record);
    if (dataset.gate === 'dataset_too_small') {
      return fail(422, 'dataset_too_small', `Only ${dataset.usable_minutes} minutes of usable singing. Add songs to reach at least 5.`);
    }
    if (singerBusy(record.id)) return fail(409, 'singer_busy', `${record.name} already has a job running.`);
    const epochs = typeof body['epochs'] === 'number' ? Math.round(body['epochs']) : 100;
    const batch = typeof body['batch_size'] === 'number' ? Math.round(body['batch_size']) : 4;
    if (epochs < 1 || epochs > 1000) return invalid([{ field: 'epochs', problem: 'Use 1 to 1000 epochs.' }]);
    if (batch < 1 || batch > 32) return invalid([{ field: 'batch_size', problem: 'Use a batch size of 1 to 32.' }]);
    const runId = nextId('run');
    const entry = registerMockJob({
      type: 'train', singerId: record.id, singerName: record.name, label: 'training run', runId,
      params: { epochs, batch_size: batch },
      durationMs: 150_000, run: { epochs: Math.min(epochs, 60), singerSlug: record.name.split(' ')[0]?.toLowerCase() ?? 'voice' },
    });
    addRun({
      id: runId, singer_id: record.id, job_id: entry.job.id, status: 'queued',
      config: { ...RUN_CONFIG, ...body, epochs, batch_size: batch }, applio_commit: APPLIO_COMMIT, checkpoint_count: 0,
      created_at: new Date().toISOString(),
    });
    return ok({ job: snapshot(entry), run: findRun(runId) }, 202);
  }),
];

export const libraryHandlers: AnyHandler[] = [
  ...singerHandlers,
  ...songHandlers,
  ...datasetHandlers,
  ...modelHandlers,
  ...tusHandlers,
  ...systemHandlers,
];
