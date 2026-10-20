/** Left column for non-training stages: current item, stage progress and QC tallies. */
import type { QcState, StageState } from '@/live/reducers';
import { stageLabel } from '@/live/stages';

interface StagePanelProps {
  stage: StageState | null;
  qc: QcState;
  status: string;
}

/** What to say when no stage is running: the job is either not started yet or over. */
const IDLE_HEADING: Record<string, string> = {
  done: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
  queued: 'Queued · waiting for the GPU',
};

function QcTally({ qc }: { qc: QcState }) {
  const reasons = Object.entries(qc.byReason).sort((a, b) => b[1] - a[1]);
  if (qc.kept + qc.rejected === 0) return null;
  return (
    <div className="qc-tally">
      <p className="eyebrow">Quality check so far</p>
      <p className="qc-line num">
        <span>{qc.kept.toLocaleString()} kept</span> · <span>{qc.rejected.toLocaleString()} rejected</span> ·{' '}
        <span>{(qc.keptSeconds / 60).toFixed(1)} min usable</span>
      </p>
      {reasons.length > 0 ? (
        <ul className="qc-reasons">
          {reasons.map(([reason, count]) => (
            <li key={reason}><span className="chip">{reason.replace(/_/g, ' ')}</span> <span className="num">{count}</span></li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function StagePanel({ stage, qc, status }: StagePanelProps) {
  const p = stage?.progress;
  const fraction = p && p.total > 0 ? p.done / p.total : 0;
  const heading = stage ? stageLabel(stage.name) : (IDLE_HEADING[status] ?? 'Waiting for the worker');
  return (
    <section className="run-panel stage-panel" aria-labelledby="stage-title">
      <p className="eyebrow">{stage ? 'Now' : 'Status'}</p>
      <h2 id="stage-title" className="stage-now">{heading}</h2>
      {p ? (
        <>
          <div className="bar" aria-hidden="true"><span style={{ transform: `scaleX(${fraction})` }} /></div>
          <p className="num stage-count">{p.done.toLocaleString()} / {p.total.toLocaleString()} {p.unit}</p>
          {p.item ? <p className="stage-item muted">{p.item}</p> : null}
        </>
      ) : null}
      {stage && stage.retries.length > 0 ? (
        <p className="chip" data-tone="warn">
          retried: {stage.retries.map((r) => `${r.reason.replace(/_/g, ' ')} → ${Object.entries(r.change).map(([k, v]) => `${k} ${String(v)}`).join(', ')}`).join('; ')}
        </p>
      ) : null}
      <QcTally qc={qc} />
    </section>
  );
}
