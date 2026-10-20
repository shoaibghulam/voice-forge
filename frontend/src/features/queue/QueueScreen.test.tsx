import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { registerMockJob } from '@/test/mocks/jobRegistry';
import { SINGER_GULZAR } from '@/test/mocks/ids';
import { renderApp } from '@/test/renderApp';

describe('QueueScreen', () => {
  it('shows an empty state when nothing runs', async () => {
    renderApp('/queue');
    expect(await screen.findByText('Nothing running or waiting')).toBeInTheDocument();
  });

  it('cancels a job after confirmation', async () => {
    const user = userEvent.setup();
    registerMockJob({ type: 'prepare_dataset', singerId: SINGER_GULZAR, singerName: 'Gulzar Bibi', label: 'prepare (cassette)', durationMs: 600_000 });
    renderApp('/queue');

    const list = await screen.findByRole('list', { name: /Jobs/ });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(1));
    expect(within(list).getByRole('link', { name: /Open live run for Gulzar Bibi/ })).toBeInTheDocument();

    await user.click(within(list).getByRole('button', { name: /Cancel Gulzar Bibi/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel this job?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel job' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // the server answers `cancelling`; the row goes once the job reaches `cancelled`
    expect(await within(list).findByRole('button', { name: /Cancel Gulzar Bibi/ })).toBeDisabled();
    expect(await screen.findByText('Nothing running or waiting', {}, { timeout: 4000 })).toBeInTheDocument();
  });
});
