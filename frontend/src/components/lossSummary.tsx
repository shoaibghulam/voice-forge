/** Text alternatives for the loss chart: a one-line summary and a data table. */
import type { SeriesRing } from '@/live/ringBuffer';
import type { LossKey } from '@/live/useJobEvents';

export const SERIES: readonly { key: LossKey; label: string; color: string }[] = [
  { key: 'mel', label: 'mel', color: '--color-series-1' },
  { key: 'kl', label: 'kl', color: '--color-series-2' },
  { key: 'fm', label: 'fm', color: '--color-series-3' },
  { key: 'adv', label: 'adv', color: '--color-series-4' },
  { key: 'd_adv', label: 'disc', color: '--color-series-5' },
];

const EPOCH_WINDOW = 10;

/** "mel loss 18.42, down 12% over 10 epochs". Samples without a mel value are skipped. */
export function lossSummary(buffer: SeriesRing<LossKey>, stepsPerEpoch: number): string {
  const allX = buffer.x();
  const allMel = buffer.series('mel');
  const keep = allMel.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
  if (keep.length === 0) return 'No loss values yet.';
  const xs = keep.map((i) => allX[i] ?? 0);
  const mel = keep.map((i) => allMel[i] ?? 0);
  const lastStep = xs[xs.length - 1] ?? 0;
  const lastMel = mel[mel.length - 1] ?? 0;
  const span = Math.max(1, stepsPerEpoch) * EPOCH_WINDOW;
  let i = xs.findIndex((x) => x >= lastStep - span);
  if (i < 0) i = 0;
  const earlier = mel[i] ?? lastMel;
  const epochs = Math.max(1, Math.round((lastStep - (xs[i] ?? lastStep)) / Math.max(1, stepsPerEpoch)));
  if (epochs < 1 || earlier === 0 || i === mel.length - 1) return `mel loss ${lastMel.toFixed(2)}`;
  const change = ((lastMel - earlier) / earlier) * 100;
  const dir = change <= 0 ? 'down' : 'up';
  return `mel loss ${lastMel.toFixed(2)}, ${dir} ${Math.abs(change).toFixed(0)}% over ${epochs} epoch${epochs === 1 ? '' : 's'}`;
}

interface LossTableProps {
  buffer: SeriesRing<LossKey>;
  rows?: number;
}

export function LossTable({ buffer, rows = 12 }: LossTableProps) {
  const xs = buffer.x();
  const from = Math.max(0, xs.length - rows);
  const cols = SERIES.map((s) => buffer.series(s.key));
  const indices = Array.from({ length: xs.length - from }, (_, k) => xs.length - 1 - k);
  return (
    <div className="loss-table">
      <table className="data">
        <caption className="visually-hidden">Latest loss values by training step</caption>
        <thead>
          <tr>
            <th scope="col" className="num">step</th>
            {SERIES.map((s) => <th key={s.key} scope="col" className="num">{s.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {indices.map((i) => (
            <tr key={xs[i]}>
              <td className="num">{xs[i]}</td>
              {cols.map((col, c) => {
                const v = col[i];
                return <td key={SERIES[c]?.key} className="num">{v !== undefined && Number.isFinite(v) ? v.toFixed(3) : '—'}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
