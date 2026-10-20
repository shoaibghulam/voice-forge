/**
 * tus-js-client wiring shared by song uploads and cover uploads (docs/07 "Upload").
 * Resumes a previous upload of the same file (tus keeps the URL in localStorage itself);
 * every storage touch is wrapped so private mode or blocked storage never breaks upload.
 */
import * as tus from 'tus-js-client';
import { ApiError, XRW_HEADER, XRW_VALUE } from '@/api/client';
import { describeError, type ErrorText } from '@/api/errors';
import { parseEnvelopeError } from './format';

export const UPLOAD_ENDPOINT = '/api/uploads/';
export const CHUNK_SIZE = 5 * 1024 * 1024;
export const ACCEPTED_AUDIO = '.mp3,.wav,.flac,.m4a,.ogg,.opus,.aac,audio/*';
export const AUDIO_EXTENSIONS = /\.(mp3|wav|flac|m4a|ogg|opus|aac)$/i;

export interface TusCallbacks {
  onProgress: (sent: number, total: number) => void;
  onSuccess: (uploadUrl: string | null) => void;
  onError: (error: ErrorText) => void;
}

/** Turn a tus error (maybe carrying the server's envelope) into title + help. */
export function tusErrorText(error: Error): ErrorText {
  const response = (error as tus.DetailedError).originalResponse ?? null;
  if (response) {
    let body = '';
    try {
      body = response.getBody();
    } catch {
      body = '';
    }
    const parsed = parseEnvelopeError(body);
    if (parsed) return describeError(new ApiError(parsed.code, parsed.message, response.getStatus()));
    return describeError(new ApiError(`http_${response.getStatus()}`, `Upload failed (${response.getStatus()}).`, response.getStatus()));
  }
  return describeError(new ApiError('network_error', 'The upload lost its connection to the server.', 0));
}

/** Last path segment of the upload URL is the upload id the API expects. */
export function uploadIdFrom(url: string | null): string | null {
  if (!url) return null;
  const segment = url.replace(/\/+$/, '').split('/').pop();
  return segment ? decodeURIComponent(segment) : null;
}

export function startTusUpload(file: File, metadata: Record<string, string>, callbacks: TusCallbacks): tus.Upload {
  const upload = new tus.Upload(file, {
    endpoint: UPLOAD_ENDPOINT,
    headers: { [XRW_HEADER]: XRW_VALUE },
    metadata: { filename: file.name, filetype: file.type || 'application/octet-stream', ...metadata },
    chunkSize: CHUNK_SIZE,
    retryDelays: [0, 1000, 3000, 5000],
    storeFingerprintForResuming: true,
    removeFingerprintOnSuccess: true,
    onProgress: (sent, total) => callbacks.onProgress(sent, total),
    onSuccess: () => callbacks.onSuccess(upload.url),
    onError: (error) => callbacks.onError(tusErrorText(error)),
  });
  upload
    .findPreviousUploads()
    .then((previous) => {
      const match = previous.find((p) => p.metadata['purpose'] === metadata['purpose']);
      if (match) upload.resumeFromPreviousUpload(match);
    })
    .catch(() => {
      // storage unavailable: start a fresh upload
    })
    .finally(() => upload.start());
  return upload;
}

export interface UnfinishedUpload {
  filename: string;
  size: number | null;
  createdAt: string;
}

/** Uploads interrupted by a refresh, so the screen can say "choose it again to resume". */
export async function findUnfinishedUploads(match: (metadata: Record<string, string>) => boolean): Promise<UnfinishedUpload[]> {
  try {
    const storage = tus.defaultOptions.urlStorage;
    const all = await storage.findAllUploads();
    return all
      .filter((u) => match(u.metadata))
      .map((u) => ({ filename: u.metadata['filename'] ?? 'unnamed file', size: u.size, createdAt: u.creationTime }));
  } catch {
    return [];
  }
}
