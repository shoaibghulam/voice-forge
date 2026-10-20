import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { STAGE_STATUSES } from '@/api/schemas';
import { DigitRoll } from './DigitRoll';
import { SignalPath, type SignalNode } from './SignalPath';

const nodes: SignalNode[] = [
  { name: 'validate', label: 'validate', status: 'done', detail: '0:42' },
  { name: 'denoise', label: 'denoise', status: 'skipped', detail: 'skipped' },
  { name: 'extract', label: 'pitch + feats', status: 'failed', detail: 'failed', error: { message: 'rmvpe.pt is incomplete', hint: 'Re-download prerequisites', logTail: ['Traceback', 'RuntimeError: bad zip'] } },
  { name: 'train', label: 'train', status: 'running', detail: 'ep 3/40' },
  { name: 'index', label: 'index', status: 'pending', detail: null },
];

describe('SignalPath', () => {
  it('renders an ordered list with one item per stage and every status as text', () => {
    render(<SignalPath nodes={nodes} isLive />);
    const list = screen.getByRole('list', { name: 'Pipeline stages' });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items.map((li) => li.getAttribute('data-status'))).toEqual(['done', 'skipped', 'failed', 'running', 'pending']);
    expect(items[0]).toHaveTextContent('validate0:42, done');
    expect(items[1]).toHaveTextContent(', skipped');
    expect(items[2]).toHaveTextContent(', failed');
    expect(items[4]).toHaveTextContent(', waiting');
  });

  it.each(STAGE_STATUSES)('renders a lone %s stage', (status) => {
    render(<SignalPath nodes={[{ name: 's', label: 's', status }, { name: 't', label: 't', status: 'pending' }]} isLive />);
    expect(screen.getAllByRole('listitem')[0]).toHaveAttribute('data-status', status);
  });

  it('marks only the running stage with aria-current="step"', () => {
    render(<SignalPath nodes={nodes} isLive />);
    const current = screen.getAllByRole('listitem').filter((li) => li.getAttribute('aria-current') === 'step');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('train');
  });

  it('runs a pulse on the running cable only while live', () => {
    const { rerender } = render(<SignalPath nodes={nodes} isLive />);
    expect(screen.getAllByTestId('sp-pulse')).toHaveLength(1);
    rerender(<SignalPath nodes={nodes} isLive={false} />);
    expect(screen.queryByTestId('sp-pulse')).toBeNull();
  });

  it('turns the failed cable red and opens the error card with hint, log tail and retry', async () => {
    const onRetry = vi.fn();
    const { container } = render(<SignalPath nodes={nodes} isLive onRetry={onRetry} />);
    expect(container.querySelector('[data-status="failed"] .sp-cable')).toHaveAttribute('data-state', 'fail');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('pitch + feats failed');
    expect(alert).toHaveTextContent('rmvpe.pt is incomplete');
    expect(alert).toHaveTextContent('Re-download prerequisites');
    expect(within(alert).getByLabelText('Last log lines')).toHaveTextContent('RuntimeError: bad zip');
    await userEvent.click(within(alert).getByRole('button', { name: 'Retry stage' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows no error card in the mini variant', () => {
    render(<SignalPath nodes={nodes} isLive size="mini" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('reduced motion', () => {
  it('replaces pulses and breathing rings with static states', () => {
    const { container } = render(<SignalPath nodes={nodes} isLive isReducedMotion />);
    expect(container.querySelector('.signal-path')).toHaveAttribute('data-motion', 'reduced');
    expect(screen.queryByTestId('sp-pulse')).toBeNull();
    expect(container.querySelector('.sp-ring')).toBeNull();
    // state is still all visible
    expect(screen.getAllByRole('listitem').find((li) => li.getAttribute('aria-current') === 'step')).toBeDefined();
    expect(container.querySelector('[data-status="running"] .sp-cable')).toHaveAttribute('data-state', 'live');
  });

  it('matches the reduced-motion snapshot', () => {
    const { container } = render(<SignalPath nodes={nodes.slice(0, 4)} isLive isReducedMotion />);
    expect(container.querySelector('ol')).toMatchSnapshot();
  });

  it('renders digit rolls as plain text', () => {
    const { container, rerender } = render(<DigitRoll value={7} minDigits={2} isReducedMotion />);
    expect(container.textContent).toBe('07');
    expect(container.querySelector('.digit-roll-column')).toBeNull();
    rerender(<DigitRoll value={34} />);
    expect(screen.getByRole('img', { name: '34' })).toBeInTheDocument();
    expect(container.querySelectorAll('.digit-roll-column')).toHaveLength(2);
  });
});
