/** Timeline selection → A/B player (+ real voice) → blind test / use as active voice. */
import { useState } from 'react';
import { checkpointSampleUrl, useClips, useSelectCheckpoint } from '@/api/hooks';
import type { Checkpoint, Run } from '@/api/schemas';
import { AbPlayer, type AbSource } from '@/components/AbPlayer';
import { ErrorNote } from '@/components/Status';
import { BlindTest } from './BlindTest';
import { CheckpointTimeline } from './CheckpointTimeline';

interface VoiceCompareProps {
  singerId: string;
  singerName: string;
  run: Run;
  checkpoints: Checkpoint[];
  activeCheckpointId: string | null;
}

const REAL_KEY = 'real-voice';

function initialPair(checkpoints: Checkpoint[]): number[] {
  const rec = checkpoints.find((c) => c.recommended) ?? checkpoints.at(-1);
  const last = checkpoints.at(-1);
  if (!rec) return [];
  return last && last.epoch !== rec.epoch ? [rec.epoch, last.epoch] : [rec.epoch];
}

function activeEpochOf(checkpoints: Checkpoint[], activeId: string | null): number | null {
  const active = checkpoints.find((c) => c.active || (activeId !== null && c.id === activeId));
  return active ? active.epoch : null;
}

/** The sample to play: the URL the server gave, or the checkpoint's sample route. */
function sampleOf(c: Checkpoint): string | null {
  if (c.sample_url) return c.sample_url;
  return c.has_sample ? checkpointSampleUrl(c.id) : null;
}

export function VoiceCompare({ singerId, singerName, run, checkpoints, activeCheckpointId }: VoiceCompareProps) {
  const [selected, setSelected] = useState<number[]>(() => initialPair(checkpoints));
  const [withReal, setWithReal] = useState(true);
  const [blind, setBlind] = useState(false);
  const reference = useClips(singerId, { verdict: 'keep' });
  const select = useSelectCheckpoint(run.id, singerId);
  const [justSelected, setJustSelected] = useState<number | null>(null);
  const realUrl = reference.data?.items.find((c) => c.audio_url)?.audio_url ?? null;
  const activeEpoch = justSelected ?? activeEpochOf(checkpoints, activeCheckpointId);

  const toggle = (epoch: number) => {
    setSelected((prev) => {
      if (prev.includes(epoch)) return prev.filter((e) => e !== epoch);
      return prev.length >= 2 ? [prev[1] ?? epoch, epoch] : [...prev, epoch];
    });
  };

  const sources: AbSource[] = selected
    .map((epoch) => checkpoints.find((c) => c.epoch === epoch))
    .filter((c): c is Checkpoint => c !== undefined && sampleOf(c) !== null)
    .map((c) => ({
      key: `ep-${c.epoch}`, url: sampleOf(c) ?? '', label: `Epoch ${c.epoch}${c.recommended ? ' ★' : ''}`,
      detail: c.similarity !== null && c.similarity !== undefined ? `sim ${c.similarity.toFixed(2)}` : 'not scored',
    }));
  if (withReal && realUrl) sources.push({ key: REAL_KEY, url: realUrl, label: 'Real voice', detail: 'from the dataset' });

  return (
    <div className="voice-compare">
      <CheckpointTimeline checkpoints={checkpoints} selected={selected} activeEpoch={activeEpoch} onToggle={toggle} />
      <div className="compare-head">
        <h3>Compare</h3>
        <label className="check">
          <input type="checkbox" checked={withReal} onChange={(e) => setWithReal(e.target.checked)} disabled={!realUrl} />
          <span>Include the real voice{realUrl ? '' : ' (no kept clips yet)'}</span>
        </label>
        <button type="button" className="btn btn-sm" aria-pressed={blind} onClick={() => setBlind((b) => !b)} disabled={sources.length < 2}>
          {blind ? 'Leave blind test' : 'Blind test'}
        </button>
      </div>
      {sources.length === 0 ? <p className="muted">Pick a checkpoint on the strip to listen.</p> : null}
      {sources.length > 0 && blind ? (
        <BlindTest sources={sources} singerName={singerName} referenceKey={withReal && realUrl ? REAL_KEY : null} onExit={() => setBlind(false)} />
      ) : null}
      {sources.length > 0 && !blind ? (
        <AbPlayer key={sources.map((s) => s.key).join('|')} sources={sources} label="Compare checkpoints" />
      ) : null}
      {!blind && selected.length > 0 ? (
        <div className="inline-actions use-voice">
          {selected.map((epoch) => (
            <button
              key={epoch} type="button" className={epoch === activeEpoch ? 'btn' : 'btn btn-primary'}
              disabled={select.isPending || epoch === activeEpoch}
              onClick={() => {
                const checkpoint = checkpoints.find((c) => c.epoch === epoch);
                if (checkpoint) select.mutate(checkpoint.id, { onSuccess: () => setJustSelected(epoch) });
              }}
            >
              {epoch === activeEpoch ? `✓ Epoch ${epoch} is the active voice` : `Use epoch ${epoch} as active voice`}
            </button>
          ))}
        </div>
      ) : null}
      {select.error ? <ErrorNote error={select.error} /> : null}
    </div>
  );
}
