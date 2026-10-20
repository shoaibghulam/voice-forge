/** `/singers/$id/voice` — checkpoint timeline, A/B with the real voice, blind test, export, import. */
import { useState } from 'react';
import { getRouteApi } from '@tanstack/react-router';
import { checkpointExportUrl, useCheckpoints, useRuns, useSinger } from '@/api/hooks';
import type { Checkpoint, Run } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { formatDate } from '@/features/shared/format';
import { ImportVoiceButton } from '@/features/singers/ImportVoiceButton';
import { VoiceCompare } from './VoiceCompare';
import '@/features/shared/library.css';
import './voice.css';

const route = getRouteApi('/singers/$id');

function defaultRun(runs: Run[]): Run | undefined {
  return runs.find((r) => r.status === 'done') ?? runs[0];
}

/** Export what the singer uses: the active checkpoint, else the recommended, else the newest. */
function exportTarget(checkpoints: Checkpoint[]): Checkpoint | undefined {
  return checkpoints.find((c) => c.active) ?? checkpoints.find((c) => c.recommended) ?? checkpoints.at(-1);
}

export function VoiceScreen() {
  const { id } = route.useParams();
  const runs = useRuns(id);
  const singer = useSinger(id);
  const items = runs.data?.items ?? [];
  const [pickedRun, setPickedRun] = useState<string | null>(null);
  const run = items.find((r) => r.id === pickedRun) ?? defaultRun(items);
  const checkpoints = useCheckpoints(run?.id);

  if (runs.isPending) return <Loading label="Loading runs…" />;
  if (runs.error) return <ErrorNote error={runs.error} onRetry={() => void runs.refetch()} />;
  if (!run) {
    return (
      <div className="voice-screen">
        <Empty title="No voice yet">
          Train a run first (Training tab), or import a voice zip. Checkpoints appear here to compare.
        </Empty>
        <ImportVoiceButton singerId={id} />
      </div>
    );
  }

  const list = checkpoints.data?.items ?? [];
  const target = exportTarget(list);
  return (
    <div className="voice-screen">
      <section className="section" aria-labelledby="voice-run-title">
        <div className="section-head">
          <h2 id="voice-run-title">Checkpoints</h2>
          <div className="inline-actions">
            <label className="field run-pick">
              <span>Run</span>
              <select className="select" value={run.id} onChange={(e) => setPickedRun(e.target.value)}>
                {items.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    run {items.length - i} · {r.status} · {formatDate(r.created_at)}
                  </option>
                ))}
              </select>
            </label>
            {target ? (
              <a className="btn" href={checkpointExportUrl(target.id)} download>Export epoch {target.epoch} (.zip)</a>
            ) : null}
            <ImportVoiceButton singerId={id} />
          </div>
        </div>
        {checkpoints.isPending ? <Loading label="Loading checkpoints…" /> : null}
        {checkpoints.error ? <ErrorNote error={checkpoints.error} onRetry={() => void checkpoints.refetch()} /> : null}
        {checkpoints.isSuccess && list.length === 0 ? (
          <Empty title="No checkpoints yet">The first one is saved after 5 epochs.</Empty>
        ) : null}
        {list.length > 0 ? (
          <VoiceCompare
            key={run.id} singerId={id} singerName={singer.data?.name ?? 'the singer'} run={run} checkpoints={list}
            activeCheckpointId={singer.data?.active_checkpoint_id ?? null}
          />
        ) : null}
      </section>
    </div>
  );
}
