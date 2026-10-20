import { describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { server } from '@/test/server';
import { describeError } from './errors';
import { api, ApiError, apiList, apiVoid } from './client';

const item = z.object({ id: z.string() });

describe('api client', () => {
  it('unwraps {data} and validates it', async () => {
    server.use(http.get('/api/thing', () => HttpResponse.json({ data: { id: 'a', extra: 1 } })));
    await expect(api('/thing', item)).resolves.toEqual({ id: 'a' });
  });

  it('unwraps list envelopes with page info', async () => {
    server.use(http.get('/api/things', () => HttpResponse.json({ data: [{ id: 'a' }], page: { total: 9, limit: 1, offset: 0 } })));
    await expect(apiList('/things', item)).resolves.toEqual({ items: [{ id: 'a' }], page: { total: 9, limit: 1, offset: 0 } });
  });

  it('throws ApiError with the envelope code, message and status', async () => {
    server.use(http.post('/api/singers/x/train', () =>
      HttpResponse.json({ error: { code: 'dataset_too_small', message: 'Only 4.2 minutes', details: {} } }, { status: 422 })));
    const error = await api('/singers/x/train', item, { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'dataset_too_small', message: 'Only 4.2 minutes', status: 422 });
    expect(describeError(error).help).toContain('5 minutes');
  });

  it('lists invalid_request field problems as help', async () => {
    server.use(http.post('/api/singers', () => HttpResponse.json(
      { error: { code: 'invalid_request', message: 'Invalid', details: { fields: [{ field: 'name', problem: 'required' }] } } },
      { status: 422 },
    )));
    const error = await api('/singers', item, { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(describeError(error)).toEqual({ title: 'Invalid', help: 'name: required' });
  });

  it('sends X-Requested-With on mutations only', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('/api/h', ({ request }) => { seen.push(request.headers.get('x-requested-with')); return HttpResponse.json({ data: { id: 'g' } }); }),
      http.post('/api/h', ({ request }) => { seen.push(request.headers.get('x-requested-with')); return new HttpResponse(null, { status: 204 }); }),
    );
    await api('/h', item);
    await apiVoid('/h');
    expect(seen).toEqual([null, 'music-trainer']);
  });

  it('rejects responses that do not match the schema', async () => {
    server.use(http.get('/api/bad', () => HttpResponse.json({ data: { id: 5 } })));
    await expect(api('/bad', item)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('maps a FastAPI {detail} error and a network failure', async () => {
    server.use(http.get('/api/missing', () => HttpResponse.json({ detail: 'job not found' }, { status: 404 })));
    await expect(api('/missing', item)).rejects.toMatchObject({ code: 'http_404', message: 'job not found' });
    server.use(http.get('/api/down', () => HttpResponse.error()));
    await expect(api('/down', item)).rejects.toMatchObject({ code: 'network_error' });
  });
});
