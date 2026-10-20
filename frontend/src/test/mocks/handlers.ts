/** Every mock handler, in match order. Shared by the browser worker and the Node test server. */
import type { AnyHandler } from 'msw';
import { analysisHandlers } from './analyses';
import { jobHandlers } from './jobs';
import { libraryHandlers } from './library';

export const handlers: AnyHandler[] = [...jobHandlers, ...libraryHandlers, ...analysisHandlers];
