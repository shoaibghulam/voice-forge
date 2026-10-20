/**
 * SSE event schema v1 (docs/06 "Event envelope" + "Event types").
 *
 * Every message on GET /api/jobs/{id}/events is validated here before it reaches a
 * reducer. Unknown event types are reported as `unknown`, not thrown: a newer backend
 * must never crash an older UI.
 */
import { z } from 'zod';

export const JOB_STATUSES = ['queued', 'running', 'pausing', 'paused', 'cancelling', 'cancelled', 'failed', 'done'] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;
export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(['cancelled', 'failed', 'done']);

export const etaMethodSchema = z.enum(['seed', 'count', 'ema']);
export type EtaMethod = z.infer<typeof etaMethodSchema>;

const num = z.number();
const nonNegInt = z.number().int().nonnegative();
const maybeNum = num.nullish();

const baseEnvelope = z.object({
  v: z.literal(1),
  seq: nonNegInt,
  job_id: z.string().min(1),
  ts: z.string().min(1),
  stage: z.string().nullable().optional(),
});

function eventSchema<T extends string, D extends z.ZodType>(type: T, data: D) {
  return baseEnvelope.extend({ type: z.literal(type), data });
}

export const jobStatusEvent = eventSchema(
  'job.status',
  z.object({
    status: jobStatusSchema,
    error_code: z.string().nullish(),
    resume: z.boolean().nullish(),
    position_in_queue: nonNegInt.nullish(),
  }),
);
export const stageStartedEvent = eventSchema(
  'stage.started',
  z.object({
    stage: z.string().min(1),
    index: nonNegInt,
    total_stages: nonNegInt,
    expected_s: num.nullish(),
  }),
);
export const stageProgressEvent = eventSchema(
  'stage.progress',
  z.object({
    done: num.nonnegative(),
    total: num.nonnegative(),
    unit: z.string(),
    item: z.string().nullish(),
  }),
);
export const stageRetryEvent = eventSchema(
  'stage.retry',
  z.object({ reason: z.string(), change: z.record(z.string(), z.unknown()).default({}) }),
);
export const stageCompletedEvent = eventSchema(
  'stage.completed',
  z.object({
    stage: z.string().nullish(),
    duration_s: num.nonnegative(),
    outputs: z.record(z.string(), z.unknown()).default({}),
  }),
);
export const stageSkippedEvent = eventSchema('stage.skipped', z.object({ stage: z.string().nullish(), reason: z.string() }));
export const stagePausedEvent = eventSchema('stage.paused', z.object({ stage: z.string().nullish() }));
export const stageFailedEvent = eventSchema(
  'stage.failed',
  z.object({
    stage: z.string().nullish(),
    error_code: z.string(),
    message: z.string(),
    hint: z.string().nullish(),
    duration_s: num.nonnegative().nullish(),
    log_tail: z.array(z.string()).default([]),
  }),
);
export const trainStepEvent = eventSchema(
  'train.step',
  z.object({ epoch: nonNegInt, step: nonNegInt, batch: nonNegInt, num_batches: nonNegInt }),
);
export const trainScalarsEvent = eventSchema(
  'train.scalars',
  // any loss key may be missing from a given sample
  z.object({
    step: nonNegInt,
    mel: maybeNum,
    kl: maybeNum,
    fm: maybeNum,
    adv: maybeNum,
    g_total: maybeNum,
    d_adv: maybeNum,
    grad_g: maybeNum,
    grad_d: maybeNum,
  }),
);
export const trainEpochEvent = eventSchema(
  'train.epoch',
  z.object({
    epoch: nonNegInt,
    total_epochs: nonNegInt,
    epoch_s: num.nonnegative(),
    lowest: z.object({ value: num, epoch: nonNegInt }).nullish(),
  }),
);
export const checkpointSavedEvent = eventSchema(
  'checkpoint.saved',
  z.object({
    checkpoint_id: z.string().nullish(),
    epoch: nonNegInt,
    step: nonNegInt,
    mel: maybeNum,
    has_sample: z.boolean().default(false),
    sample_url: z.string().nullish(),
  }),
);
export const checkpointScoredEvent = eventSchema(
  'checkpoint.scored',
  z.object({
    checkpoint_id: z.string().nullish(),
    epoch: nonNegInt,
    similarity: maybeNum,
    recommended: z.boolean().default(false),
  }),
);
export const qcClipSchema = z.object({
  song_id: z.string().nullish(),
  path: z.string().nullish(),
  start_s: num.nonnegative().nullish(),
  duration_s: num.nonnegative(),
  verdict: z.enum(['keep', 'reject']),
  reason: z.string().nullish(),
  scores: z.record(z.string(), z.number().nullable()).default({}),
});
export type QcClip = z.infer<typeof qcClipSchema>;
/** QC verdicts arrive in coalesced batches of up to 20 clips. */
export const qcClipEvent = eventSchema('qc.clip', z.object({ clips: z.array(qcClipSchema) }));
export const etaEvent = eventSchema(
  'eta',
  z.object({
    stage_eta_s: num.nonnegative().nullable(),
    /** Not sent by the v1 backend; honoured if a later one adds it. */
    job_eta_s: num.nonnegative().nullish(),
    method: etaMethodSchema,
  }),
);
/** NVML gives no shared-memory figure: "near full" (>= 92 %) is the warning state. */
export const gpuSampleEvent = eventSchema(
  'gpu.sample',
  z.object({
    util: maybeNum,
    mem_used_mb: num,
    mem_total_mb: num,
    temp_c: maybeNum,
    power_w: maybeNum,
    clock_mhz: maybeNum,
  }),
);
export const logLinesEvent = eventSchema('log.lines', z.object({ lines: z.array(z.string()) }));

export const runEventSchema = z.discriminatedUnion('type', [
  jobStatusEvent,
  stageStartedEvent,
  stageProgressEvent,
  stageRetryEvent,
  stageCompletedEvent,
  stageSkippedEvent,
  stagePausedEvent,
  stageFailedEvent,
  trainStepEvent,
  trainScalarsEvent,
  trainEpochEvent,
  checkpointSavedEvent,
  checkpointScoredEvent,
  qcClipEvent,
  etaEvent,
  gpuSampleEvent,
  logLinesEvent,
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventType = RunEvent['type'];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
export type EventData<T extends RunEventType> = EventOf<T>['data'];
/** The payload as sent on the wire (before defaults are applied). */
export type WireEventData<T extends RunEventType> = Extract<z.input<typeof runEventSchema>, { type: T }>['data'];

/**
 * Sent once, with data `{}` and no id, after the server has replayed history: the
 * connection is live from here on. It carries no envelope, so it is not a RunEvent.
 */
export const REPLAY_DONE_EVENT = 'replay.done';

/** Every type the UI understands; EventSource needs one listener per named event. */
export const RUN_EVENT_TYPES: readonly RunEventType[] = runEventSchema.options.map(
  (option) => option.shape.type.value,
);

export type ParseResult =
  | { kind: 'event'; event: RunEvent }
  | { kind: 'unknown'; type: string; seq: number | null }
  | { kind: 'invalid'; reason: string };

const peekSchema = z.object({ type: z.string(), seq: nonNegInt.optional() });

/** Parse one SSE `data:` payload. Never throws. */
export function parseEvent(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  const parsed = runEventSchema.safeParse(json);
  if (parsed.success) return { kind: 'event', event: parsed.data };

  const peek = peekSchema.safeParse(json);
  if (peek.success && !(RUN_EVENT_TYPES as readonly string[]).includes(peek.data.type)) {
    return { kind: 'unknown', type: peek.data.type, seq: peek.data.seq ?? null };
  }
  const first = parsed.error.issues[0];
  return {
    kind: 'invalid',
    reason: first ? `${first.path.join('.')}: ${first.message}` : 'schema mismatch',
  };
}
