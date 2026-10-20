/**
 * Fetch wrapper for the backend envelope (docs/06 "Response envelope").
 *
 *   success  { "data": ... }                         → schema-validated data
 *   list     { "data": [...], "page": {...} }        → { items, page }
 *   failure  { "error": { code, message, details } } → throws ApiError
 *
 * Single-user local app: no auth, no cookies. Mutating requests carry
 * `X-Requested-With: music-trainer`, which the backend requires as a cross-site guard.
 */
import { z } from 'zod';

export const API_BASE = '/api';
export const XRW_HEADER = 'X-Requested-With';
export const XRW_VALUE = 'music-trainer';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).nullish(),
  }),
});

export const pageSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});
export type Page = z.infer<typeof pageSchema>;

export interface ListResult<T> {
  items: T[];
  page: Page;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  signal?: AbortSignal;
}

export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers[XRW_HEADER] = XRW_VALUE;
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (isForm) {
      body = options.body as FormData;
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = body;
  if (options.signal) init.signal = options.signal;
  try {
    return await fetch(apiUrl(path), init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError('network_error', 'Could not reach the Music Trainer server.', 0);
  }
}

async function readJson(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('bad_response', `The server sent a response that is not JSON (${response.status}).`, response.status);
  }
}

function toError(response: Response, json: unknown): ApiError {
  const parsed = errorEnvelope.safeParse(json);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(code, message, response.status, details ?? {});
  }
  // FastAPI's own errors ({detail: ...}) before the envelope handler runs.
  const detail = z.object({ detail: z.unknown() }).safeParse(json);
  const message = detail.success && typeof detail.data.detail === 'string'
    ? detail.data.detail
    : `Request failed (${response.status}).`;
  return new ApiError(`http_${response.status}`, message, response.status);
}

function validate<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue ? `${issue.path.join('.')}: ${issue.message}` : 'schema mismatch';
  throw new ApiError('bad_response', `Unexpected response from ${path} (${where}).`, 200);
}

/** Request an endpoint that answers `{data: T}`. */
export async function api<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  const json = await readJson(response);
  if (!response.ok) throw toError(response, json);
  const envelope = z.object({ data: z.unknown() }).safeParse(json);
  if (!envelope.success) throw new ApiError('bad_response', `Missing "data" in response from ${path}.`, response.status);
  return validate(schema, envelope.data.data, path);
}

/** Request an endpoint that answers `{data: T[], page}`. */
export async function apiList<T>(path: string, item: z.ZodType<T>, options: RequestOptions = {}): Promise<ListResult<T>> {
  const response = await send(path, options);
  const json = await readJson(response);
  if (!response.ok) throw toError(response, json);
  const parsed = z.object({ data: z.array(z.unknown()), page: pageSchema.optional() }).safeParse(json);
  if (!parsed.success) throw new ApiError('bad_response', `Malformed list response from ${path}.`, response.status);
  const items = validate(z.array(item), parsed.data.data, path);
  const page = parsed.data.page ?? { total: items.length, limit: items.length, offset: 0 };
  return { items, page };
}

/** Mutations whose response body the UI does not need. */
export async function apiVoid(path: string, options: RequestOptions = {}): Promise<void> {
  const response = await send(path, { method: 'POST', ...options });
  const json = await readJson(response);
  if (!response.ok) throw toError(response, json);
}
