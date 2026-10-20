/**
 * Log lines for the live view: capped at MAX_LINES in memory (the full log is
 * downloadable from /api/jobs/{id}/logs). An external store for useSyncExternalStore.
 */
export const MAX_LINES = 5_000;

export interface LogLine {
  n: number;
  stage: string | null;
  text: string;
  isWarning: boolean;
}

const WARNING = /\b(warn(ing)?|error|exception|traceback|failed|oom|out of memory)\b/i;

export function isWarningLine(text: string): boolean {
  return WARNING.test(text);
}

export interface LogSnapshot {
  lines: readonly LogLine[];
  total: number;
  dropped: number;
  warnings: number;
}

export class LogStore {
  private lines: LogLine[] = [];
  private total = 0;
  private warnings = 0;
  private snap: LogSnapshot = { lines: [], total: 0, dropped: 0, warnings: 0 };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly max = MAX_LINES) {}

  append(stage: string | null, texts: readonly string[]): void {
    this.appendBatches([{ stage, lines: texts }]);
  }

  /** One store update (one re-render) for many log events, e.g. a replay burst. */
  appendBatches(batches: readonly { stage: string | null; lines: readonly string[] }[]): void {
    const added: LogLine[] = [];
    for (const { stage, lines } of batches) {
      for (const text of lines) {
        this.total += 1;
        const isWarning = isWarningLine(text);
        if (isWarning) this.warnings += 1;
        added.push({ n: this.total, stage, text, isWarning });
      }
    }
    if (added.length === 0) return;
    const merged = this.lines.concat(added);
    this.lines = merged.length > this.max ? merged.slice(merged.length - this.max) : merged;
    this.snap = {
      lines: this.lines,
      total: this.total,
      dropped: this.total - this.lines.length,
      warnings: this.warnings,
    };
    for (const listener of this.listeners) listener();
  }

  /** The last `count` retained lines logged by one stage (for a failure card). */
  tail(stage: string, count: number): string[] {
    const out: string[] = [];
    for (let i = this.lines.length - 1; i >= 0 && out.length < count; i -= 1) {
      const line = this.lines[i];
      if (line?.stage === stage) out.push(line.text);
    }
    return out.reverse();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LogSnapshot => this.snap;
}
