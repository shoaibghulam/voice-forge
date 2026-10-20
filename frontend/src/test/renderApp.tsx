/** Render the whole app (router + query client) at a path, for screen tests. */
import { render, type RenderResult } from '@testing-library/react';
import { createMemoryHistory } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { App } from '@/App';
import { createAppRouter } from '@/router';

export interface RenderAppResult extends RenderResult {
  router: ReturnType<typeof createAppRouter>;
  queryClient: QueryClient;
}

export function renderApp(path: string): RenderAppResult {
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(history);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
  const result = render(<App router={router} queryClient={queryClient} />);
  return { ...result, router, queryClient };
}
