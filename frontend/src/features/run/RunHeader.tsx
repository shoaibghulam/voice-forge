/** Title, elapsed/ETA, connection badge and the job bar (scaleX spring). */
import { useEffect, useState } from 'react';
import { motion, useSpring } from 'motion/react';
import type { JobStatus } from '@/api/events';
import { elapsedSeconds, etaLabel, formatHms, serverNowMs } from '@/live/eta';
import { jobProgress, type RunState } from '@/live/reducers';
import type { ConnectionState, LiveBuffers } from '@/live/useJobEvents';

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: 'connecting',
  replaying: 'replaying',
  live: 'live',
  reconnecting: 'reconnecting',
  ended: 'ended',
  error: 'no stream',
};

const CONNECTION_TONE: Record<ConnectionState, string> = {
  connecting: 'neutral', replaying: 'warn', live: 'signal', reconnecting: 'warn', ended: 'neutral', error: 'fail',
};

const STATUS_TONE: Record<JobStatus, string> = {
  queued: 'neutral', running: 'signal', pausing: 'warn', paused: 'warn', cancelling: 'warn', cancelled: 'neutral', failed: 'fail', done: 'ok',
};

interface ClocksProps {
  state: RunState;
  buffers: LiveBuffers;
}

/** Ticks once a second; only this small component re-renders. */
function Clocks({ state, buffers }: ClocksProps) {
  const [now, setNow] = useState(() => Date.now());
  const isRunning = state.status === 'running' || state.status === 'pausing';
  useEffect(() => {
    if (!isRunning) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning]);
  const serverNow = serverNowMs(buffers.clock, now, isRunning);
  const elapsed = elapsedSeconds(state.startedTs, state.finishedTs, serverNow);
  const eta = isRunning ? etaLabel(state.eta, serverNow) : '—';
  return (
    <dl className="run-clocks">
      <div>
        <dt>elapsed</dt>
        <dd className="num">{elapsed === null ? '—' : formatHms(elapsed)}</dd>
      </div>
      <div>
        <dt>{state.eta?.scope === 'stage' ? 'stage ETA' : 'ETA'}</dt>
        <dd className="num" title={state.eta?.method === 'count' ? 'counted from finished items' : 'estimate'}>{eta}</dd>
      </div>
    </dl>
  );
}

interface JobBarProps {
  progress: number;
  status: JobStatus;
  isReducedMotion: boolean;
}

function JobBar({ progress, status, isReducedMotion }: JobBarProps) {
  const spring = useSpring(progress, { stiffness: 90, damping: 22, mass: 0.6 });
  useEffect(() => {
    if (isReducedMotion) spring.jump(progress);
    else spring.set(progress);
  }, [progress, isReducedMotion, spring]);
  const pct = Math.round(progress * 100);
  return (
    <div
      className="job-bar"
      data-status={status}
      role="progressbar"
      aria-label="Job progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      aria-valuetext={`${pct}% · ${status}`}
    >
      <motion.span className="job-bar-fill" style={{ scaleX: spring }} />
    </div>
  );
}

interface RunHeaderProps {
  title: string;
  state: RunState;
  connection: ConnectionState;
  buffers: LiveBuffers;
  isReducedMotion: boolean;
}

export function RunHeader({ title, state, connection, buffers, isReducedMotion }: RunHeaderProps) {
  return (
    <header className="run-header">
      <div className="run-title-row">
        <div>
          <p className="eyebrow">Live run</p>
          <h1 className="run-title">{title}</h1>
        </div>
        <div className="run-status-chips">
          <span className="chip" data-tone={STATUS_TONE[state.status]}>
            <span className="visually-hidden">Job status:</span>{state.status}
            {state.status === 'queued' && state.positionInQueue !== null ? ` · #${state.positionInQueue + 1}` : ''}
          </span>
          <span className="chip conn-badge" data-tone={CONNECTION_TONE[connection]} data-connection={connection}>
            <span className="conn-dot" aria-hidden="true" />
            <span className="visually-hidden">Stream:</span>{CONNECTION_TEXT[connection]}
          </span>
        </div>
        <Clocks state={state} buffers={buffers} />
      </div>
      <JobBar progress={jobProgress(state)} status={state.status} isReducedMotion={isReducedMotion} />
    </header>
  );
}
