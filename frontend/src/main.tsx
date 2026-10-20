import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import { applyTheme, readTheme } from '@/app/theme';
import '@/styles/tokens.css';
import '@/styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

const isMock = import.meta.env.MODE === 'mock' || import.meta.env.VITE_MOCK === '1';

async function enableMocks(): Promise<void> {
  if (!isMock) return;
  const { startMockWorker } = await import('@/test/mocks/browser');
  await startMockWorker();
}

applyTheme(readTheme());

enableMocks()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    container.dataset.mockError = message;
  })
  .finally(() => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
