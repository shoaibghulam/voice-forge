/**
 * Time maths for the live view.
 *
 * "Server now" = timestamp of the newest event + wall time since it arrived. Elapsed and
 * ETA are computed against it, so a skewed laptop clock (or the accelerated mock replay)
 * still gives numbers consistent with the stage durations the server reports.
 */
import type { EtaMethod } from '@/api/events';

const pad = (n: number) => String(n).padStart(2, '0');

/** 42 → "0:42", 3492 → "58:12", 4360 → "1:12:40". For stage durations. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** 4360 → "01:12:40". For the job header. */
export function formatHms(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Estimates (benchmark seed, EMA of epoch time) are shown with "≈"; counts are firm. */
export function isApproximate(method: EtaMethod): boolean {
  return method !== 'count';
}

export interface Clock {
  /** ts of the newest event received */
  lastTs: string | null;
  /** Date.now() when that event arrived */
  lastArrivalMs: number | null;
}

export function serverNowMs(clock: Clock, nowMs: number, isLive: boolean): number | null {
  if (!clock.lastTs) return null;
  const base = Date.parse(clock.lastTs);
  if (Number.isNaN(base)) return null;
  if (!isLive || clock.lastArrivalMs === null) return base;
  return base + Math.max(0, nowMs - clock.lastArrivalMs);
}

export function elapsedSeconds(startedTs: string | null, finishedTs: string | null, serverNow: number | null): number | null {
  if (!startedTs) return null;
  const start = Date.parse(startedTs);
  const end = finishedTs ? Date.parse(finishedTs) : serverNow;
  if (end === null || Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, (end - start) / 1000);
}

export interface EtaInput {
  jobEtaS: number | null;
  method: EtaMethod;
  ts: string;
}

/** Remaining seconds, counting down from the moment the estimate was made. */
export function remainingSeconds(eta: EtaInput | null, serverNow: number | null): number | null {
  if (!eta || eta.jobEtaS === null) return null;
  const madeAt = Date.parse(eta.ts);
  if (serverNow === null || Number.isNaN(madeAt)) return eta.jobEtaS;
  return Math.max(0, eta.jobEtaS - Math.max(0, serverNow - madeAt) / 1000);
}

export function etaLabel(eta: EtaInput | null, serverNow: number | null): string {
  const left = remainingSeconds(eta, serverNow);
  if (left === null || !eta) return '—';
  return `${isApproximate(eta.method) ? '≈ ' : ''}${formatHms(left)}`;
}
