/**
 * Owns the EventSource for one job (docs/07 "Data flow in the browser").
 *
 *   EventSource(/api/jobs/:id/events)
 *     ├─ parse + validate (zod)
 *     ├─ layout-changing events → reducer (batched once per animation frame)
 *     ├─ train.scalars → loss ring buffer   ┐
 *     ├─ gpu.sample    → gpu ring buffer    ├ refs, read by rAF loops, no re-render
 *     ├─ train.step    → step ring buffer   ┘
 *     └─ log.lines     → LogStore (capped)
 *
 * Reconnects are the browser's: EventSource resends Last-Event-ID and the server replays
 * seq > id. The reducer ignores seq ≤ lastSeq, so nothing is double counted either way.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseEvent, REPLAY_DONE_EVENT, RUN_EVENT_TYPES, TERMINAL_STATUSES, type JobStatus, type RunEvent } from '@/api/events';
import { apiUrl } from '@/api/client';
import { initialRunState, reduceEvents, withStageOrder, type RunState } from './reducers';
import { RingBuffer, SeriesRing } from './ringBuffer';
import { LogStore } from './logStore';
import type { Clock } from './eta';

export const LOSS_KEYS = ['mel', 'kl', 'fm', 'adv', 'g_total', 'd_adv'] as const;
export type LossKey = (typeof LOSS_KEYS)[number];

export interface GpuSample {
  /** null when NVML cannot read utilisation */
  util: number | null;
  memUsedMb: number;
  memTotalMb: number;
  tempC: number | null;
  powerW: number | null;
  clockMhz: number | null;
}

export interface StepSample {
  step: number;
  tsMs: number;
}

export interface LiveBuffers {
  loss: SeriesRing<LossKey>;
  gpu: RingBuffer<GpuSample>;
  steps: RingBuffer<StepSample>;
  logs: LogStore;
  clock: Clock;
}

export type ConnectionState = 'connecting' | 'replaying' | 'live' | 'reconnecting' | 'ended' | 'error';

export type EventSourceFactory = (url: string) => EventSource;

export interface UseJobEventsOptions {
  stageNames?: readonly string[];
  initialStatus?: JobStatus;
  createEventSource?: EventSourceFactory;
  enabled?: boolean;
}

export interface JobEventsResult {
  state: RunState;
  connection: ConnectionState;
  buffers: LiveBuffers;
  invalidEvents: number;
}

/** Events per check window above which we are catching up on history, not live. */
const BURST_EVENTS = 20;
const BURST_WINDOW_MS = 250;
const LOSS_CAPACITY = 20_000;

export function createBuffers(): LiveBuffers {
  return {
    loss: new SeriesRing<LossKey>(LOSS_CAPACITY, LOSS_KEYS),
    gpu: new RingBuffer<GpuSample>(600),
    steps: new RingBuffer<StepSample>(64),
    logs: new LogStore(),
    clock: { lastTs: null, lastArrivalMs: null },
  };
}

/** Route telemetry to buffers. Returns true when the event also matters to the reducer. */
export function routeTelemetry(buffers: LiveBuffers, event: RunEvent, pendingLogs: { stage: string | null; lines: string[] }[]): boolean {
  switch (event.type) {
    case 'train.scalars': {
      // a missing key is a gap (NaN), never a zero that would drag the curve down
      const d = event.data;
      const values = Object.fromEntries(LOSS_KEYS.map((key) => [key, d[key] ?? Number.NaN])) as Record<LossKey, number>;
      buffers.loss.push(d.step, values);
      return false;
    }
    case 'gpu.sample': {
      const d = event.data;
      buffers.gpu.push({
        util: d.util ?? null, memUsedMb: d.mem_used_mb, memTotalMb: d.mem_total_mb,
        tempC: d.temp_c ?? null, powerW: d.power_w ?? null, clockMhz: d.clock_mhz ?? null,
      });
      return false;
    }
    case 'log.lines':
      pendingLogs.push({ stage: event.stage ?? null, lines: event.data.lines });
      return false;
    case 'train.step':
      buffers.steps.push({ step: event.data.step, tsMs: Date.parse(event.ts) });
      return true;
    default:
      return true;
  }
}

const defaultFactory: EventSourceFactory = (url) => new EventSource(url);

function schedule(fn: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(fn);
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
}

export function useJobEvents(jobId: string, options: UseJobEventsOptions = {}): JobEventsResult {
  const { stageNames, initialStatus = 'queued', createEventSource = defaultFactory, enabled = true } = options;
  const buffers = useMemo(() => createBuffers(), [jobId]);
  const [state, setState] = useState<RunState>(() => initialRunState(jobId, stageNames ?? [], initialStatus));
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [invalidEvents, setInvalidEvents] = useState(0);
  const factoryRef = useRef(createEventSource);
  factoryRef.current = createEventSource;

  // reset when the job changes
  useEffect(() => {
    setState(initialRunState(jobId, [], initialStatus));
    setConnection('connecting');
    setInvalidEvents(0);
    // initialStatus only seeds a new job; later status changes come through events
  }, [jobId]);

  // the snapshot's stage list can arrive after events; merge order without losing state
  const namesKey = stageNames?.join('|') ?? '';
  useEffect(() => {
    if (!namesKey) return;
    setState((prev) => withStageOrder(prev, namesKey.split('|')));
  }, [namesKey, jobId]);

  useEffect(() => {
    if (!enabled) return undefined;
    const source = factoryRef.current(apiUrl(`/jobs/${encodeURIComponent(jobId)}/events`));
    let pending: RunEvent[] = [];
    let pendingLogs: { stage: string | null; lines: string[] }[] = [];
    let invalid = 0;
    let cancelFlush: (() => void) | null = null;
    let lastSeq = 0;
    let terminal = false;
    let windowCount = 0;
    let disposed = false;

    const flush = () => {
      cancelFlush = null;
      const batch = pending;
      const logs = pendingLogs;
      pending = [];
      pendingLogs = [];
      if (logs.length > 0) buffers.logs.appendBatches(logs);
      if (batch.length > 0) setState((prev) => reduceEvents(prev, batch));
      if (invalid > 0) setInvalidEvents(invalid);
    };

    const onMessage = (message: MessageEvent<string>) => {
      const parsed = parseEvent(message.data);
      if (parsed.kind === 'invalid') {
        invalid += 1;
      } else if (parsed.kind === 'event' && parsed.event.seq > lastSeq) {
        const event = parsed.event;
        lastSeq = event.seq;
        windowCount += 1;
        buffers.clock.lastTs = event.ts;
        buffers.clock.lastArrivalMs = Date.now();
        if (event.type === 'job.status' && TERMINAL_STATUSES.has(event.data.status)) terminal = true;
        if (routeTelemetry(buffers, event, pendingLogs)) pending.push(event);
      }
      if (!cancelFlush) cancelFlush = schedule(flush);
    };

    const burstCheck = setInterval(() => {
      const count = windowCount;
      windowCount = 0;
      setConnection((prev) => {
        if (prev === 'ended' || prev === 'error' || prev === 'reconnecting') return prev;
        if (count >= BURST_EVENTS) return 'replaying';
        return prev === 'connecting' && count === 0 ? prev : 'live';
      });
    }, BURST_WINDOW_MS);

    source.onopen = () => {
      if (!disposed) setConnection('replaying');
    };
    // The server's own marker that history is replayed; the burst heuristic is only a fallback.
    const onReplayDone = () => {
      if (disposed) return;
      setConnection((prev) => (prev === 'ended' || prev === 'error' ? prev : 'live'));
    };
    source.addEventListener(REPLAY_DONE_EVENT, onReplayDone);
    source.onerror = () => {
      if (disposed) return;
      if (terminal) {
        // server closed the stream after the terminal status: done, do not reconnect.
        // Apply what is still batched first, so "ended" never shows beside a stale timeline.
        source.close();
        cancelFlush?.();
        flush();
        setConnection('ended');
      } else if (source.readyState === 2) {
        setConnection('error');
      } else {
        setConnection('reconnecting');
      }
    };
    for (const type of RUN_EVENT_TYPES) source.addEventListener(type, onMessage as EventListener);
    source.addEventListener('message', onMessage as EventListener);

    return () => {
      disposed = true;
      clearInterval(burstCheck);
      cancelFlush?.();
      source.close();
    };
  }, [jobId, enabled, buffers]);

  return { state, connection, buffers, invalidEvents };
}
