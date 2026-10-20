/**
 * Pick the singer and which checkpoint sings. Default is the singer's active voice
 * (checkpoint_id omitted); otherwise a checkpoint of their newest finished run.
 */
import { useId } from 'react';
import { useCheckpoints, useSingers } from '@/api/hooks';
import { useOptionalRuns } from './useCoverQueries';
import { ErrorNote, Loading } from '@/components/Status';

export interface VoiceChoice {
  singerId: string;
  /** Checkpoint id; null = the singer's active voice. */
  checkpointId: string | null;
}

interface VoicePickerProps {
  value: VoiceChoice;
  onChange: (value: VoiceChoice) => void;
}

export function VoicePicker({ value, onChange }: VoicePickerProps) {
  const singers = useSingers();
  const runs = useOptionalRuns(value.singerId);
  const doneRun = value.singerId ? runs.data?.items.find((r) => r.status === 'done') : undefined;
  const checkpoints = useCheckpoints(doneRun?.id);
  const ids = { singer: useId(), cp: useId() };
  const all = singers.data?.items ?? [];
  const voiced = all.filter((s) => s.active_checkpoint_id || s.model_count > 0);
  const current = all.find((s) => s.id === value.singerId);

  if (singers.isPending) return <Loading label="Loading singers…" />;
  if (singers.error) return <ErrorNote error={singers.error} onRetry={() => void singers.refetch()} />;

  return (
    <div className="voice-picker">
      <label className="field" htmlFor={ids.singer}>
        <span>Singer</span>
        <select
          id={ids.singer} className="select" value={value.singerId}
          onChange={(e) => onChange({ singerId: e.target.value, checkpointId: null })}
        >
          <option value="">Choose a singer…</option>
          {voiced.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      {voiced.length === 0 ? <p className="muted">No singer has a trained voice yet. Train one first.</p> : null}
      {value.singerId ? (
        <label className="field" htmlFor={ids.cp}>
          <span>Checkpoint</span>
          <select
            id={ids.cp} className="select" value={value.checkpointId ?? ''}
            onChange={(e) => onChange({ singerId: value.singerId, checkpointId: e.target.value || null })}
          >
            <option value="">Active voice{current?.active_voice_label ? ` (${current.active_voice_label})` : ''}</option>
            {(checkpoints.data?.items ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                epoch {c.epoch}{c.recommended ? ' ★ recommended' : ''}{c.active ? ' · active' : ''}{c.similarity ? ` · sim ${c.similarity.toFixed(2)}` : ''}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}
