/** `/` — the singers library: one channel strip per singer (docs/07 "Screens"). */
import { useSingers } from '@/api/hooks';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { NewSingerDialog } from './NewSingerDialog';
import { SingerRow } from './SingerRow';
import './singers.css';

export function SingersScreen() {
  const singers = useSingers();
  const items = singers.data?.items ?? [];

  return (
    <section className="page" aria-labelledby="singers-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">Library</span>
          <h1 id="singers-title">Singers</h1>
        </div>
        <div className="inline-actions">
          <NewSingerDialog />
        </div>
      </header>

      {singers.isPending ? <Loading label="Loading singers…" /> : null}
      {singers.error ? <ErrorNote error={singers.error} onRetry={() => void singers.refetch()} /> : null}
      {singers.isSuccess && items.length === 0 ? (
        <Empty title="No singers yet">
          Add a singer, then upload their songs. Twenty to thirty minutes of clean singing makes a good voice.
        </Empty>
      ) : null}
      {items.length > 0 ? (
        <div className="singer-board sheet">
          <div className="singer-legend" aria-hidden="true">
            <span />
            <span>Singer</span>
            <span>Usable</span>
            <span>Voice</span>
            <span>Last run</span>
            <span>songs · data · train · voice</span>
            <span />
          </div>
          <ul className="singer-list" aria-label="Singers">
            {items.map((singer) => <SingerRow key={singer.id} singer={singer} />)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
