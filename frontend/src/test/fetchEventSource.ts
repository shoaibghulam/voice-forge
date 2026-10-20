/**
 * Test-only EventSource built on fetch, so MSW's node interceptor (and `sse()` handlers)
 * can serve streams in Vitest. Implements what the app uses: named events, onopen/onerror,
 * Last-Event-ID on reconnect, readyState, close(). `drop()` simulates a network cut.
 */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

export class TestEventSource extends EventTarget {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSED = CLOSED;
  static instances: TestEventSource[] = [];
  /** Every request's Last-Event-ID header ('' when absent), in order. */
  static lastEventIds: string[] = [];
  static reconnectMs = 5;

  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSED = CLOSED;
  readonly url: string;
  readonly withCredentials = false;
  readyState: number = CONNECTING;
  onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;

  private lastEventId = '';
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string | URL) {
    super();
    this.url = new URL(String(url), window.location.href).toString();
    TestEventSource.instances.push(this);
    void this.connect();
  }

  static reset(): void {
    for (const source of TestEventSource.instances) source.close();
    TestEventSource.instances = [];
    TestEventSource.lastEventIds = [];
  }

  close(): void {
    this.readyState = CLOSED;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
  }

  /** Cut the connection like a dropped network: the source reconnects with Last-Event-ID. */
  drop(): void {
    if (this.readyState === CLOSED) return;
    this.controller?.abort();
    this.failAndRetry();
  }

  private emit(event: Event): void {
    this.dispatchEvent(event);
    const self = this as unknown as EventSource;
    if (event.type === 'open') this.onopen?.call(self, event);
    else if (event.type === 'error') this.onerror?.call(self, event);
    else if (event.type === 'message' && event instanceof MessageEvent) this.onmessage?.call(self, event);
  }

  private failAndRetry(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CONNECTING;
    this.emit(new Event('error'));
    if (this.readyState === CLOSED) return;
    this.timer = setTimeout(() => void this.connect(), TestEventSource.reconnectMs);
  }

  private async connect(): Promise<void> {
    if (this.readyState === CLOSED) return;
    const controller = new AbortController();
    this.controller = controller;
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
    TestEventSource.lastEventIds.push(this.lastEventId);
    let response: Response;
    try {
      response = await fetch(this.url, { headers, signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) this.failAndRetry();
      return;
    }
    if (!response.ok || !response.body) {
      this.readyState = CLOSED;
      this.emit(new Event('error'));
      return;
    }
    this.readyState = OPEN;
    this.emit(new Event('open'));
    await this.read(response.body, controller);
  }

  private async read(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          this.dispatchFrame(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // aborted or errored stream: handled below
    }
    if (controller.signal.aborted || controller !== this.controller) return;
    this.failAndRetry();
  }

  private dispatchFrame(frame: string): void {
    if (this.readyState === CLOSED) return;
    let type = 'message';
    const data: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      const colon = line.indexOf(':');
      if (colon === 0) continue;
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') this.lastEventId = value;
    }
    if (data.length === 0) return;
    this.emit(new MessageEvent(type, { data: data.join('\n'), lastEventId: this.lastEventId }));
  }
}
