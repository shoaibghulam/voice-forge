import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';

function recordClipPatches(): { url: string; body: unknown }[] {
  const seen: { url: string; body: unknown }[] = [];
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'PATCH' && request.url.includes('/api/clips/')) {
      void request.clone().json().then((body: unknown) => seen.push({ url: request.url, body }));
    }
  });
  return seen;
}

describe('DatasetScreen', () => {
  it('shows the minutes gauge, era balance and vocal range', async () => {
    renderApp('/singers/sgr-arif-baloch/dataset');

    const meter = await screen.findByRole('meter', { name: 'Usable minutes' });
    expect(meter).toHaveAttribute('aria-valuenow', '27.4');
    expect(screen.getByRole('img', { name: /Median G3 \(196 Hz\)/ })).toBeInTheDocument();
    expect(screen.getByText('cassette')).toBeInTheDocument();
  });

  it('warns when one era dominates', async () => {
    renderApp('/singers/sgr-gulzar-bibi/dataset');
    expect(await screen.findByText(/of the singing is from the cassette era/)).toBeInTheDocument();
  });

  it('shows the server gate as a note (warn_small under 10 minutes)', async () => {
    renderApp('/singers/sgr-gulzar-bibi/dataset');
    expect(await screen.findByText(/Under 10 minutes: the voice may sound thin/)).toBeInTheDocument();
  });

  it('asks for clips by verdict keep|reject and reason, with a page limit', async () => {
    const urls: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'GET' && request.url.includes('/clips?')) urls.push(new URL(request.url).search);
    });
    renderApp('/singers/sgr-arif-baloch/dataset');
    await screen.findByRole('list', { name: /Clips rejected for/ });
    expect(urls[0]).toBe('?reason=silence&limit=200');
    server.events.removeAllListeners();
  });

  it('keeps and rejects a focused clip with k and r', async () => {
    const user = userEvent.setup();
    const patches = recordClipPatches();
    renderApp('/singers/sgr-arif-baloch/dataset');

    const list = await screen.findByRole('list', { name: /Clips rejected for/ });
    const first = within(list).getAllByRole('listitem')[0];
    if (!first) throw new Error('no clip rows');
    first.focus();
    await user.keyboard('k');

    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ verdict: 'keep' }));
    const kept = patches.at(-1)?.url ?? '';
    expect(await within(list).findByText('your override')).toBeInTheDocument();

    // the kept clip stays in its reason group (now with the override badge), same position
    const row = within(list).getAllByRole('listitem')[0];
    if (!row) throw new Error('clip row vanished');
    expect(row).toHaveAccessibleName(/kept, your override/);
    row.focus();
    await user.keyboard('r');
    await waitFor(() => expect(patches.at(-1)?.body).toEqual({ verdict: 'reject' }));
    expect(patches.at(-1)?.url).toBe(kept);
    server.events.removeAllListeners();
  });
});
