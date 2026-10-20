import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';

describe('NewCoverScreen', () => {
  it('blocks "Make the cover" until the permissions notice is acknowledged', async () => {
    const user = userEvent.setup();
    const { router } = renderApp('/covers/new');

    const submit = await screen.findByRole('button', { name: 'Make the cover' });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/acknowledge the permissions notice/)).toBeInTheDocument();

    // upload + voice chosen, still blocked without the acknowledgement
    await user.upload(screen.getByLabelText(/Choose the song/), new File([new Uint8Array(1024)], 'Kech Makoran.mp3', { type: 'audio/mpeg' }));
    expect(await screen.findByText('✓ uploaded', {}, { timeout: 10_000 })).toBeInTheDocument();
    await user.selectOptions(await screen.findByLabelText('Singer'), 'Arif Baloch');
    expect(submit).toBeDisabled();
    expect(screen.getByText(/To continue: acknowledge the permissions notice\./)).toBeInTheDocument();

    await user.click(screen.getByLabelText(/I have the permissions above/));
    await waitFor(() => expect(submit).toBeEnabled());

    await user.click(submit);
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/covers\/cov-/));
  }, 20_000);

  it('sends the plain-named controls as the POST /covers body', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/covers') void request.clone().json().then((b: unknown) => bodies.push(b));
    });
    renderApp('/covers/new');

    await user.click(await screen.findByLabelText(/I have the permissions above/));
    await user.upload(screen.getByLabelText(/Choose the song/), new File([new Uint8Array(1024)], 'Zahirok.wav', { type: 'audio/wav' }));
    await screen.findByText('✓ uploaded', {}, { timeout: 10_000 });
    await user.selectOptions(await screen.findByLabelText('Singer'), 'Arif Baloch');
    await user.click(screen.getByRole('button', { name: 'medium' }));
    const semis = screen.getByLabelText('Semitones');
    semis.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(await screen.findByText(/also shifts the backing track/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Make the cover' }));
    await waitFor(() => expect(bodies).toHaveLength(1));
    // contract: {upload_id, singer_id, checkpoint_id?, settings: {...}}; no checkpoint chosen = active voice
    expect(bodies[0]).toEqual({
      upload_id: expect.any(String),
      singer_id: 'sgr-arif-baloch',
      settings: { octave_auto: true, semitones: 2, timbre_strength: 0.4, protect: 0.4, vocal_level: 1, reverb: 'medium' },
    });
    server.events.removeAllListeners();
  }, 20_000);
});
