/** Seeds the demo jobs: one train run in progress, one finished earlier run. */
import { getMockJob, mockClock, registerMockJob } from './jobRegistry';
import { DEMO_JOB, DEMO_RUN, DONE_JOB, DONE_RUN, SINGER_ARIF } from './ids';

const START_KEY = `mt.mock.start.${DEMO_JOB}`;
/** Wall-clock length of the demo run replay. */
export const DEMO_DURATION_MS = 150_000;

/** Keep the demo's start across page refreshes so a refresh lands mid-run. */
function persistedStart(): number {
  const now = mockClock.now();
  try {
    const stored = Number(window.sessionStorage.getItem(START_KEY));
    // restart the demo once it has finished a while ago
    if (Number.isFinite(stored) && stored > 0 && now - stored < DEMO_DURATION_MS + 60_000) return stored;
    window.sessionStorage.setItem(START_KEY, String(now));
  } catch {
    // no storage: start fresh every load
  }
  return now;
}

export interface SeedOptions {
  demoDurationMs?: number;
  persist?: boolean;
}

export function seedJobs({ demoDurationMs = DEMO_DURATION_MS, persist = true }: SeedOptions = {}): void {
  if (!getMockJob(DONE_JOB)) {
    registerMockJob({
      id: DONE_JOB,
      type: 'train',
      singerId: SINGER_ARIF,
      singerName: 'Arif Baloch',
      label: 'training run 2',
      runId: DONE_RUN,
      startedAtMs: mockClock.now() - 3 * 86_400_000,
      durationMs: 60_000,
      run: { seed: 3, epochs: 30, startIso: '2026-10-16T09:00:00.000Z' },
    });
  }
  if (!getMockJob(DEMO_JOB)) {
    registerMockJob({
      id: DEMO_JOB,
      type: 'train',
      singerId: SINGER_ARIF,
      singerName: 'Arif Baloch',
      label: 'training run 3',
      runId: DEMO_RUN,
      startedAtMs: persist ? persistedStart() : mockClock.now(),
      durationMs: demoDurationMs,
      run: { seed: 11, epochs: 40 },
    });
  }
}
