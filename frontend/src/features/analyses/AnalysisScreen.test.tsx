import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';
import { SEEDED_ANALYSIS } from '@/test/mocks/analyses';

const FIRST_LINE = 'آشی ملگورا تیجو تابو کنه';

describe('AnalysesScreen', () => {
  it('lists analyses under the Analyse tab with their key facts', async () => {
    renderApp('/analyses');

    const row = await screen.findByRole('link', { name: 'Laila (live).mp3' });
    expect(row).toHaveAttribute('href', `/analyses/${SEEDED_ANALYSIS}`);
    expect(await screen.findByText('Persian · 108 BPM · A# major · pop')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Analyse' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'New analysis' })).toHaveAttribute('href', '/analyses/new');
  });
});

describe('AnalysisScreen', () => {
  it('shows the lyrics, the music style and the timeline of a finished analysis', async () => {
    renderApp(`/analyses/${SEEDED_ANALYSIS}`);

    const lines = await screen.findByRole('list', { name: 'Lyric lines' });
    expect(lines).toHaveAttribute('dir', 'rtl');
    expect(within(lines).getByText(FIRST_LINE)).toBeInTheDocument();
    expect(screen.getByText('Persian · detected, 83% sure')).toBeInTheDocument();

    const style = screen.getByRole('region', { name: 'Music style' });
    expect(within(style).getByText('108')).toBeInTheDocument();
    expect(within(style).getByText('A#')).toBeInTheDocument();
    expect(within(style).getByText('-10.8')).toBeInTheDocument();
    expect(within(style).getByRole('list', { name: 'Instruments heard' })).toHaveTextContent('dhol');
    expect(within(style).getByRole('list', { name: 'Genre, most likely first' })).toHaveTextContent('pop');
    expect(within(style).getByRole('list', { name: 'Mood, most likely first' })).toHaveTextContent('happy');
    expect(within(style).getByText(/Approximate:/)).toBeInTheDocument();

    const sections = screen.getByRole('list', { name: 'Song sections, in order' });
    expect(within(sections).getAllByRole('button')).toHaveLength(7);
    expect(within(sections).getByRole('button', { name: /^Chorus, 0:55 to 1:28, singing/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Export JSON' })).toHaveAttribute('href', `/api/analyses/${SEEDED_ANALYSIS}/export?format=json`);
    expect(screen.queryByRole('list', { name: 'Analysis stages' })).not.toBeInTheDocument();
  });

  it('seeks the player to a lyric line or a section, and marks the line being sung', async () => {
    const user = userEvent.setup();
    renderApp(`/analyses/${SEEDED_ANALYSIS}`);

    const lines = await screen.findByRole('list', { name: 'Lyric lines' });
    await user.click(within(lines).getAllByRole('button')[1] as HTMLElement);
    await waitFor(() => expect(within(lines).getAllByRole('button')[1]).toHaveAttribute('aria-current', 'true'));
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Instrumental, 0:39 to 0:55/ }));
    await waitFor(() => expect(within(lines).queryAllByRole('button', { current: true })).toHaveLength(0));
    expect(screen.getByText(/^0:39 \//)).toBeInTheDocument();
  });

  it('switches between the song and the vocals only', async () => {
    const user = userEvent.setup();
    const { container } = renderApp(`/analyses/${SEEDED_ANALYSIS}`);

    const vocals = await screen.findByRole('button', { name: 'Vocals only' });
    expect(container.querySelector('audio')).toHaveAttribute('src', `/api/analyses/${SEEDED_ANALYSIS}/audio/original`);
    await user.click(vocals);

    expect(vocals).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('audio')).toHaveAttribute('src', `/api/analyses/${SEEDED_ANALYSIS}/audio/vocals`);
  });

  it('saves corrected lyrics and can discard them again', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') void request.clone().json().then((b: unknown) => bodies.push(b));
    });
    renderApp(`/analyses/${SEEDED_ANALYSIS}`);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: /Lyrics/ });
    expect((box as HTMLTextAreaElement).value.split('\n')[0]).toBe(FIRST_LINE);
    await user.clear(box);
    await user.type(box, 'my corrected line');
    await user.click(screen.getByRole('button', { name: 'Save lyrics' }));

    expect(await screen.findByText('my corrected line')).toBeInTheDocument();
    expect(bodies).toEqual([{ lyrics_text: 'my corrected line' }]);
    expect(screen.queryByRole('list', { name: 'Lyric lines' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download .txt' })).toHaveAttribute('href', `/api/analyses/${SEEDED_ANALYSIS}/export?format=txt`);

    await user.click(screen.getByRole('button', { name: 'Discard my edit' }));
    expect(await screen.findByRole('list', { name: 'Lyric lines' })).toBeInTheDocument();
    expect(bodies).toEqual([{ lyrics_text: 'my corrected line' }, { lyrics_text: null }]);
    server.events.removeAllListeners();
  });
});

describe('NewAnalysisScreen', () => {
  it('uploads a song, sends the language and follows the analysis live', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/analyses') void request.clone().json().then((b: unknown) => bodies.push(b));
    });
    const { router } = renderApp('/analyses/new');

    const submit = await screen.findByRole('button', { name: 'Analyse the song' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Balochi' }));
    expect(screen.getByText(/rough draft in Urdu letters/)).toBeInTheDocument();
    await user.upload(screen.getByLabelText(/Choose the song/), new File([new Uint8Array(1024)], 'Kech Makoran.mp3', { type: 'audio/mpeg' }));
    expect(await screen.findByText('✓ uploaded', {}, { timeout: 10_000 })).toBeInTheDocument();
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/analyses\/ana-/));
    expect(bodies).toEqual([{ upload_id: expect.any(String), language: 'bal' }]);
    const stages = await screen.findByRole('list', { name: 'Analysis stages' });
    expect(within(stages).getAllByRole('listitem').map((li) => li.textContent?.split(',')[0]))
      .toEqual(['separate', 'lyrics', 'style', 'timeline'].map((s) => expect.stringContaining(s)));
    expect(await screen.findByRole('heading', { name: 'Kech Makoran.mp3' })).toBeInTheDocument();
    server.events.removeAllListeners();
  }, 20_000);
});
