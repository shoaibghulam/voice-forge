/** Mock mode (`npm run dev:mock`): MSW service worker serving fixtures and the SSE replay. */
import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';
import { seedJobs } from './seedJobs';

/** `VITE_DEMO_MS` shortens the demo run (the E2E suite uses a few seconds). */
function demoDurationMs(): number | undefined {
  const raw = Number(import.meta.env.VITE_DEMO_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export async function startMockWorker(): Promise<void> {
  const duration = demoDurationMs();
  seedJobs(duration ? { demoDurationMs: duration } : {});
  const worker = setupWorker(...handlers);
  await worker.start({
    quiet: true,
    onUnhandledFrame: 'bypass',
    serviceWorker: { url: '/mockServiceWorker.js' },
  });
}
