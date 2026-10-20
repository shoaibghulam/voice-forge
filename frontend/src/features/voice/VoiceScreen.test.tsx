import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';

function recordPosts(pathPart: string): string[] {
  const seen: string[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && request.url.includes(pathPart)) seen.push(new URL(request.url).pathname);
  });
  return seen;
}

describe('VoiceScreen', () => {
  it('exports the active checkpoint by id', async () => {
    renderApp('/singers/sgr-arif-baloch/voice');
    const link = await screen.findByRole('link', { name: 'Export epoch 20 (.zip)' });
    expect(link).toHaveAttribute('href', '/api/checkpoints/run-arif-2-ep20/export');
  });

  it('makes a checkpoint the active voice through POST /checkpoints/{id}/select', async () => {
    const user = userEvent.setup();
    const posts = recordPosts('/select');
    renderApp('/singers/sgr-arif-baloch/voice');

    expect(await screen.findByRole('button', { name: '✓ Epoch 20 is the active voice' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Use epoch 30 as active voice' }));

    expect(await screen.findByRole('button', { name: '✓ Epoch 30 is the active voice' })).toBeDisabled();
    expect(posts).toEqual(['/api/checkpoints/run-arif-2-ep30/select']);
    server.events.removeAllListeners();
  });

  it('imports a voice zip into this singer', async () => {
    const user = userEvent.setup();
    const posts = recordPosts('/voices/import');
    const { container } = renderApp('/singers/sgr-arif-baloch/voice');
    await screen.findByRole('button', { name: 'Import voice zip' });

    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*="zip"]');
    if (!input) throw new Error('no zip input');
    await user.upload(input, new File([new Uint8Array(64)], 'arif-notebook.zip', { type: 'application/zip' }));

    expect(await screen.findByText('✓ imported arif-notebook.zip')).toBeInTheDocument();
    expect(posts).toEqual(['/api/singers/sgr-arif-baloch/voices/import']);
    server.events.removeAllListeners();
  });

  it('shows invalid_voice_zip from the server', async () => {
    const user = userEvent.setup();
    const { container } = renderApp('/singers/sgr-arif-baloch/voice');
    await screen.findByRole('button', { name: 'Import voice zip' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*="zip"]');
    if (!input) throw new Error('no zip input');
    await user.upload(input, new File([new Uint8Array(8)], 'broken.zip', { type: 'application/zip' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not a voice zip/));
  });
});
