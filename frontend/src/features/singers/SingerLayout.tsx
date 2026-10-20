/** `/singers/$id` — singer header + tabs (Songs · Dataset · Training · Voice) as nav links. */
import { Link, Outlet, getRouteApi } from '@tanstack/react-router';
import { useSinger } from '@/api/hooks';
import { ErrorNote, Loading } from '@/components/Status';
import { formatMinutes, minutesNote, minutesTone } from '@/features/shared/format';
import './singers.css';

const route = getRouteApi('/singers/$id');

const TABS = [
  { to: '/singers/$id/songs', label: 'Songs' },
  { to: '/singers/$id/dataset', label: 'Dataset' },
  { to: '/singers/$id/training', label: 'Training' },
  { to: '/singers/$id/voice', label: 'Voice' },
] as const;

export function SingerLayout() {
  const { id } = route.useParams();
  const singer = useSinger(id);
  const data = singer.data;
  const tone = minutesTone(data?.usable_minutes);

  return (
    <div className="page">
      <header className="singer-head">
        <span className="portrait" aria-hidden="true">{data?.name.charAt(0).toUpperCase() ?? '·'}</span>
        <div>
          <Link to="/" className="eyebrow">← Singers</Link>
          <h1>{data?.name ?? (singer.isPending ? 'Loading…' : 'Singer')}</h1>
        </div>
        {data ? (
          <dl className="singer-head-meta">
            <div data-tone={tone}>
              <dt>Usable singing</dt>
              <dd><span className="num">{formatMinutes(data.usable_minutes)}</span> min · {minutesNote(data.usable_minutes)}</dd>
            </div>
            <div>
              <dt>Active voice</dt>
              <dd className={data.active_voice_label ? 'mono' : 'muted'}>{data.active_voice_label ?? 'none yet'}</dd>
            </div>
            <div>
              <dt>Songs</dt>
              <dd className="num">{data.song_count ?? 0}</dd>
            </div>
          </dl>
        ) : null}
      </header>
      {singer.isPending ? <Loading label="Loading singer…" /> : null}
      {singer.error ? <ErrorNote error={singer.error} onRetry={() => void singer.refetch()} /> : null}
      <nav aria-label="Singer sections">
        <ul className="singer-tabs">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <Link to={tab.to} params={{ id }} className="singer-tab" activeProps={{ 'aria-current': 'page' }}>
                {tab.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <Outlet />
    </div>
  );
}
