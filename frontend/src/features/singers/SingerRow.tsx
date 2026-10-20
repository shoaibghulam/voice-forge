/** One singer as a channel strip in the library list. */
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Singer } from '@/api/schemas';
import { useDeleteSinger } from '@/api/hooks';
import { ConfirmDialog } from '@/features/shared/ConfirmDialog';
import { StatusChip } from '@/features/shared/StatusChip';
import { formatMinutes, minutesNote, minutesTone } from '@/features/shared/format';
import { MiniPath } from './MiniPath';

interface SingerRowProps {
  singer: Singer;
}

function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

export function SingerRow({ singer }: SingerRowProps) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteSinger();
  const status = singer.last_job?.status ?? singer.last_job_status ?? null;
  const tone = minutesTone(singer.usable_minutes);

  return (
    <li className="singer-row">
      <span className="portrait" aria-hidden="true">{initialOf(singer.name)}</span>
      <div className="singer-name">
        <Link to="/singers/$id/songs" params={{ id: singer.id }} className="singer-link">
          {singer.name}
        </Link>
        <span className="muted singer-sub">
          {singer.song_count ?? 0} songs · {singer.model_count} {singer.model_count === 1 ? 'model' : 'models'}
        </span>
      </div>
      <div className="singer-minutes" data-tone={tone}>
        <span className="num singer-minutes-value">{formatMinutes(singer.usable_minutes)}</span>
        <span className="singer-minutes-unit">min usable</span>
        <span className="singer-minutes-note">
          {tone === 'fail' ? <span aria-hidden="true">✕ </span> : tone === 'warn' ? <span aria-hidden="true">! </span> : null}
          {minutesNote(singer.usable_minutes)}
        </span>
      </div>
      <div className="singer-voice">
        <span className="eyebrow">Active voice</span>
        <span className={singer.active_voice_label ? 'mono' : 'muted'}>
          {singer.active_voice_label ?? (singer.active_checkpoint_id ? 'selected' : 'none yet')}
        </span>
      </div>
      <div className="singer-status">
        <span className="eyebrow">Last run</span>
        {status ? <StatusChip status={status} context="Last run" /> : <span className="muted">never run</span>}
      </div>
      <MiniPath singer={singer} />
      <button
        type="button" className="btn btn-quiet btn-sm btn-icon singer-delete"
        aria-label={`Delete ${singer.name}`} title={`Delete ${singer.name}`}
        onClick={() => { remove.reset(); setConfirming(true); }}
      >
        <span aria-hidden="true">✕</span>
      </button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${singer.name}?`}
        confirmLabel="Delete singer"
        pending={remove.isPending}
        error={remove.error}
        onConfirm={() => remove.mutate(singer.id, { onSuccess: () => setConfirming(false) })}
      >
        Songs, clips, runs and voices for {singer.name} are removed from this computer. This cannot be undone.
      </ConfirmDialog>
    </li>
  );
}
