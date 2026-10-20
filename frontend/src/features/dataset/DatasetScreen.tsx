/** `/singers/$id/dataset` — QC: minutes gauge, counts, era balance, F0 range, rejected clips. */
import { Link, getRouteApi } from '@tanstack/react-router';
import { useDataset, useSongs } from '@/api/hooks';
import type { Dataset } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { Note } from '@/features/shared/Note';
import { MinutesGauge } from './MinutesGauge';
import { PianoStrip } from './PianoStrip';
import { RejectedClips } from './RejectedClips';
import '@/features/shared/library.css';
import './dataset.css';

const route = getRouteApi('/singers/$id');

const GATE_TEXT: Record<NonNullable<Dataset['gate']>, string> = {
  dataset_too_small: 'Under 5 minutes of usable singing: training will be refused. Add songs, then prepare again.',
  warn_small: 'Under 10 minutes: the voice may sound thin. 30 minutes is the target.',
};

interface EraBalanceProps {
  eraMinutes: Record<string, number>;
  /** The server's verdict that one era dominates. */
  isUnbalanced: boolean;
}

function EraBalance({ eraMinutes, isUnbalanced }: EraBalanceProps) {
  const entries = Object.entries(eraMinutes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (total === 0) return <p className="muted">No era information yet.</p>;
  const top = entries[0];
  const dominant = isUnbalanced && top ? top : null;
  return (
    <>
      <ul className="era-list">
        {entries.map(([era, value]) => (
          <li key={era} className="era-row">
            <span className="era-name">{era}</span>
            <span className="bar era-bar" aria-hidden="true"><span style={{ transform: `scaleX(${value / total})` }} /></span>
            <span className="num">{value.toFixed(1)} min</span>
            <span className="num muted">{Math.round((value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
      {dominant ? (
        <Note tone="warn">
          {`${Math.round((dominant[1] / total) * 100)}% of the singing is from the ${dominant[0]} era.`} The voice will
          lean toward that sound; add songs from other eras if you have them.
        </Note>
      ) : null}
    </>
  );
}

function Counts({ data }: { data: Dataset }) {
  return (
    <dl className="qc-counts">
      <div><dt>Clips</dt><dd className="num">{(data.kept_clips + data.rejected_clips).toLocaleString()}</dd></div>
      <div data-tone="ok"><dt>Kept</dt><dd className="num">✓ {data.kept_clips.toLocaleString()}</dd></div>
      <div data-tone="fail"><dt>Rejected</dt><dd className="num">✕ {data.rejected_clips.toLocaleString()}</dd></div>
    </dl>
  );
}

/** Songs where separation found no singing: they add nothing to the dataset. */
function NoVoiceSongs({ singerId, songIds }: { singerId: string; songIds: readonly string[] }) {
  const songs = useSongs(singerId);
  if (songIds.length === 0) return null;
  const names = new Map((songs.data?.items ?? []).map((s) => [s.id, s.original_filename]));
  const titles = songIds.map((id) => names.get(id) ?? 'an unknown song');
  return (
    <Note tone="warn">
      {`No singing voice was found in ${songIds.length === 1 ? '1 song' : `${songIds.length} songs`}: ${titles.join(', ')}.`}{' '}
      Check that these are vocal recordings, or delete them on the Songs tab.
    </Note>
  );
}

export function DatasetScreen() {
  const { id } = route.useParams();
  const dataset = useDataset(id);
  const data = dataset.data;

  if (dataset.isPending) return <Loading label="Loading dataset report…" />;
  if (dataset.error) return <ErrorNote error={dataset.error} onRetry={() => void dataset.refetch()} />;
  if (!data) return null;
  if (data.kept_clips + data.rejected_clips === 0) {
    return (
      <Empty title="The dataset has not been prepared">
        Upload songs, then press <Link to="/singers/$id/songs" params={{ id }}>Prepare dataset</Link> on the Songs tab.
        The report appears here when cleaning and checks finish.
      </Empty>
    );
  }

  const f0 = data.f0;
  const hasF0 = Boolean(f0?.median_hz && f0.p05_hz && f0.p95_hz);
  return (
    <div className="dataset-screen">
      <section className="section" aria-labelledby="minutes-title">
        <div className="section-head"><h2 id="minutes-title">How much singing</h2><Counts data={data} /></div>
        <MinutesGauge minutes={data.usable_minutes} />
        {data.gate ? <Note tone={data.gate === 'dataset_too_small' ? 'fail' : 'warn'}>{GATE_TEXT[data.gate]}</Note> : null}
        <NoVoiceSongs singerId={id} songIds={data.no_voice_songs} />
      </section>
      <div className="dataset-split">
        <section className="section" aria-labelledby="era-title">
          <div className="section-head"><h2 id="era-title">Era balance</h2></div>
          <EraBalance eraMinutes={data.era_minutes} isUnbalanced={data.era_warning} />
        </section>
        <section className="section" aria-labelledby="f0-title">
          <div className="section-head"><h2 id="f0-title">Vocal range</h2></div>
          {hasF0 ? (
            <PianoStrip medianHz={f0?.median_hz ?? 0} lowHz={f0?.p05_hz ?? 0} highHz={f0?.p95_hz ?? 0} />
          ) : <p className="muted">Pitch not measured yet.</p>}
        </section>
      </div>
      <section className="section" aria-labelledby="rejected-title">
        <div className="section-head">
          <h2 id="rejected-title">Rejected clips</h2>
          <span className="muted">Listen, and keep the ones the checks got wrong.</span>
        </div>
        <RejectedClips singerId={id} rejectedByReason={data.rejected} />
      </section>
    </div>
  );
}
