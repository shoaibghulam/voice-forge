/**
 * While the analyze job runs: the live signal path (job SSE, the same components as the
 * live run view). Each finished stage refetches the analysis so its part appears at once.
 */
import { useEffect, useRef } from 'react';
import { Link } from '@tanstack/react-router';
import { useJobAction } from '@/api/hooks';
import { SignalPath } from '@/components/SignalPath';
import { ErrorNote } from '@/components/Status';
import { usePrefersReducedMotion } from '@/components/motionPrefs';
import { FAILURE_TAIL_LINES, toSignalNodes } from '@/features/run/runNodes';
import { ANALYZE_STAGES } from '@/live/stages';
import { useJobEvents, type EventSourceFactory } from '@/live/useJobEvents';

interface AnalysisProgressProps {
  jobId: string;
  onStageDone: () => void;
  createEventSource?: EventSourceFactory;
}

export function AnalysisProgress({ jobId, onStageDone, createEventSource }: AnalysisProgressProps) {
  const { state, buffers } = useJobEvents(jobId, {
    stageNames: ANALYZE_STAGES,
    ...(createEventSource ? { createEventSource } : {}),
  });
  const isReducedMotion = usePrefersReducedMotion();
  const retry = useJobAction();
  const done = state.stages.filter((s) => s.status === 'done').length;
  const seen = useRef(done);

  useEffect(() => {
    if (done === seen.current) return;
    seen.current = done;
    onStageDone();
  }, [done, onStageDone]);

  const isRunning = state.status === 'running' || state.status === 'pausing';
  return (
    <section className="section an-progress" aria-labelledby="progress-title">
      <div className="section-head">
        <h2 id="progress-title">Analysing</h2>
        <Link to="/jobs/$jobId" params={{ jobId }} className="btn btn-sm run-link-live">Open live run</Link>
      </div>
      <SignalPath
        nodes={toSignalNodes(state, (stage) => buffers.logs.tail(stage, FAILURE_TAIL_LINES))}
        isLive={isRunning}
        isReducedMotion={isReducedMotion}
        label="Analysis stages"
        onRetry={() => retry.mutate({ jobId, action: 'resume' })}
        isRetrying={retry.isPending}
      />
      {retry.isError ? <ErrorNote error={retry.error} /> : null}
    </section>
  );
}
