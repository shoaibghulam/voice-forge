import { describe, expect, it } from 'vitest';
import { elapsedSeconds, etaLabel, formatClock, formatHms, isApproximate, remainingSeconds, serverNowMs } from './eta';

describe('formatting', () => {
  it('formats stage durations compactly', () => {
    expect(formatClock(42)).toBe('0:42');
    expect(formatClock(3492)).toBe('58:12');
    expect(formatClock(4360)).toBe('1:12:40');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(59.6)).toBe('1:00');
  });

  it('formats header clocks as hh:mm:ss', () => {
    expect(formatHms(4360)).toBe('01:12:40');
    expect(formatHms(0)).toBe('00:00:00');
    expect(formatHms(100 * 3600)).toBe('100:00:00');
  });
});

describe('ETA', () => {
  const eta = { jobEtaS: 2890, method: 'ema' as const, ts: '2026-10-19T12:00:00.000Z' };
  const at = (iso: string) => Date.parse(iso);

  it('marks estimates (seed, ema) as approximate and counts as firm', () => {
    expect(isApproximate('ema')).toBe(true);
    expect(isApproximate('seed')).toBe(true);
    expect(isApproximate('count')).toBe(false);
  });

  it('counts down from when the estimate was made', () => {
    expect(remainingSeconds(eta, at('2026-10-19T12:00:10.000Z'))).toBe(2880);
    expect(remainingSeconds(eta, at('2026-10-19T14:00:00.000Z'))).toBe(0);
    expect(remainingSeconds(null, 0)).toBeNull();
  });

  it('labels with ≈ for estimates only', () => {
    expect(etaLabel(eta, at('2026-10-19T12:00:00.000Z'))).toBe('≈ 00:48:10');
    expect(etaLabel({ ...eta, method: 'count' }, at('2026-10-19T12:00:00.000Z'))).toBe('00:48:10');
    expect(etaLabel(null, null)).toBe('—');
  });
});

describe('server clock', () => {
  it('advances from the newest event while live and freezes otherwise', () => {
    const clock = { lastTs: '2026-10-19T12:00:00.000Z', lastArrivalMs: 1_000 };
    expect(serverNowMs(clock, 4_000, true)).toBe(Date.parse('2026-10-19T12:00:03.000Z'));
    expect(serverNowMs(clock, 4_000, false)).toBe(Date.parse('2026-10-19T12:00:00.000Z'));
    expect(serverNowMs({ lastTs: null, lastArrivalMs: null }, 0, true)).toBeNull();
  });

  it('computes elapsed from start to finish or to server now', () => {
    expect(elapsedSeconds('2026-10-19T12:00:00.000Z', '2026-10-19T13:12:40.000Z', null)).toBe(4360);
    expect(elapsedSeconds('2026-10-19T12:00:00.000Z', null, Date.parse('2026-10-19T12:00:30.000Z'))).toBe(30);
    expect(elapsedSeconds(null, null, 0)).toBeNull();
  });
});
