/**
 * Checkpoints as marks on a horizontal epoch strip. Click (or Enter/Space) two marks to
 * compare them; a third pick replaces the older of the two.
 */
import type { Checkpoint } from '@/api/schemas';

interface CheckpointTimelineProps {
  checkpoints: Checkpoint[];
  selected: number[];
  activeEpoch: number | null;
  onToggle: (epoch: number) => void;
}

function sim(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(2).replace(/^0/, '');
}

export function CheckpointTimeline({ checkpoints, selected, activeEpoch, onToggle }: CheckpointTimelineProps) {
  const maxEpoch = Math.max(1, ...checkpoints.map((c) => c.epoch));
  const minEpoch = Math.min(maxEpoch, ...checkpoints.map((c) => c.epoch));
  const span = Math.max(1, maxEpoch - minEpoch);
  const best = Math.max(...checkpoints.map((c) => c.similarity ?? 0), 0.0001);

  return (
    <div className="cp-timeline">
      <div className="cp-axis" aria-hidden="true"><span className="cp-cable" /></div>
      <ol className="cp-marks" aria-label="Checkpoints by epoch">
        {checkpoints.map((c) => {
          const slot = selected.indexOf(c.epoch);
          const letter = slot === 0 ? 'A' : slot === 1 ? 'B' : null;
          const pos = checkpoints.length === 1 ? 50 : ((c.epoch - minEpoch) / span) * 100;
          const height = c.similarity ? Math.max(0.15, c.similarity / best) : 0.15;
          const name = `Epoch ${c.epoch}, similarity ${sim(c.similarity)}${c.recommended ? ', recommended' : ''}${c.epoch === activeEpoch ? ', active voice' : ''}`;
          return (
            <li key={c.epoch} className="cp-mark" style={{ left: `${pos}%` }}>
              <button
                type="button" className="cp-button" aria-pressed={slot !== -1} aria-label={letter ? `${name}, selected as ${letter}` : name}
                data-recommended={c.recommended || undefined} data-active={c.epoch === activeEpoch || undefined}
                onClick={() => onToggle(c.epoch)}
              >
                <span className="cp-stem" aria-hidden="true"><span style={{ transform: `scaleY(${height})` }} /></span>
                <span className="cp-dot" aria-hidden="true">{letter ?? ''}</span>
                <span className="cp-epoch num" aria-hidden="true">{c.epoch}</span>
                <span className="cp-sim num" aria-hidden="true">{sim(c.similarity)}</span>
                {c.recommended ? <span className="cp-star" aria-hidden="true">★ recommended</span> : null}
                {c.epoch === activeEpoch ? <span className="cp-active" aria-hidden="true">● active</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="cp-legend muted">
        <span className="mono">epoch</span> above · <span className="mono">similarity to the real voice</span> below (higher is closer)
      </p>
    </div>
  );
}
