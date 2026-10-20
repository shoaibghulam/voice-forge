/** The MSW node server shared by setup.ts and tests (`server.use(...)` for per-test overrides). */
import { setupServer } from 'msw/node';
import { handlers } from './mocks/handlers';

export const server = setupServer(...handlers);
