/** `/covers` — every cover made, newest first. */
import { Link } from '@tanstack/react-router';
import { useCovers } from '@/api/hooks';
import { coverReady } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { StatusChip } from '@/features/shared/StatusChip';
import { formatDate } from '@/features/shared/format';
import { coverTitle, useSingerNames } from './useCoverQueries';
import './covers.css';

export function CoversScreen() {
  const covers = useCovers();
  const items = covers.data?.items ?? [];
  const names = useSingerNames();

  return (
    <section className="page" aria-labelledby="covers-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">Output</span>
          <h1 id="covers-title">Covers</h1>
        </div>
        <Link to="/covers/new" className="btn btn-primary">New cover</Link>
      </header>
      {covers.isPending ? <Loading label="Loading covers…" /> : null}
      {covers.error ? <ErrorNote error={covers.error} onRetry={() => void covers.refetch()} /> : null}
      {covers.isSuccess && items.length === 0 ? (
        <Empty title="No covers yet">Upload a song and pick a trained voice to sing it.</Empty>
      ) : null}
      {items.length > 0 ? (
        <ol className="cover-list sheet" aria-label="Covers, newest first">
          {items.map((cover) => {
            const singer = names.get(cover.singer_id) ?? 'unknown singer';
            const title = coverTitle(cover, names.get(cover.singer_id));
            return (
              <li key={cover.id} className="cover-row">
                <span className="cover-glyph" aria-hidden="true">♪</span>
                <div className="cover-title-cell">
                  <Link to="/covers/$id" params={{ id: cover.id }} className="cover-title">{title}</Link>
                  <span className="muted cover-sub">sung by {singer}</span>
                </div>
                <StatusChip status={cover.status} context="Cover status" />
                <span className="num muted cover-date">{formatDate(cover.created_at)}</span>
                <Link to="/covers/$id" params={{ id: cover.id }} className="btn btn-sm btn-quiet" aria-label={`Open ${title}`}>
                  {coverReady(cover) ? 'Listen' : 'Progress'}
                </Link>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
