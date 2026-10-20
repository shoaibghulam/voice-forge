/** Left column while training: epoch digit roll, batch, reel, epoch timing, loss chart. */
import { DigitRoll } from '@/components/DigitRoll';
import { LossChart } from '@/components/LossChart';
import { Reel } from '@/components/Reel';
import { formatClock } from '@/live/eta';
import type { CheckpointState, TrainState } from '@/live/reducers';
import type { LiveBuffers } from '@/live/useJobEvents';

interface TrainPanelProps {
  train: TrainState | null;
  checkpoints: readonly CheckpointState[];
  buffers: LiveBuffers;
  isTraining: boolean;
  isReducedMotion: boolean;
}

export function TrainPanel({ train, checkpoints, buffers, isTraining, isReducedMotion }: TrainPanelProps) {
  const epoch = train?.epoch ?? 0;
  const total = train?.totalEpochs;
  const checkpointSteps = checkpoints.map((c) => c.step).filter((s) => s > 0);
  return (
    <section className="run-panel train-panel" aria-labelledby="train-title">
      <h2 id="train-title" className="visually-hidden">Training</h2>
      <div className="train-counters">
        <div className="epoch-block">
          <span className="eyebrow">Epoch</span>
          <p className="epoch-value">
            <DigitRoll value={epoch} minDigits={2} isReducedMotion={isReducedMotion} />
            <span className="epoch-total num">/ {total ?? '—'}</span>
          </p>
        </div>
        <dl className="train-facts">
          <div>
            <dt>batch</dt>
            <dd className="num">{train ? `${train.batch}/${train.numBatches}` : '—'}</dd>
          </div>
          <div>
            <dt>epoch time</dt>
            <dd className="num">
              {train?.lastEpochS ? formatClock(train.lastEpochS) : '—'}
              {train?.avgEpochS ? <span className="muted"> (avg {formatClock(train.avgEpochS)})</span> : null}
            </dd>
          </div>
          <div>
            <dt>lowest mel</dt>
            <dd className="num">{train?.lowest ? `${train.lowest.value.toFixed(2)} @ ep ${train.lowest.epoch}` : '—'}</dd>
          </div>
        </dl>
        <Reel steps={buffers.steps} isSpinning={isTraining} isReducedMotion={isReducedMotion} />
      </div>
      <LossChart
        buffer={buffers.loss}
        checkpointSteps={checkpointSteps}
        stepsPerEpoch={train?.numBatches || 1}
        isLive={isTraining}
      />
    </section>
  );
}
