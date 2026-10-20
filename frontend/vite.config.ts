import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { msw } from 'msw/vite';

const BACKEND = 'http://127.0.0.1:8000';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    // Mock mode (`npm run dev:mock`) serves the MSW service worker script; nothing else.
    ...(mode === 'mock' ? [msw({ mode: 'worker-only' })] : []),
  ],
  resolve: {
    alias: {
      // Keep in sync with the `paths` entry in tsconfig.json.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/api': { target: BACKEND, changeOrigin: false },
      '/health': { target: BACKEND, changeOrigin: false },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // jsdom is a browser: use tus-js-client's browser build (XHR + File), not the Node
    // build that only accepts Buffer/Readable sources.
    alias: {
      'tus-js-client': fileURLToPath(new URL('./node_modules/tus-js-client/lib.esm/browser/index.js', import.meta.url)),
    },
    server: { deps: { inline: ['tus-js-client'] } },
  },
}));
