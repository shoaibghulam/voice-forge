/**
 * tus 1.0.0 server mock at /api/uploads/ (docs/06: tuspyserver router). Enough of the
 * protocol for tus-js-client: creation (POST), offset probe (HEAD), append (PATCH).
 * The final PATCH validates the file the way the backend does and, for
 * purpose=dataset, adds the song to the singer.
 */
import { http, HttpResponse } from 'msw';
import type { Era, Song } from '@/api/schemas';
import { ERAS } from '@/api/schemas';
import { hashUnit } from './audio';
import { fail, forbidden, hasXrw } from './respond';
import { addSong, findSinger, findUpload, nextId, putUpload, songsOf, type UploadRecord } from './store';

const TUS = { 'Tus-Resumable': '1.0.0' };
const MAX_BYTES = 1024 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|opus|aac)$/i;

function decodeBase64(value: string): string {
  try {
    const binary = atob(value);
    return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  } catch {
    return '';
  }
}

export function parseMetadata(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ');
    if (key) out[key] = value ? decodeBase64(value) : '';
  }
  return out;
}

function withTus(response: Response): Response {
  response.headers.set('Tus-Resumable', '1.0.0');
  return response;
}

function codecOf(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = { mp3: 'mp3', wav: 'pcm_s16le', flac: 'flac', m4a: 'aac', aac: 'aac', ogg: 'vorbis', opus: 'opus' };
  return map[ext] ?? ext;
}

/** Validate a finished upload; returns an error response or null. */
function finalize(upload: UploadRecord): Response | null {
  const filename = upload.metadata['filename'] ?? 'upload';
  if (!AUDIO_EXT.test(filename)) return withTus(fail(415, 'not_audio', `"${filename}" is not an audio file.`));
  if (/short/i.test(filename)) return withTus(fail(422, 'bad_duration', `"${filename}" is 12 seconds long; songs must be 20 s to 20 min.`));
  if (/broken|corrupt/i.test(filename)) return withTus(fail(422, 'unreadable_audio', `"${filename}" could not be decoded.`));
  if (upload.metadata['purpose'] !== 'dataset') return null;
  const singerId = upload.metadata['singer_id'] ?? '';
  const era = (ERAS as readonly string[]).includes(upload.metadata['era'] ?? '') ? (upload.metadata['era'] as Era) : 'unknown';
  const sameName = songsOf(singerId).find((s) => s.original_filename === filename);
  const bySize = upload.length / 16_000;
  const song: Song = {
    id: nextId('song'),
    singer_id: singerId,
    original_filename: filename,
    duration_s: Math.round(bySize >= 20 ? Math.min(1200, bySize) : 150 + 150 * hashUnit(filename)),
    codec: codecOf(filename),
    bitrate: codecOf(filename) === 'mp3' ? 128 : null,
    era,
    status: 'uploaded',
    duplicate_of: sameName?.id ?? null,
    created_at: new Date().toISOString(),
  };
  addSong(song);
  return null;
}

function create(request: Request): Response {
  if (!hasXrw(request)) return withTus(forbidden());
  const length = Number(request.headers.get('upload-length'));
  if (!Number.isFinite(length) || length < 0) return withTus(fail(422, 'invalid_upload', 'Upload-Length is missing.'));
  if (length > MAX_BYTES) return withTus(fail(413, 'file_too_large', 'Files are limited to 1024 MB.'));
  const metadata = parseMetadata(request.headers.get('upload-metadata'));
  if (!['dataset', 'cover', 'analysis'].includes(metadata['purpose'] ?? '')) {
    return withTus(fail(422, 'invalid_upload', 'Upload metadata needs purpose "dataset", "cover" or "analysis".'));
  }
  if (metadata['purpose'] === 'dataset' && !findSinger(metadata['singer_id'] ?? '')) {
    return withTus(fail(404, 'singer_not_found', 'That singer does not exist.'));
  }
  const id = nextId('upl');
  putUpload({ id, length, offset: 0, metadata, createdAt: new Date().toISOString() });
  return new HttpResponse(null, { status: 201, headers: { ...TUS, Location: `/api/uploads/${id}` } });
}

async function append(request: Request, id: string): Promise<Response> {
  if (!hasXrw(request)) return withTus(forbidden());
  const upload = findUpload(id);
  if (!upload) return withTus(fail(404, 'not_found', 'Upload not found.'));
  const offset = Number(request.headers.get('upload-offset'));
  if (offset !== upload.offset) return withTus(fail(409, 'offset_mismatch', `Expected offset ${upload.offset}.`));
  const body = await request.arrayBuffer();
  const next = { ...upload, offset: Math.min(upload.length, upload.offset + body.byteLength) };
  if (next.offset === next.length) {
    const error = finalize(next);
    if (error) return error;
  }
  putUpload(next);
  return new HttpResponse(null, { status: 204, headers: { ...TUS, 'Upload-Offset': String(next.offset) } });
}

export const tusHandlers = [
  http.options('/api/uploads/*', () =>
    new HttpResponse(null, {
      status: 204,
      headers: { ...TUS, 'Tus-Version': '1.0.0', 'Tus-Extension': 'creation,termination', 'Tus-Max-Size': String(MAX_BYTES) },
    })),
  http.post('/api/uploads', ({ request }) => create(request)),
  http.post('/api/uploads/', ({ request }) => create(request)),
  http.head('/api/uploads/:uploadId', ({ params }) => {
    const upload = findUpload(String(params['uploadId']));
    if (!upload) return new HttpResponse(null, { status: 404, headers: TUS });
    return new HttpResponse(null, {
      status: 200,
      headers: { ...TUS, 'Upload-Offset': String(upload.offset), 'Upload-Length': String(upload.length), 'Cache-Control': 'no-store' },
    });
  }),
  http.patch('/api/uploads/:uploadId', ({ request, params }) => append(request, String(params['uploadId']))),
  http.delete('/api/uploads/:uploadId', () => new HttpResponse(null, { status: 204, headers: TUS })),
];
