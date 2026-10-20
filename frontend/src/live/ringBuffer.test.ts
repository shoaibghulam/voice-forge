import { describe, expect, it } from 'vitest';
import { RingBuffer, SeriesRing } from './ringBuffer';

describe('RingBuffer', () => {
  it('keeps the newest items in order once full', () => {
    const ring = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((n) => ring.push(n));
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.latest()).toBe(5);
    expect(ring.at(0)).toBe(3);
    expect(ring.at(3)).toBeUndefined();
  });

  it('bumps version on every change so rAF readers know to redraw', () => {
    const ring = new RingBuffer<string>(2);
    const v0 = ring.version;
    ring.push('a');
    ring.clear();
    expect(ring.version).toBe(v0 + 2);
    expect(ring.toArray()).toEqual([]);
    expect(ring.latest()).toBeUndefined();
  });

  it('rejects a non-positive capacity', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
    expect(() => new SeriesRing(-1, ['a'])).toThrow(RangeError);
  });
});

describe('SeriesRing', () => {
  it('returns uPlot-shaped columns oldest → newest after wrapping', () => {
    const ring = new SeriesRing(3, ['mel', 'kl'] as const);
    for (let step = 1; step <= 5; step += 1) ring.push(step * 10, { mel: step, kl: step / 10 });
    expect(ring.toColumns()).toEqual([[30, 40, 50], [3, 4, 5], [0.3, 0.4, 0.5]]);
    expect(ring.toColumns(['kl'])).toEqual([[30, 40, 50], [0.3, 0.4, 0.5]]);
    expect(ring.last('mel')).toBe(5);
    expect(ring.size).toBe(3);
  });

  it('is empty after clear', () => {
    const ring = new SeriesRing(4, ['mel'] as const);
    ring.push(1, { mel: 2 });
    ring.clear();
    expect(ring.toColumns()).toEqual([[], []]);
    expect(ring.last('mel')).toBeUndefined();
  });
});
