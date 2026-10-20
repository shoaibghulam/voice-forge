import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';
import { server } from '@/test/server';

describe('TrainingScreen', () => {
  it('lists runs with their checkpoint count', async () => {
    renderApp('/singers/sgr-arif-baloch/training');
    const list = await screen.findByRole('list', { name: /Training runs/ });
    expect(list).toHaveTextContent('6 checkpoints');
  });

  it('starts training and opens the live run of the job it answers with', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/train')) void request.clone().json().then((b: unknown) => bodies.push(b));
    });
    const { router } = renderApp('/singers/sgr-gulzar-bibi/training');

    await user.clear(await screen.findByLabelText('Epochs'));
    await user.type(screen.getByLabelText('Epochs'), '60');
    await user.click(screen.getByRole('button', { name: 'Start training' }));

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/jobs\/job-mock-/));
    // advanced fields left on "default" are not sent
    expect(bodies).toEqual([{ epochs: 60, batch_size: 4 }]);
    server.events.removeAllListeners();
  });

  it('refuses a singer whose dataset is too small, with a way forward', async () => {
    const user = userEvent.setup();
    renderApp('/singers/sgr-rahim-marri/training');
    await user.click(await screen.findByRole('button', { name: 'Start training' }));
    expect(await screen.findByRole('link', { name: 'Add more songs' })).toBeInTheDocument();
  });

  it('shows singer_busy while another job runs for the singer', async () => {
    const user = userEvent.setup();
    renderApp('/singers/sgr-arif-baloch/training');
    await user.click(await screen.findByRole('button', { name: 'Start training' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has a job running/);
  });

  it('validates the save interval before posting', async () => {
    const user = userEvent.setup();
    renderApp('/singers/sgr-gulzar-bibi/training');
    await user.type(await screen.findByLabelText('Save every (epochs)'), '0');
    await user.click(screen.getByRole('button', { name: 'Start training' }));
    expect(await screen.findByText(/Save every must be a whole number/)).toBeInTheDocument();
  });
});
