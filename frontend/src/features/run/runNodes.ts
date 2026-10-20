/** RunState → what the signal path and header show. */
import type { SignalNode } from '@/components/SignalPath';
import { formatClock } from '@/live/eta';
import type { RunState, StageState, TrainState } from '@/live/reducers';
import { stageLabel } from '@/live/stages';

function progressText(stage: StageState, train: TrainState | null): string | null {
  if (stage.name === 'train' && train && train.epoch > 0) {
    return `ep ${train.epoch}/${train.totalEpochs ?? '?'}`;
  }
  const p = stage.progress;
  if (!p) return 'starting';
  return `${p.done.toLocaleString()}/${p.total.toLocaleString()}`;
}

export function stageDetail(stage: StageState, train: TrainState | null): string | null {
  switch (stage.status) {
    case 'done':
      return stage.durationS !== null ? formatClock(stage.durationS) : 'done';
    case 'running':
      return progressText(stage, train);
    case 'skipped':
      return 'skipped';
    case 'pending':
      if (stage.paused) return 'paused';
      return stage.expectedS ? `~${formatClock(stage.expectedS)}` : null;
    case 'failed':
      return 'failed';
    default:
      return stage.expectedS ? `~${formatClock(stage.expectedS)}` : null;
  }
}

/** Lines shown under a failure when the event carried no log tail of its own. */
export const FAILURE_TAIL_LINES = 30;

/**
 * `logTailFor` supplies a failed stage's last log lines when `stage.failed` has none
 * (the v1 contract sends no tail; the stage's own log lines are the tail).
 */
export function toSignalNodes(state: RunState, logTailFor?: (stage: string) => string[]): SignalNode[] {
  return state.stages.map((stage) => {
    const error = stage.error;
    const logTail = error && error.logTail.length === 0 && logTailFor ? logTailFor(stage.name) : error?.logTail ?? [];
    return {
      name: stage.name,
      label: stageLabel(stage.name),
      status: stage.status,
      detail: stageDetail(stage, state.train),
      error: error ? { message: error.message, hint: error.hint, logTail } : null,
    };
  });
}

export function jobTitle(type: string | undefined, singerName: string | null | undefined, label: string | null | undefined): string {
  const kinds: Record<string, string> = { prepare_dataset: 'dataset preparation', convert: 'cover', analyze: 'analysis' };
  const kind = (type ? kinds[type] : undefined) ?? 'training run';
  const what = label ?? kind;
  return singerName ? `${singerName} · ${what}` : what;
}
