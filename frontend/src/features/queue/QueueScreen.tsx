/**
 * `/queue` — running and waiting jobs. One GPU, one job at a time; the rest wait in
 * arrival order. Reordering is not offered: docs/06 has no reorder endpoint.
 */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useJobAction, useJobs } from '@/api/hooks';
import type { Job } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { ConfirmDialog } from '@/features/shared/ConfirmDialog';
import { StatusChip } from '@/features/shared/StatusChip';
import { formatDate, jobTypeLabel } from '@/features/shared/format';
import './queue.css';

const ORDER: Record<string, number> = { running: 0, pausing: 0, cancelling: 0, paused: 1, queued: 2 };
const ACTIVE = new Set(['running', 'pausing', 'cancelling']);

/** Running first, then paused, then the waiting line in arrival order (first in, first out). */
function sortJobs(jobs: Job[]): Job[] {
  return [...jobs].sort((a, b) =>
    (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)
    || (a.created_at ?? '').localeCompare(b.created_at ?? ''));
}

/** 1-based place in the waiting line, by arrival; null when the job is not waiting. */
function queuePositions(sorted: Job[]): Map<string, number> {
  const waiting = sorted.filter((job) => job.status === 'queued');
  return new Map(waiting.map((job, i) => [job.id, i + 1]));
}

function jobName(job: Job): string {
  return `${job.singer_name ?? 'unknown singer'} · ${job.label ?? jobTypeLabel(job.type)}`;
}

export function QueueScreen() {
  const jobs = useJobs();
  const action = useJobAction();
  const [cancelling, setCancelling] = useState<Job | null>(null);
  const items = sortJobs(jobs.data?.items ?? []);
  const positions = queuePositions(items);

  return (
    <section className="page" aria-labelledby="queue-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">One GPU · one job at a time</span>
          <h1 id="queue-title">Queue</h1>
        </div>
        <p className="muted queue-note">Jobs run first in, first out. Reordering is not supported by the server yet.</p>
      </header>
      {jobs.isPending ? <Loading label="Loading queue…" /> : null}
      {jobs.error ? <ErrorNote error={jobs.error} onRetry={() => void jobs.refetch()} /> : null}
      {action.error && !cancelling ? <ErrorNote error={action.error} /> : null}
      {jobs.isSuccess && items.length === 0 ? (
        <Empty title="Nothing running or waiting">
          Start a dataset preparation, a training run or a cover and it shows up here.
        </Empty>
      ) : null}
      {items.length > 0 ? (
        <ol className="queue-list sheet" aria-label="Jobs, running first">
          {items.map((job) => {
            const position = positions.get(job.id);
            const isActive = ACTIVE.has(job.status);
            return (
            <li key={job.id} className="queue-row" data-status={job.status}>
              <span className="queue-pos num" aria-label={isActive ? 'Now' : position ? `Position ${position}` : job.status}>
                {isActive ? '▶' : position ?? '❚❚'}
              </span>
              <div className="queue-main">
                <span className="queue-name">{jobName(job)}</span>
                <span className="muted queue-sub">
                  <span className="mono">{jobTypeLabel(job.type)}</span> · added {formatDate(job.created_at)}
                </span>
              </div>
              <StatusChip status={job.status} context={jobName(job)} />
              <div className="inline-actions queue-actions">
                <Link to="/jobs/$jobId" params={{ jobId: job.id }} className="btn btn-sm" aria-label={`Open live run for ${jobName(job)}`}>
                  Open live run
                </Link>
                {job.status === 'paused' ? (
                  <button type="button" className="btn btn-sm" disabled={action.isPending}
                    onClick={() => action.mutate({ jobId: job.id, action: 'resume' })}>
                    Resume
                  </button>
                ) : null}
                <button type="button" className="btn btn-sm btn-danger" aria-label={`Cancel ${jobName(job)}`}
                  disabled={job.status === 'cancelling'}
                  onClick={() => { action.reset(); setCancelling(job); }}>
                  {job.status === 'cancelling' ? 'Cancelling…' : 'Cancel'}
                </button>
              </div>
            </li>
            );
          })}
        </ol>
      ) : null}
      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => { if (!open) setCancelling(null); }}
        title="Cancel this job?"
        confirmLabel="Cancel job"
        pending={action.isPending}
        error={action.error}
        onConfirm={() => {
          if (cancelling) action.mutate({ jobId: cancelling.id, action: 'cancel' }, { onSuccess: () => setCancelling(null) });
        }}
      >
        {cancelling ? jobName(cancelling) : ''} stops now and its processes are killed. Finished stages are kept, so it can be resumed later.
      </ConfirmDialog>
    </section>
  );
}
