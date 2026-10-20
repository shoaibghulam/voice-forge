/** `/covers/$id` — conversion progress, then four synced tracks on one playhead. */
import { Link, getRouteApi } from '@tanstack/react-router';
import { useCover } from '@/api/hooks';
import { coverReady, type Cover, type CoverAudio, type Job } from '@/api/schemas';
import { AbPlayer, type AbSource } from '@/components/AbPlayer';
import { ErrorNote, Loading } from '@/components/Status';
import { StatusChip } from '@/features/shared/StatusChip';
import { stageLabel } from '@/live/stages';
import { coverTitle, useCoverJob, useSingerNames } from './useCoverQueries';
import './covers.css';

const route = getRouteApi('/covers/$id');

const STAGE_ICON: Record<string, string> = { done: '✓', running: '◉', failed: '✕', skipped: '–', pending: '○' };

function CoverProgress({ cover, job }: { cover: Cover; job: Job | undefined }) {
  const stages = job?.stages ?? [];
  const done = stages.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const fraction = stages.length > 0 ? done / stages.length : 0;
  return (
    <section className="section" aria-labelledby="progress-title">
      <div className="section-head">
        <h2 id="progress-title">Converting</h2>
        {cover.job_id ? (
          <Link to="/jobs/$jobId" params={{ jobId: cover.job_id }} className="btn btn-sm run-link-live">Open live run</Link>
        ) : null}
      </div>
      <div className="bar" role="progressbar" aria-label="Conversion progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <span style={{ transform: `scaleX(${fraction})` }} />
      </div>
      {stages.length > 0 ? (
        <ol className="cover-path" aria-label="Conversion stages">
          {stages.map((stage) => (
            <li key={stage.name} className="cover-path-node" data-status={stage.status} aria-current={stage.status === 'running' ? 'step' : undefined}>
              <span className="cover-path-dot" aria-hidden="true">{STAGE_ICON[stage.status] ?? '○'}</span>
              <span className="cover-path-label">{stageLabel(stage.name)}</span>
              <span className="cover-path-status">{stage.status}</span>
            </li>
          ))}
        </ol>
      ) : <Loading label="Waiting for the worker…" />}
      {cover.status === 'failed' || cover.status === 'cancelled' ? (
        <p className="muted">The conversion stopped ({cover.status}). Open the live run for the log and a retry.</p>
      ) : null}
    </section>
  );
}

function settingsText(cover: Cover): string {
  const s = cover.settings;
  if (!s) return '';
  const pitch = s.semitones === 0 ? 'no transpose' : `${s.semitones > 0 ? '+' : ''}${s.semitones} st`;
  return `${pitch}${s.octave_auto ? ' · auto octave' : ''} · timbre ${s.timbre_strength.toFixed(2)} · breath ${s.protect.toFixed(2)} · vocal ${s.vocal_level.toFixed(2)}× · reverb ${s.reverb}`;
}

const PLAYABLE: readonly { key: keyof CoverAudio; label: string }[] = [
  { key: 'original', label: 'Original' },
  { key: 'mix', label: 'Converted mix' },
  { key: 'vocal', label: 'Vocal only' },
  { key: 'backing', label: 'Backing' },
];

/** Only the tracks the server reports as written. */
function playableSources(audio: CoverAudio): AbSource[] {
  return PLAYABLE.flatMap(({ key, label }) => {
    const url = audio[key];
    return url ? [{ key, label, url }] : [];
  });
}

function CoverPlayer({ cover }: { cover: Cover }) {
  const { mix, mp3 } = cover.audio;
  return (
    <section className="section" aria-labelledby="listen-title">
      <div className="section-head">
        <h2 id="listen-title">Listen</h2>
        <div className="inline-actions">
          {mix ? <a className="btn btn-sm" href={mix} download>Download mix (WAV)</a> : null}
          {mp3 ? <a className="btn btn-sm" href={mp3} download>Download mix (MP3)</a> : null}
        </div>
      </div>
      <AbPlayer sources={playableSources(cover.audio)} label="Cover tracks" verb="Solo" initialKey="mix" />
      <p className="muted cover-settings mono">{settingsText(cover)}</p>
    </section>
  );
}

export function CoverScreen() {
  const { id } = route.useParams();
  const cover = useCover(id);
  const data = cover.data;
  const names = useSingerNames();
  const ready = data ? coverReady(data) : false;
  const job = useCoverJob(data && !ready ? data.job_id : null);

  return (
    <section className="page" aria-labelledby="cover-title">
      <header className="page-head">
        <div>
          <Link to="/covers" className="eyebrow">← Covers</Link>
          <h1 id="cover-title">{cover.isPending ? 'Loading…' : 'Cover'}</h1>
          {data ? <p className="muted">sung by {coverTitle(data, names.get(data.singer_id))}</p> : null}
        </div>
        {data ? <StatusChip status={data.status} context="Cover status" /> : null}
      </header>
      {cover.isPending ? <Loading label="Loading cover…" /> : null}
      {cover.error ? <ErrorNote error={cover.error} onRetry={() => void cover.refetch()} /> : null}
      {job.error ? <ErrorNote error={job.error} /> : null}
      {data && !ready ? <CoverProgress cover={data} job={job.data} /> : null}
      {data && ready ? <CoverPlayer cover={data} /> : null}
    </section>
  );
}
