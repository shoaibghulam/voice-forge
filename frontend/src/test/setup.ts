/**
 * Vitest setup: jest-dom matchers, browser APIs jsdom lacks, a fetch-based EventSource,
 * and an MSW node server with every mock handler (reset between tests).
 */
import '@testing-library/jest-dom/vitest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { TestEventSource } from './fetchEventSource';
import { installMultipartFetch } from './multipartFetch';
import { isReducedMotion, setReducedMotion } from './motion';

// uPlot needs a real canvas; the chart's data path is tested through its buffer + summary.
vi.mock('uplot', () => ({
  default: class FakePlot {
    setData(): void {}
    setSeries(): void {}
    setSize(): void {}
    destroy(): void {}
  },
}));

// Whole-app renders (router + queries + MSW) can take over a second on a loaded machine
// when test files run in parallel; give findBy*/waitFor room so they do not flake.
configure({ asyncUtilTimeout: 3000 });

// EventSource must exist before msw's sse() handlers are constructed.
Object.defineProperty(globalThis, 'EventSource', { value: TestEventSource, writable: true, configurable: true });


Object.defineProperty(window, 'matchMedia', {
  writable: true,
  configurable: true,
  value: (query: string): MediaQueryList => ({
    matches: query.includes('prefers-reduced-motion') ? isReducedMotion() : false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

if (typeof window.HTMLMediaElement !== 'undefined') {
  window.HTMLMediaElement.prototype.play = function play() {
    return Promise.resolve();
  };
  window.HTMLMediaElement.prototype.pause = function pause() {};
}

const { server } = await import('./server');
const { resetMockJobs } = await import('./mocks/jobRegistry');
const library: Record<string, unknown> = await import('./mocks/library');

let restoreFetch: (() => void) | null = null;
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  // outermost, so MSW receives an encodable multipart body
  restoreFetch = installMultipartFetch();
});
afterEach(() => {
  cleanup();
  TestEventSource.reset();
  server.resetHandlers();
  resetMockJobs();
  setReducedMotion(false);
  const resetLibrary = library['resetLibraryStore'];
  if (typeof resetLibrary === 'function') resetLibrary();
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});
afterAll(() => {
  restoreFetch?.();
  server.close();
});
