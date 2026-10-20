import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { REPLAY_DONE_EVENT } from '@/api/events';
import { createBuffers, routeTelemetry, useJobEvents } from './useJobEvents';

/** A hand-driven EventSource: the test decides when it opens and what arrives. */
class FakeSource extends EventTarget {
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  close(): void {
    this.readyState = 2;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  emit(type: string, data: unknown, id?: string): void {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id ?? '' }));
  }
}

function setup() {
  const source = new FakeSource();
  const hook = renderHook(() => useJobEvents('job-1', { createEventSource: () => source as unknown as EventSource }));
  return { source, hook };
}

describe('useJobEvents connection badge', () => {
  it('is "replaying" once open and switches to "live" exactly on replay.done', () => {
    const { source, hook } = setup();
    expect(hook.result.current.connection).toBe('connecting');
    act(() => source.open());
    expect(hook.result.current.connection).toBe('replaying');
    act(() => source.emit(REPLAY_DONE_EVENT, {}));
    expect(hook.result.current.connection).toBe('live');
    hook.unmount();
  });

  it('applies still-batched events before showing "ended" (no stale timeline)', () => {
    const { source, hook } = setup();
    act(() => source.open());
    act(() => {
      source.emit('stage.failed', {
        v: 1, seq: 1, job_id: 'job-1', ts: '2026-10-19T12:00:00Z', type: 'stage.failed', stage: 'extract',
        data: { stage: 'extract', error_code: 'x', message: 'broke', hint: null, duration_s: 1 },
      }, '1');
      source.emit('job.status', { v: 1, seq: 2, job_id: 'job-1', ts: '2026-10-19T12:00:01Z', type: 'job.status', stage: null, data: { status: 'failed' } }, '2');
      // the server closes the stream in the same tick, before any animation frame runs
      source.onerror?.(new Event('error'));
    });
    expect(hook.result.current.connection).toBe('ended');
    expect(hook.result.current.state.status).toBe('failed');
    expect(hook.result.current.state.stages.find((s) => s.name === 'extract')?.status).toBe('failed');
    hook.unmount();
  });

  it('ignores replay.done after the stream has ended', () => {
    const { source, hook } = setup();
    act(() => source.open());
    act(() => source.emit('job.status', { v: 1, seq: 1, job_id: 'job-1', ts: '2026-10-19T12:00:00Z', type: 'job.status', stage: null, data: { status: 'done' } }, '1'));
    act(() => source.onerror?.(new Event('error')));
    expect(hook.result.current.connection).toBe('ended');
    act(() => source.emit(REPLAY_DONE_EVENT, {}));
    expect(hook.result.current.connection).toBe('ended');
    hook.unmount();
  });
});

describe('routeTelemetry', () => {
  const envelope = { v: 1 as const, seq: 1, job_id: 'j', ts: '2026-10-19T12:00:00Z', stage: 'train' };

  it('stores a missing loss key as a gap, not a zero', () => {
    const buffers = createBuffers();
    routeTelemetry(buffers, { ...envelope, type: 'train.scalars', data: { step: 50, mel: 20.5 } }, []);
    expect(buffers.loss.last('mel')).toBe(20.5);
    expect(Number.isNaN(buffers.loss.last('kl'))).toBe(true);
  });

  it('keeps a null utilisation as null (NVML could not read it)', () => {
    const buffers = createBuffers();
    routeTelemetry(buffers, { ...envelope, type: 'gpu.sample', data: { util: null, mem_used_mb: 5800, mem_total_mb: 6144 } }, []);
    expect(buffers.gpu.latest()).toMatchObject({ util: null, memUsedMb: 5800, memTotalMb: 6144, tempC: null });
  });
});
