import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '@/test/renderApp';

describe('App shell', () => {
  it('opens straight on the singers library (no login)', async () => {
    renderApp('/');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Singers' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.queryByText(/password/i)).toBeNull();
  });

  it('shows a 404 for unknown routes', async () => {
    renderApp('/nowhere');
    expect(await screen.findByRole('heading', { name: /Nothing is patched/ })).toBeInTheDocument();
  });

  it('cycles the theme and sets data-theme on <html>', async () => {
    renderApp('/');
    const user = userEvent.setup();
    const toggle = await screen.findByRole('button', { name: /Theme: system/ });
    await user.click(toggle);
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
    await user.click(screen.getByRole('button', { name: /Theme: light/ }));
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    await user.click(screen.getByRole('button', { name: /Theme: dark/ }));
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });
});
