/**
 * The signal path (docs/07): stages as nodes on a cable, an ordered list with
 * aria-current="step" on the running stage. While a stage runs, a pulse travels along
 * its outgoing cable (transform only). Finished cables stay lit; a failed node turns its
 * cable red and opens an error card beneath with the hint and the last log lines.
 */
import { AnimatePresence, motion } from 'motion/react';
import type { StageStatus } from '@/api/schemas';
import './signal-path.css';

export interface SignalNodeError {
  message: string;
  hint: string | null;
  logTail: readonly string[];
}

export interface SignalNode {
  name: string;
  label: string;
  status: StageStatus;
  detail?: string | null;
  error?: SignalNodeError | null;
}

export interface SignalPathProps {
  nodes: readonly SignalNode[];
  /** Pulses travel only while the job is actually running. */
  isLive: boolean;
  isReducedMotion?: boolean;
  label?: string;
  size?: 'full' | 'mini';
  onRetry?: (() => void) | undefined;
  isRetrying?: boolean;
}

const STATUS_TEXT: Record<StageStatus, string> = {
  pending: 'waiting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

const GLYPH: Partial<Record<StageStatus, string>> = { done: '✓', failed: '✕', skipped: '–' };

function cableState(status: StageStatus): 'lit' | 'live' | 'fail' | 'dark' {
  if (status === 'done' || status === 'skipped') return 'lit';
  if (status === 'running') return 'live';
  if (status === 'failed') return 'fail';
  return 'dark';
}

interface ErrorCardProps {
  node: SignalNode & { error: SignalNodeError };
  onRetry?: (() => void) | undefined;
  isRetrying?: boolean | undefined;
}

function ErrorCard({ node, onRetry, isRetrying }: ErrorCardProps) {
  return (
    <motion.section
      className="sp-error"
      role="alert"
      aria-labelledby={`sp-error-${node.name}`}
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.24, ease: [0.2, 0.7, 0.2, 1] }}
    >
      <header className="sp-error-head">
        <span className="sp-error-icon" aria-hidden="true">✕</span>
        <h3 id={`sp-error-${node.name}`}>{node.label} failed</h3>
      </header>
      <p className="sp-error-message">{node.error.message}</p>
      {node.error.hint ? (
        <p className="sp-error-hint"><span className="eyebrow">What to do</span> {node.error.hint}</p>
      ) : null}
      {node.error.logTail.length > 0 ? (
        <pre className="sp-error-log mono" aria-label="Last log lines">{node.error.logTail.join('\n')}</pre>
      ) : null}
      {onRetry ? (
        <button type="button" className="btn btn-primary btn-sm" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? 'Retrying…' : 'Retry stage'}
        </button>
      ) : null}
    </motion.section>
  );
}

export function SignalPath({
  nodes, isLive, isReducedMotion = false, label = 'Pipeline stages', size = 'full', onRetry, isRetrying = false,
}: SignalPathProps) {
  const failed = nodes.find((n): n is SignalNode & { error: SignalNodeError } => n.status === 'failed' && Boolean(n.error));
  return (
    <div className="signal-path" data-size={size} data-motion={isReducedMotion ? 'reduced' : 'full'}>
      <ol className="sp-list" aria-label={label}>
        {nodes.map((node, i) => {
          const isLast = i === nodes.length - 1;
          const cable = cableState(node.status);
          const showPulse = cable === 'live' && isLive && !isReducedMotion && !isLast;
          return (
            <li
              key={node.name}
              className="sp-stage"
              data-status={node.status}
              aria-current={node.status === 'running' ? 'step' : undefined}
            >
              <span className="sp-node" aria-hidden="true">
                {node.status === 'running' && isLive && !isReducedMotion ? <span className="sp-ring" /> : null}
                <span className="sp-glyph">{GLYPH[node.status] ?? ''}</span>
              </span>
              {isLast ? null : (
                <span className="sp-cable" data-state={cable} aria-hidden="true">
                  {showPulse ? <span className="sp-pulse" data-testid="sp-pulse" /> : null}
                </span>
              )}
              <span className="sp-label">{node.label}</span>
              {size === 'full' ? <span className="sp-detail num">{node.detail ?? ' '}</span> : null}
              <span className="visually-hidden">, {STATUS_TEXT[node.status]}</span>
            </li>
          );
        })}
      </ol>
      <AnimatePresence initial={false}>
        {failed && size === 'full' ? <ErrorCard key={failed.name} node={failed} onRetry={onRetry} isRetrying={isRetrying} /> : null}
      </AnimatePresence>
    </div>
  );
}
