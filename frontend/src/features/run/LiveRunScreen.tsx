/**
 * /jobs/$jobId — the A→Z live view (docs/07 "The live run view").
 * Snapshot (GET /jobs/{id}) gives the job's shape; the SSE stream redraws everything.
 */
import { getRouteApi, Link } from '@tanstack/react-router';
import { useJob, useJobAction } from '@/api/hooks';
import type { JobStage } from '@/api/schemas';
import { SignalPath } from '@/components/SignalPath';
import { ErrorNote } from '@/components/Status';
import { usePrefersReducedMotion } from '@/components/motionPrefs';
import { runningStage } from '@/live/reducers';
import { stagesForJobType } from '@/live/stages';
import { useJobEvents, type EventSourceFactory } from '@/live/useJobEvents';
import { CheckpointList } from './CheckpointList';
import { GpuPanel } from './GpuPanel';
import { LogView } from './LogView';
import { RunActions } from './RunActions';
import { RunHeader } from './RunHeader';
import { FAILURE_TAIL_LINES, jobTitle, toSignalNodes } from './runNodes';
import { StagePanel } from './StagePanel';
import { TrainPanel } from './TrainPanel';
import './run.css';

const route = getRouteApi('/jobs/$jobId');

function orderedStageNames(stages: readonly JobStage[]): string[] {
  return [...stages]
    .map((stage, i) => ({ name: stage.name, at: stage.position ?? i }))
    .sort((a, b) => a.at - b.at)
    .map((s) => s.name);
}

export function LiveRunScreen() {
  const { jobId } = route.useParams();
  return <LiveRun key={jobId} jobId={jobId} />;
}

interface LiveRunProps {
  jobId: string;
  createEventSource?: EventSourceFactory;
}

export function LiveRun({ jobId, createEventSource }: LiveRunProps) {
  const job = useJob(jobId);
  // The job's own stage list drives the path; the catalogue is only a fallback for an empty snapshot.
  const snapshotStages = job.data
    ? (job.data.stages.length > 0 ? orderedStageNames(job.data.stages) : stagesForJobType(job.data.type))
    : undefined;
  const { state, connection, buffers } = useJobEvents(jobId, {
    ...(snapshotStages ? { stageNames: snapshotStages } : {}),
    ...(createEventSource ? { createEventSource } : {}),
  });
  const isReducedMotion = usePrefersReducedMotion();
  const retry = useJobAction();

  const current = runningStage(state);
  const hasTrain = state.stages.some((s) => s.name === 'train');
  const isTrainingNow = current?.name === 'train' || (hasTrain && state.train !== null && current === null);
  const isRunning = state.status === 'running' || state.status === 'pausing';
  const title = jobTitle(job.data?.type, job.data?.singer_name, job.data?.label);

  return (
    <article className="page run-page" aria-label={title}>
      <p className="visually-hidden" aria-live="polite" aria-atomic="true">{state.announcement?.text ?? ''}</p>
      {job.isError ? <ErrorNote error={job.error} onRetry={() => void job.refetch()} /> : null}
      <RunHeader title={title} state={state} connection={connection} buffers={buffers} isReducedMotion={isReducedMotion} />
      {job.data?.analysis_id ? (
        <p className="run-crumbs">
          <Link to="/analyses/$id" params={{ id: job.data.analysis_id }}>Back to the analysis</Link>
        </p>
      ) : null}
      {job.data?.singer_id ? (
        <p className="run-crumbs">
          <Link to="/singers/$id/training" params={{ id: job.data.singer_id }}>All runs for {job.data.singer_name ?? 'this singer'}</Link>
        </p>
      ) : null}

      <section className="run-path" aria-label="Signal path">
        {state.stages.length > 0 ? (
          <SignalPath
            nodes={toSignalNodes(state, (stage) => buffers.logs.tail(stage, FAILURE_TAIL_LINES))}
            isLive={isRunning}
            isReducedMotion={isReducedMotion}
            label="Pipeline stages"
            onRetry={() => retry.mutate({ jobId, action: 'resume' })}
            isRetrying={retry.isPending}
          />
        ) : (
          <p className="muted">Waiting for the first stage…</p>
        )}
        {retry.isError ? <ErrorNote error={retry.error} /> : null}
      </section>

      <div className="run-grid">
        <div className="run-main">
          {hasTrain && (isTrainingNow || state.train) ? (
            <TrainPanel
              train={state.train}
              checkpoints={state.checkpoints}
              buffers={buffers}
              isTraining={isRunning && current?.name === 'train'}
              isReducedMotion={isReducedMotion}
            />
          ) : (
            <StagePanel stage={current} qc={state.qc} status={state.status} />
          )}
        </div>
        <aside className="run-side" aria-label="Hardware and checkpoints">
          <GpuPanel buffers={buffers} />
          {hasTrain ? <CheckpointList checkpoints={state.checkpoints} isReducedMotion={isReducedMotion} /> : null}
        </aside>
      </div>

      <LogView store={buffers.logs} jobId={jobId} />
      <RunActions jobId={jobId} status={state.status} isTraining={hasTrain} />
    </article>
  );
}
