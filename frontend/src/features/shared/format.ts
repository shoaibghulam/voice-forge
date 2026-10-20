/** Formatting and tone helpers shared by the library screens. */

export type Tone = 'signal' | 'ok' | 'warn' | 'fail' | 'accent' | undefined;

/** 0:42, 4:07, 1:02:10 */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  return minutes.toFixed(1);
}

export const MIN_MINUTES = 5;
export const WARN_MINUTES = 10;
export const TARGET_MINUTES = 30;

/** Tone for usable minutes: < 5 fail, < 10 warn. */
export function minutesTone(minutes: number | null | undefined): Tone {
  if (minutes === null || minutes === undefined) return undefined;
  if (minutes < MIN_MINUTES) return 'fail';
  if (minutes < WARN_MINUTES) return 'warn';
  return 'ok';
}

export function minutesNote(minutes: number | null | undefined): string {
  const tone = minutesTone(minutes);
  if (tone === 'fail') return 'too little to train';
  if (tone === 'warn') return 'thin — aim for 30';
  if (tone === 'ok') return minutes !== null && minutes !== undefined && minutes >= TARGET_MINUTES ? 'target reached' : 'enough to train';
  return 'not measured';
}

export function statusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'running': return 'signal';
    case 'done': return 'ok';
    case 'failed': return 'fail';
    case 'paused':
    case 'pausing':
    case 'cancelling': return 'warn';
    case 'cancelled': return undefined;
    case 'queued': return 'accent';
    default: return undefined;
  }
}

const STATUS_ICON: Record<string, string> = {
  running: '◉', done: '✓', failed: '✕', pausing: '❚❚', paused: '❚❚', cancelling: '–', cancelled: '–', queued: '…',
};

export function statusIcon(status: string): string {
  return STATUS_ICON[status] ?? '·';
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function jobTypeLabel(type: string): string {
  if (type === 'prepare_dataset') return 'prepare dataset';
  if (type === 'convert') return 'cover';
  return type.replace(/_/g, ' ');
}

/** Read a JSON error envelope from raw text; null if it is not one. */
export function parseEnvelopeError(text: string): { code: string; message: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') return null;
    const error = (value as { error?: unknown }).error;
    if (error === null || typeof error !== 'object') return null;
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code !== 'string' || typeof message !== 'string') return null;
    return { code, message };
  } catch {
    return null;
  }
}
