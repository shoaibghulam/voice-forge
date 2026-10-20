/**
 * Live log: virtualised (fixed row height, only visible rows rendered), capped at 5,000
 * lines in memory, auto-follows the tail unless the user scrolls up. Full log downloads.
 */
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { jobLogUrl } from '@/api/hooks';
import type { LogStore } from '@/live/logStore';

const ROW = 20;
const VIEW_ROWS = 12;
const OVERSCAN = 8;

interface LogViewProps {
  store: LogStore;
  jobId: string;
}

export function LogView({ store, jobId }: LogViewProps) {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [onlyWarnings, setOnlyWarnings] = useState(false);
  const [isFollowing, setIsFollowing] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);

  const lines = useMemo(() => (onlyWarnings ? snap.lines.filter((l) => l.isWarning) : snap.lines), [snap, onlyWarnings]);
  const height = lines.length * ROW;
  const viewHeight = VIEW_ROWS * ROW;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - OVERSCAN);
  const last = Math.min(lines.length, Math.ceil((scrollTop + viewHeight) / ROW) + OVERSCAN);
  const visible = lines.slice(first, last);

  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el || !isFollowing) return;
    el.scrollTop = el.scrollHeight;
    setScrollTop(el.scrollTop);
  }, [lines, isFollowing]);

  const onScroll = () => {
    const el = viewport.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW * 2;
    setIsFollowing(atBottom);
  };

  return (
    <section className="run-log" aria-labelledby="log-title">
      <header className="panel-head">
        <h2 id="log-title" className="eyebrow">Log</h2>
        <div className="toggle-group" role="group" aria-label="Log filter">
          <button type="button" aria-pressed={!onlyWarnings} onClick={() => setOnlyWarnings(false)}>all</button>
          <button type="button" aria-pressed={onlyWarnings} onClick={() => setOnlyWarnings(true)}>
            warnings <span className="num">{snap.warnings}</span>
          </button>
        </div>
        <span className="muted num log-count">
          {snap.total.toLocaleString()} lines{snap.dropped > 0 ? ` · showing last ${snap.lines.length.toLocaleString()}` : ''}
        </span>
        {!isFollowing ? (
          <button type="button" className="btn btn-sm" onClick={() => setIsFollowing(true)}>Follow latest</button>
        ) : null}
        <a className="btn btn-sm btn-quiet" href={jobLogUrl(jobId)} download={`${jobId}.log`}>Download full log</a>
      </header>
      <div
        ref={viewport}
        className="log-viewport mono"
        style={{ height: viewHeight }}
        onScroll={onScroll}
        tabIndex={0}
        role="log"
        aria-label="Job log"
        aria-live="off"
      >
        <div style={{ height, position: 'relative' }}>
          {visible.map((line, i) => (
            <div
              key={line.n}
              className="log-line"
              data-warn={line.isWarning ? 'true' : 'false'}
              style={{ transform: `translateY(${(first + i) * ROW}px)` }}
            >
              <span className="log-n">{line.n}</span>
              <span className="log-stage">{line.stage ?? ''}</span>
              <span className="log-text">{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
