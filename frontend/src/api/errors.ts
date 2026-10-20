/** Stable backend error codes → plain-language help (docs/06: "the UI maps them to help text"). */
import { z } from 'zod';
import { ApiError } from './client';

const HELP: Record<string, string> = {
  network_error: 'The app server is not answering. Is the backend running on 127.0.0.1:8000?',
  bad_response: 'The server answered in a shape this page does not understand. Reload; if it persists, the frontend and backend versions differ.',
  dataset_too_small: 'Training needs at least 5 minutes of usable singing. Add songs, prepare the dataset again, or keep rejected clips you trust.',
  dataset_not_prepared: 'Prepare the dataset first (Dataset tab) so clips are cleaned, sliced and checked.',
  job_running: 'A job is running for this singer. Cancel it or wait for it to finish.',
  cuda_oom: 'The GPU ran out of memory. Close other GPU apps; the worker already retried with a smaller batch.',
  missing_prerequisite: 'A model file is missing or incomplete. Open System → Doctor for the exact file.',
  unknown_job_type: 'The worker does not know this job type. The backend may be older than the frontend.',
  not_found: 'That item no longer exists.',
  singer_not_found: 'That singer no longer exists. Reload the library.',
  singer_busy: 'A job is running for this singer. Cancel it or wait for it to finish, then delete.',
  invalid_upload: 'The file could not be accepted. Songs must be audio between 20 seconds and 20 minutes.',
  bad_duration: 'Songs must be between 20 seconds and 20 minutes long.',
  file_too_large: 'Files are limited to 1 GB each.',
  not_audio: 'This file is not audio. Use MP3, WAV, FLAC, M4A, OGG, OPUS or AAC.',
  unreadable_audio: 'The audio could not be decoded. Try re-exporting it as WAV or MP3.',
  disk_full: 'The data disk is full. Free some space (System shows disk usage).',
  invalid_request: 'Some fields are not valid.',
  http_404: 'That item no longer exists.',
  http_403: 'The server refused the request (missing X-Requested-With header?).',
};

export function helpFor(code: string): string | null {
  return HELP[code] ?? null;
}

export interface ErrorText {
  title: string;
  help: string | null;
}

const fieldsSchema = z.array(z.object({ field: z.string(), problem: z.string() }));

/** `invalid_request` carries `details.fields: [{field, problem}]`; list them. */
function fieldProblems(details: Record<string, unknown>): string | null {
  const parsed = fieldsSchema.safeParse(details['fields']);
  if (!parsed.success || parsed.data.length === 0) return null;
  return parsed.data.map((f) => `${f.field}: ${f.problem}`).join('; ');
}

export function describeError(error: unknown): ErrorText {
  if (error instanceof ApiError) {
    return { title: error.message, help: fieldProblems(error.details) ?? helpFor(error.code) };
  }
  if (error instanceof Error) return { title: error.message, help: null };
  return { title: 'Something went wrong.', help: null };
}
