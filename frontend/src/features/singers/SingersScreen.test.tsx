import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';

describe('SingersScreen', () => {
  it('renders one row per singer from the API with minutes and status', async () => {
    renderApp('/');

    const list = await screen.findByRole('list', { name: 'Singers' });
    const rows = within(list).getAllByRole('listitem').filter((li) => li.classList.contains('singer-row'));
    expect(rows).toHaveLength(3);

    expect(within(list).getByRole('link', { name: /Arif Baloch/ })).toHaveAttribute('href', '/singers/sgr-arif-baloch/songs');
    expect(within(list).getByText('27.4')).toBeInTheDocument();
    expect(within(list).getByText('too little to train')).toBeInTheDocument(); // Rahim, 3.1 min
    expect(within(list).getByText('thin — aim for 30')).toBeInTheDocument(); // Gulzar, 8.2 min
    expect(within(list).getByText('run 2 · epoch 20')).toBeInTheDocument();
    expect(within(list).getByText('running')).toBeInTheDocument();
  });

  it('validates the new-singer dialog before posting, then creates the singer', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('list', { name: 'Singers' });

    await user.click(screen.getByRole('button', { name: 'New singer' }));
    const dialog = await screen.findByRole('dialog', { name: 'New singer' });
    await user.click(within(dialog).getByRole('button', { name: 'Add singer' }));

    expect(within(dialog).getByText('Name is required.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText(/Record the singer’s consent/)).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Name'), 'Noor Jehan Baloch');
    await user.click(within(dialog).getByLabelText(/family or estate gave permission/));
    await user.click(within(dialog).getByRole('button', { name: 'Add singer' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByRole('link', { name: /Noor Jehan Baloch/ })).toBeInTheDocument();
  });

  it('shows the singer_busy error when deleting a singer with a running job', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('list', { name: 'Singers' });

    await user.click(screen.getByRole('button', { name: 'Delete Arif Baloch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Arif Baloch?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete singer' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/job running/i);
    expect(within(dialog).getByText(/Cancel it or wait for it to finish/)).toBeInTheDocument();
  });
});
