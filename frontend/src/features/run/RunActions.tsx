/** Pause after next checkpoint / Cancel (confirmed) / Resume — POST /api/jobs/{id}/… */
import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { JobStatus } from '@/api/events';
import { useJobAction, type JobAction } from '@/api/hooks';
import { ErrorNote } from '@/components/Status';

interface RunActionsProps {
  jobId: string;
  status: JobStatus;
  isTraining: boolean;
}

export function RunActions({ jobId, status, isTraining }: RunActionsProps) {
  const action = useJobAction();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [requested, setRequested] = useState<JobAction | null>(null);
  const isActive = status === 'running' || status === 'queued';
  const isPausing = status === 'pausing' || (requested === 'pause' && action.isSuccess && isActive);
  const canResume = status === 'paused' || status === 'failed' || status === 'cancelled';

  const run = (kind: JobAction) => {
    setRequested(kind);
    action.mutate({ jobId, action: kind });
  };

  return (
    <div className="run-actions">
      {(isActive || status === 'pausing') && isTraining ? (
        <button type="button" className="btn" onClick={() => run('pause')} disabled={action.isPending || isPausing}>
          {isPausing ? 'Pausing after next checkpoint…' : 'Pause after next checkpoint'}
        </button>
      ) : null}
      {status === 'cancelling' ? <span className="chip" data-tone="warn">Cancelling…</span> : null}
      {isActive || status === 'pausing' ? (
        <Dialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Dialog.Trigger asChild>
            <button type="button" className="btn btn-danger" disabled={action.isPending}>Cancel</button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content className="dialog">
              <Dialog.Title>Cancel this job?</Dialog.Title>
              <Dialog.Description className="muted">
                The worker stops every GPU process for this job. Finished stages and saved checkpoints are kept;
                you can resume from the first unfinished stage later.
              </Dialog.Description>
              <div className="dialog-actions">
                <Dialog.Close asChild><button type="button" className="btn">Keep running</button></Dialog.Close>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    run('cancel');
                    setConfirmOpen(false);
                  }}
                >
                  Cancel job
                </button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      {canResume ? (
        <button type="button" className="btn btn-primary" onClick={() => run('resume')} disabled={action.isPending}>
          Resume from first unfinished stage
        </button>
      ) : null}
      {action.isError ? <ErrorNote error={action.error} /> : null}
    </div>
  );
}
