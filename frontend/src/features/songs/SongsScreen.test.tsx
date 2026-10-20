import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';

describe('SongsScreen', () => {
  it('lists the singer’s songs with a duplicate warning', async () => {
    renderApp('/singers/sgr-arif-baloch/songs');

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('rowheader', { name: /Laila o Majnun/ })).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(12 + 2); // header + 12 songs + footer
    expect(within(table).getByText(/duplicate of Dana Pa Dana\.mp3/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Songs' })).toHaveAttribute('aria-current', 'page');
  });

  it('changes a song’s era with PATCH /songs/{id}', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH' && request.url.includes('/api/songs/')) void request.clone().json().then((b: unknown) => patches.push(b));
    });
    renderApp('/singers/sgr-arif-baloch/songs');

    const select = await screen.findByRole('combobox', { name: 'Era for Mehr Gonj.wav' });
    expect(select).toHaveValue('studio');
    await user.selectOptions(select, 'vinyl');

    await waitFor(() => expect(patches).toContainEqual({ era: 'vinyl' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Era for Mehr Gonj.wav' })).toHaveValue('vinyl'));
    server.events.removeAllListeners();
  });

  it('shows the server’s message when an upload is refused', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/uploads/', () =>
        HttpResponse.json({ error: { code: 'disk_full', message: 'Only 120 MB free on the data disk.', details: {} } }, { status: 507 })),
    );
    renderApp('/singers/sgr-arif-baloch/songs');
    await screen.findByRole('table');

    const input = screen.getByLabelText(/choose songs/i);
    await user.upload(input, new File([new Uint8Array(2048)], 'Sepat.mp3', { type: 'audio/mpeg' }));

    const alert = await screen.findByText('Only 120 MB free on the data disk.', {}, { timeout: 15_000 });
    expect(alert.closest('[role="alert"]')).toHaveTextContent(/Free some space/);
  }, 20_000);

  it('uploads a song through tus and adds it to the table', async () => {
    const user = userEvent.setup();
    renderApp('/singers/sgr-gulzar-bibi/songs');
    await screen.findByRole('table');

    await user.selectOptions(screen.getByLabelText('Era of these recordings'), 'live');
    await user.upload(screen.getByLabelText(/choose songs/i), new File([new Uint8Array(4096)], 'Dastanag.flac', { type: 'audio/flac' }));

    expect(await screen.findByText('✓ uploaded', {}, { timeout: 10_000 })).toBeInTheDocument();
    const row = await screen.findByRole('rowheader', { name: /Dastanag\.flac/ });
    expect(within(row.closest('tr') as HTMLElement).getByRole('combobox')).toHaveValue('live');
  }, 15_000);
});
