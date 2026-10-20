/** MSW handlers for /api/jobs/* including the SSE stream (docs/06 "SSE stream"). */
import { http, HttpResponse, sse, type ServerSentEventMessage } from 'msw';
import { REPLAY_DONE_EVENT, TERMINAL_STATUSES, type RunEventType } from '@/api/events';
import {
  allMockJobs, cancelMockJob, getMockJob, logText, mockClock, mockJobStatus, pauseMockJob,
  resumeMockJob, snapshot, subscribe, type ControlResult, type MockJob,
} from './jobRegistry';

type SseEvents = { message: unknown; [REPLAY_DONE_EVENT]: unknown } & { [K in RunEventType]: unknown };

const notFound = () =>
  HttpResponse.json({ error: { code: 'not_found', message: 'Job not found.', details: {} } }, { status: 404 });

const XRW = (request: Request) => request.headers.get('x-requested-with') === 'music-trainer';
const forbidden = () =>
  HttpResponse.json({ error: { code: 'csrf', message: 'Missing X-Requested-With header.', details: {} } }, { status: 403 });

interface Stream {
  send: (event: MockJob['events'][number]) => void;
  /** History has been replayed: `replay.done`, data `{}`, no id. */
  replayDone: () => void;
  close: () => void;
}

/** Pump events to one connection as they become due; finish after a terminal status. */
function openStream(entry: MockJob, afterSeq: number, stream: Stream, signal: AbortSignal): void {
  let sent = afterSeq;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let replayed = false;
  const markReplayed = () => {
    if (replayed) return;
    replayed = true;
    stream.replayDone();
  };

  const stop = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };

  const pump = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = null;
    const elapsed = mockClock.now() - entry.startedAtMs;
    for (const [i, event] of entry.events.entries()) {
      if (event.seq <= sent) continue;
      const due = entry.offsetsMs[i] ?? 0;
      if (due > elapsed) {
        markReplayed();
        timer = setTimeout(pump, Math.min(1000, due - elapsed));
        return;
      }
      stream.send(event);
      sent = event.seq;
    }
    markReplayed();
    if (TERMINAL_STATUSES.has(mockJobStatus(entry))) {
      stop();
      stream.close();
    }
  };

  const unsubscribe = subscribe(entry, pump);
  signal.addEventListener('abort', stop);
  queueMicrotask(pump);
}

const CONTROLS: Record<string, (entry: MockJob) => ControlResult> = {
  cancel: cancelMockJob,
  pause: pauseMockJob,
  resume: resumeMockJob,
};

export const jobHandlers = [
  http.get('/api/jobs', ({ request }) => {
    const wanted = new URL(request.url).searchParams.get('status');
    const filter = wanted ? new Set(wanted.split(',')) : null;
    const items = allMockJobs()
      .map((entry) => snapshot(entry))
      .filter((job) => !filter || filter.has(job.status))
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    return HttpResponse.json({ data: items, page: { total: items.length, limit: 50, offset: 0 } });
  }),

  http.get('/api/jobs/:jobId', ({ params }) => {
    const entry = getMockJob(String(params['jobId']));
    return entry ? HttpResponse.json({ data: snapshot(entry) }) : notFound();
  }),

  http.post('/api/jobs/:jobId/:action', ({ params, request }) => {
    if (!XRW(request)) return forbidden();
    const entry = getMockJob(String(params['jobId']));
    if (!entry) return notFound();
    const control = CONTROLS[String(params['action'])];
    if (!control) return HttpResponse.json({ error: { code: 'not_found', message: 'Unknown action.', details: {} } }, { status: 404 });
    const result = control(entry);
    if (!result.ok) return HttpResponse.json({ error: { code: result.code, message: result.message, details: {} } }, { status: 409 });
    return HttpResponse.json({ data: snapshot(entry) });
  }),

  http.get('/api/jobs/:jobId/logs', ({ params, request }) => {
    const entry = getMockJob(String(params['jobId']));
    if (!entry) return notFound();
    const stage = new URL(request.url).searchParams.get('stage');
    return new HttpResponse(logText(entry, stage), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }),

  sse<SseEvents>('/api/jobs/:jobId/events', ({ client, params, request }) => {
    const entry = getMockJob(String(params['jobId']));
    if (!entry) {
      client.error();
      return;
    }
    const lastId = Number.parseInt(request.headers.get('last-event-id') ?? '0', 10);
    openStream(
      entry,
      Number.isFinite(lastId) ? lastId : 0,
      {
        send: (event) => client.send({ id: String(event.seq), event: event.type, data: event } as ServerSentEventMessage<SseEvents>),
        replayDone: () => client.send({ event: REPLAY_DONE_EVENT, data: {} } as ServerSentEventMessage<SseEvents>),
        close: () => client.close(),
      },
      request.signal,
    );
  }),
];

