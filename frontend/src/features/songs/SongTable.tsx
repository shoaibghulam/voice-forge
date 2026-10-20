/** Songs as a table: era editable inline, duplicate warning, delete with confirm. */
import { useState } from 'react';
import { useDeleteSong, useSetSongEra } from '@/api/hooks';
import { ERAS, type Era, type Song } from '@/api/schemas';
import { ErrorNote } from '@/components/Status';
import { ConfirmDialog } from '@/features/shared/ConfirmDialog';
import { formatClock } from '@/features/shared/format';

interface SongTableProps {
  singerId: string;
  songs: Song[];
}

function codecText(song: Song): string {
  const codec = song.codec ?? '—';
  return song.bitrate ? `${codec} ${song.bitrate}k` : codec;
}

export function SongTable({ singerId, songs }: SongTableProps) {
  const setEra = useSetSongEra(singerId);
  const remove = useDeleteSong(singerId);
  const [deleting, setDeleting] = useState<Song | null>(null);
  const byId = new Map(songs.map((s) => [s.id, s]));
  const totalSeconds = songs.reduce((sum, s) => sum + (s.duration_s ?? 0), 0);

  return (
    <>
      {setEra.error ? <ErrorNote error={setEra.error} /> : null}
      <div className="table-wrap">
        <table className="data song-table">
          <caption className="visually-hidden">Songs for this singer</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col" className="num">Length</th>
              <th scope="col">Codec</th>
              <th scope="col">Era</th>
              <th scope="col">Status</th>
              <th scope="col"><span className="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {songs.map((song) => {
              const original = song.duplicate_of ? byId.get(song.duplicate_of) : undefined;
              return (
                <tr key={song.id}>
                  <th scope="row" className="song-file">
                    <span>{song.original_filename}</span>
                    {song.duplicate_of ? (
                      <span className="chip" data-tone="warn" title="Same audio fingerprint as another song">
                        <span aria-hidden="true">!</span> duplicate of {original?.original_filename ?? 'another song'}
                      </span>
                    ) : null}
                  </th>
                  <td className="num">{formatClock(song.duration_s)}</td>
                  <td className="mono muted">{codecText(song)}</td>
                  <td>
                    <select
                      className="select select-sm" value={song.era}
                      aria-label={`Era for ${song.original_filename}`}
                      onChange={(e) => setEra.mutate({ songId: song.id, era: e.target.value as Era })}
                    >
                      {ERAS.map((era) => <option key={era} value={era}>{era}</option>)}
                    </select>
                  </td>
                  <td><span className="chip" data-tone={song.status === 'prepared' ? 'ok' : undefined}>{song.status}</span></td>
                  <td>
                    <button
                      type="button" className="btn btn-quiet btn-sm"
                      aria-label={`Delete ${song.original_filename}`}
                      onClick={() => { remove.reset(); setDeleting(song); }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{songs.length} songs</th>
              <td className="num">{formatClock(totalSeconds)}</td>
              <td colSpan={4} className="muted">total recorded (before cleaning)</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null); }}
        title={`Delete ${deleting?.original_filename ?? 'song'}?`}
        confirmLabel="Delete song"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => { if (deleting) remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) }); }}
      >
        The upload, its separated stems and every clip cut from it are removed.
      </ConfirmDialog>
    </>
  );
}
