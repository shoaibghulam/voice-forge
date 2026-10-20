/** Rejected clips grouped by reason; each group listens/overrides clip by clip. */
import { useState } from 'react';
import { useClips, useOverrideClip } from '@/api/hooks';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { ClipRow, reasonLabel } from './ClipRow';

interface RejectedClipsProps {
  singerId: string;
  rejectedByReason: Record<string, number>;
}

export function RejectedClips({ singerId, rejectedByReason }: RejectedClipsProps) {
  const reasons = Object.keys(rejectedByReason).sort((a, b) => (rejectedByReason[b] ?? 0) - (rejectedByReason[a] ?? 0));
  // Pin the opening group: counts change as clips are kept, and re-sorting must not
  // swap the list out from under a focused row.
  const [picked, setPicked] = useState<string | null>(() => reasons[0] ?? null);
  const reason = picked ?? reasons[0] ?? null;
  const groups = reason && !reasons.includes(reason) ? [...reasons, reason] : reasons;
  // filter by reason only, so clips you keep stay visible with an override badge
  const clips = useClips(singerId, reason ? { reason } : { verdict: 'reject' });
  const override = useOverrideClip(singerId);
  const items = clips.data?.items ?? [];

  if (groups.length === 0) {
    return <Empty title="Nothing rejected">Every clip passed the checks.</Empty>;
  }

  return (
    <div className="rejected">
      <div role="group" aria-label="Rejection reason" className="toggle-group reason-group">
        {groups.map((value) => (
          <button key={value} type="button" aria-pressed={value === reason} onClick={() => setPicked(value)}>
            {reasonLabel(value)} <span className="num">{rejectedByReason[value] ?? 0}</span>
          </button>
        ))}
      </div>
      <p className="muted kbd-hint">
        Focus a clip row, then <kbd>Space</kbd> to listen, <kbd>K</kbd> to keep, <kbd>R</kbd> to reject.
      </p>
      {override.error ? <ErrorNote error={override.error} /> : null}
      {clips.isPending ? <Loading label="Loading clips…" /> : null}
      {clips.error ? <ErrorNote error={clips.error} onRetry={() => void clips.refetch()} /> : null}
      {clips.isSuccess && items.length === 0 ? <Empty title="No clips for this reason" /> : null}
      {items.length > 0 ? (
        <ul className="clip-list" aria-label={`Clips rejected for ${reasonLabel(reason)}`}>
          {items.map((clip) => (
            <ClipRow
              key={clip.id} clip={clip}
              pending={override.isPending && override.variables?.clipId === clip.id}
              onVerdict={(verdict) => override.mutate({ clipId: clip.id, verdict })}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
