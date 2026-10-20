/** `/singers/$id/songs` — upload songs (tus), tag their era, prepare the dataset. */
import { getRouteApi } from '@tanstack/react-router';
import { useSongs } from '@/api/hooks';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { PreparePanel } from './PreparePanel';
import { SongTable } from './SongTable';
import { UploadPanel } from './UploadPanel';
import '@/features/shared/library.css';
import './songs.css';

const route = getRouteApi('/singers/$id');

export function SongsScreen() {
  const { id } = route.useParams();
  const songs = useSongs(id);
  const items = songs.data?.items ?? [];

  return (
    <div className="songs-screen">
      <UploadPanel singerId={id} />
      <section className="section" aria-labelledby="songs-title">
        <div className="section-head">
          <h2 id="songs-title">Songs</h2>
          <span className="muted num">{items.length} uploaded</span>
        </div>
        {songs.isPending ? <Loading label="Loading songs…" /> : null}
        {songs.error ? <ErrorNote error={songs.error} onRetry={() => void songs.refetch()} /> : null}
        {songs.isSuccess && items.length === 0 ? (
          <Empty title="No songs yet">Drop recordings above. Mixed songs are fine — the vocals are separated for you.</Empty>
        ) : null}
        {items.length > 0 ? <SongTable singerId={id} songs={items} /> : null}
      </section>
      <PreparePanel singerId={id} songCount={items.length} />
    </div>
  );
}
