/**
 * MSW replays a generated train run (contract v1: training is its own job, six stages)
 * over SSE into the real live view, through the real EventSource → zod → reducer/ring-buffer path.
 */
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { registerMockJob, type MockJob } from '@/test/mocks/jobRegistry';
import { SINGER_ARIF } from '@/test/mocks/ids';
import { TestEventSource } from '@/test/fetchEventSource';
import { renderApp } from '@/test/renderApp';

const EPOCHS = 10;

function register(id: string, durationMs: number, extra: { failAt?: string } = {}): MockJob {
  return registerMockJob({
    id,
    type: 'train',
    singerId: SINGER_ARIF,
    singerName: 'Arif Baloch',
    label: 'training run 3',
    durationMs,
    run: { epochs: EPOCHS, seed: 5, ...extra },
  });
}

function expectedLogLines(entry: MockJob): number {
  return entry.events.reduce((n, e) => n + (e.type === 'log.lines' ? e.data.lines.length : 0), 0);
}

async function waitForEnd(): Promise<void> {
  await waitFor(() => expect(screen.getByText('ended')).toBeInTheDocument(), { timeout: 10_000 });
}

function stageItems(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Pipeline stages' })).getAllByRole('listitem');
}

describe('live run view', () => {
  it('replays a whole run and lands in the final state', async () => {
    const entry = register('job-int-1', 300);
    renderApp('/jobs/job-int-1');

    expect(await screen.findByRole('heading', { name: 'Arif Baloch · training run 3' })).toBeInTheDocument();
    await waitForEnd();

    const items = stageItems();
    expect(items).toHaveLength(6);
    expect(items.every((li) => li.getAttribute('data-status') === 'done')).toBe(true);
    expect(screen.getByText('done', { selector: '.chip' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Job progress' })).toHaveAttribute('aria-valuenow', '100');

    const checkpoints = screen.getByRole('region', { name: 'Checkpoints' });
    expect(within(checkpoints).getAllByRole('listitem').map((li) => li.querySelector('.ckpt-epoch')?.textContent)).toEqual(['ep 10', 'ep 5']);
    expect(within(checkpoints).getByText('recommended')).toBeInTheDocument();
    expect(within(checkpoints).getByRole('button', { name: 'Play sample from epoch 10' })).toBeInTheDocument();

    expect(screen.getByRole('img', { name: String(EPOCHS) })).toBeInTheDocument();
    expect(screen.getByText(`${expectedLogLines(entry).toLocaleString()} lines`)).toBeInTheDocument();
    expect(screen.getByText(/^mel loss \d+\.\d\d/)).toBeInTheDocument();
    // the stream closed after the terminal status and was not reopened
    expect(TestEventSource.instances).toHaveLength(1);
    expect(TestEventSource.instances[0]?.readyState).toBe(2);
  });

  it('shows the failed node with its error card and log tail', async () => {
    register('job-int-fail', 150, { failAt: 'extract' });
    renderApp('/jobs/job-int-fail');
    await waitForEnd();
    const failed = stageItems().find((li) => li.getAttribute('data-status') === 'failed');
    expect(failed).toHaveTextContent('pitch + feats');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('rmvpe.pt is incomplete');
    // stage.failed carries no tail in v1: the card shows the stage's own last log lines
    expect(within(alert).getByLabelText('Last log lines')).toHaveTextContent(/RuntimeError: PytorchStreamReader failed/);
    expect(within(alert).getByRole('button', { name: 'Retry stage' })).toBeInTheDocument();
    expect(screen.getByText('failed', { selector: '.chip' })).toBeInTheDocument();
  });

  it('resumes with Last-Event-ID after a dropped connection without double counting', async () => {
    const entry = register('job-int-2', 1500);
    renderApp('/jobs/job-int-2');
    await waitFor(() => expect(screen.getByText(/^[1-9][\d,]* lines/)).toBeInTheDocument(), { timeout: 5000 });

    act(() => TestEventSource.instances[0]?.drop());
    await waitForEnd();

    const resumedFrom = TestEventSource.lastEventIds.filter((id) => id !== '');
    expect(resumedFrom.length).toBeGreaterThanOrEqual(1);
    expect(Number(resumedFrom[0])).toBeGreaterThan(0);
    expect(screen.getByText(`${expectedLogLines(entry).toLocaleString()} lines`)).toBeInTheDocument();
    const checkpoints = screen.getByRole('region', { name: 'Checkpoints' });
    expect(within(checkpoints).getAllByRole('listitem')).toHaveLength(2);
    expect(stageItems().every((li) => li.getAttribute('data-status') === 'done')).toBe(true);
  });

  it('restores the full timeline after a page refresh mid-run', async () => {
    const entry = register('job-int-3', 1500);
    const first = renderApp('/jobs/job-int-3');
    await waitFor(() => expect(stageItems().filter((li) => li.getAttribute('data-status') === 'done').length).toBeGreaterThanOrEqual(3), { timeout: 5000 });
    const doneBefore = stageItems().filter((li) => li.getAttribute('data-status') === 'done').length;
    first.unmount();

    // a refresh opens a fresh EventSource without Last-Event-ID: the server replays everything
    renderApp('/jobs/job-int-3');
    await waitFor(() => {
      expect(stageItems().filter((li) => li.getAttribute('data-status') === 'done').length).toBeGreaterThanOrEqual(doneBefore);
    }, { timeout: 2000 });
    await waitForEnd();
    expect(TestEventSource.lastEventIds.slice(0, 2)).toEqual(['', '']);
    expect(screen.getByText(`${expectedLogLines(entry).toLocaleString()} lines`)).toBeInTheDocument();
    expect(stageItems().every((li) => li.getAttribute('data-status') === 'done')).toBe(true);
  });
});
