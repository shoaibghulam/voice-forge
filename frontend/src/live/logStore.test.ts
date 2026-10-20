import { describe, expect, it, vi } from 'vitest';
import { isWarningLine, LogStore } from './logStore';

describe('LogStore', () => {
  it('caps lines in memory but keeps the true total', () => {
    const store = new LogStore(3);
    store.append('train', ['a', 'b']);
    store.appendBatches([{ stage: 'train', lines: ['c', 'd'] }, { stage: 'index', lines: ['e'] }]);
    const snap = store.getSnapshot();
    expect(snap.lines.map((l) => l.text)).toEqual(['c', 'd', 'e']);
    expect(snap.lines.map((l) => l.n)).toEqual([3, 4, 5]);
    expect(snap.total).toBe(5);
    expect(snap.dropped).toBe(2);
  });

  it('notifies subscribers once per batch and not for empty appends', () => {
    const store = new LogStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    store.appendBatches([{ stage: null, lines: ['x'] }, { stage: null, lines: ['y'] }]);
    store.append(null, []);
    off();
    store.append(null, ['z']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('counts warnings', () => {
    const store = new LogStore();
    store.append('train', ['WARNING: CUDA out of memory', 'epoch=3', 'Traceback (most recent call last):']);
    expect(store.getSnapshot().warnings).toBe(2);
    expect(isWarningLine('all good')).toBe(false);
    expect(isWarningLine('RuntimeError: failed to load')).toBe(true);
  });
});
