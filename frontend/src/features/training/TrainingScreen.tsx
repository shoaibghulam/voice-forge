/** `/singers/$id/training` — training runs and the "Start training" form. */
import { Link, getRouteApi } from '@tanstack/react-router';
import { useRuns, useSinger } from '@/api/hooks';
import type { Run } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { StatusChip } from '@/features/shared/StatusChip';
import { formatDate } from '@/features/shared/format';
import { TrainForm } from './TrainForm';
import '@/features/shared/library.css';
import './training.css';

const route = getRouteApi('/singers/$id');
const LIVE = new Set(['running', 'queued', 'pausing', 'paused', 'cancelling']);

function configSummary(config: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof config['epochs'] === 'number') parts.push(`${config['epochs']} epochs`);
  if (typeof config['batch_size'] === 'number') parts.push(`batch ${config['batch_size']}`);
  if (typeof config['sample_rate'] === 'number') parts.push(`${config['sample_rate'] / 1000} kHz`);
  for (const key of ['pretrained', 'vocoder', 'embedder']) {
    if (typeof config[key] === 'string') parts.push(String(config[key]));
  }
  return parts.join(' · ') || 'default settings';
}

function RunRow({ run, number }: { run: Run; number: number }) {
  const live = LIVE.has(run.status);
  return (
    <li className="run-row" data-live={live || undefined}>
      <span className="run-number num">#{number}</span>
      <div className="run-main">
        <StatusChip status={run.status} context={`Run ${number}`} />
        <span className="muted num run-date">{formatDate(run.created_at)}</span>
      </div>
      <span className="run-config mono">{configSummary(run.config)}</span>
      <span className="run-rec">
        {run.checkpoint_count > 0
          ? <><span className="num">{run.checkpoint_count}</span> {run.checkpoint_count === 1 ? 'checkpoint' : 'checkpoints'}</>
          : <span className="muted">{live ? 'no checkpoint yet' : 'no checkpoints'}</span>}
      </span>
      {run.job_id ? (
        <Link to="/jobs/$jobId" params={{ jobId: run.job_id }} className={live ? 'btn btn-sm run-link is-live' : 'btn btn-sm btn-quiet run-link'}>
          {live ? 'Open live run' : 'View run'}
        </Link>
      ) : <span />}
    </li>
  );
}

export function TrainingScreen() {
  const { id } = route.useParams();
  const runs = useRuns(id);
  const singer = useSinger(id);
  const items = runs.data?.items ?? [];

  return (
    <div className="training-screen">
      <section className="section" aria-labelledby="runs-title">
        <div className="section-head">
          <h2 id="runs-title">Training runs</h2>
          <span className="muted num">{items.length} {items.length === 1 ? 'run' : 'runs'}</span>
        </div>
        {runs.isPending ? <Loading label="Loading runs…" /> : null}
        {runs.error ? <ErrorNote error={runs.error} onRetry={() => void runs.refetch()} /> : null}
        {runs.isSuccess && items.length === 0 ? (
          <Empty title="No training runs yet">Prepare the dataset, then start the first run below.</Empty>
        ) : null}
        {items.length > 0 ? (
          <ol className="run-list" aria-label="Training runs, newest first">
            {items.map((run, i) => <RunRow key={run.id} run={run} number={items.length - i} />)}
          </ol>
        ) : null}
      </section>
      <section className="section" aria-labelledby="train-title">
        <div className="section-head"><h2 id="train-title">Start training</h2></div>
        <TrainForm singerId={id} usableMinutes={singer.data?.usable_minutes ?? null} />
      </section>
    </div>
  );
}
