/**
 * Fixed-capacity buffers for high-rate live data (docs/07 "Data flow in the browser").
 * They live in refs, never in React state; readers poll `version` in requestAnimationFrame.
 */

/** Generic ring of objects (GPU samples, step timings). */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private count = 0;
  version = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer');
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    const end = (this.start + this.count) % this.capacity;
    this.items[end] = item;
    if (this.count < this.capacity) this.count += 1;
    else this.start = (this.start + 1) % this.capacity;
    this.version += 1;
  }

  /** i = 0 is the oldest retained item. */
  at(i: number): T | undefined {
    if (i < 0 || i >= this.count) return undefined;
    return this.items[(this.start + i) % this.capacity];
  }

  latest(): T | undefined {
    return this.at(this.count - 1);
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i += 1) {
      const item = this.at(i);
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
    this.version += 1;
  }
}

/**
 * Columnar ring of numbers keyed by x (training step), shaped for uPlot: `toColumns()`
 * returns `[xs, ...series]` oldest → newest. Older points drop off once full.
 */
export class SeriesRing<K extends string> {
  private readonly xs: Float64Array;
  private readonly cols: Record<K, Float64Array>;
  private start = 0;
  private count = 0;
  version = 0;

  constructor(readonly capacity: number, readonly keys: readonly K[]) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer');
    this.xs = new Float64Array(capacity);
    const cols = {} as Record<K, Float64Array>;
    for (const key of keys) cols[key] = new Float64Array(capacity);
    this.cols = cols;
  }

  get size(): number {
    return this.count;
  }

  push(x: number, values: Record<K, number>): void {
    const end = (this.start + this.count) % this.capacity;
    this.xs[end] = x;
    for (const key of this.keys) this.cols[key][end] = values[key];
    if (this.count < this.capacity) this.count += 1;
    else this.start = (this.start + 1) % this.capacity;
    this.version += 1;
  }

  private ordered(source: Float64Array): number[] {
    const out = new Array<number>(this.count);
    for (let i = 0; i < this.count; i += 1) out[i] = source[(this.start + i) % this.capacity] ?? 0;
    return out;
  }

  x(): number[] {
    return this.ordered(this.xs);
  }

  series(key: K): number[] {
    return this.ordered(this.cols[key]);
  }

  toColumns(keys: readonly K[] = this.keys): number[][] {
    return [this.x(), ...keys.map((key) => this.series(key))];
  }

  last(key: K): number | undefined {
    if (this.count === 0) return undefined;
    return this.cols[key][(this.start + this.count - 1) % this.capacity];
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
    this.version += 1;
  }
}
