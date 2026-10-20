/** Envelope helpers for the mock handlers (docs/06 "Response envelope"). */
import { HttpResponse } from 'msw';

export function ok<T>(data: T, status = 200): Response {
  return HttpResponse.json({ data } as Record<string, unknown>, { status });
}

export function list<T>(items: T[]): Response {
  return HttpResponse.json({ data: items, page: { total: items.length, limit: Math.max(50, items.length), offset: 0 } } as Record<string, unknown>);
}

export function fail(status: number, code: string, message: string, details: Record<string, unknown> = {}): Response {
  return HttpResponse.json({ error: { code, message, details } }, { status });
}

export function noContent(): Response {
  return new HttpResponse(null, { status: 204 });
}

export function hasXrw(request: Request): boolean {
  return request.headers.get('x-requested-with') === 'music-trainer';
}

export function forbidden(): Response {
  return fail(403, 'missing_csrf_header', 'Missing X-Requested-With header.');
}

export function notFound(what: string, code = 'not_found'): Response {
  return fail(404, code, `${what} not found.`);
}

/** Parse a JSON body; `null` when absent or malformed. */
export async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function invalid(fields: { field: string; problem: string }[]): Response {
  return fail(422, 'invalid_request', 'Some fields are not valid.', { fields });
}
