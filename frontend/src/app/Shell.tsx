/**
 * App frame: a console strip across the top (wordmark, routing, live job, theme) and
 * the routed screen below. No auth — single user on their own laptop.
 */
import { useState } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { useJobs } from '@/api/hooks';
import { applyTheme, nextTheme, readTheme, type ThemeChoice } from './theme';
import './shell.css';

const NAV = [
  { to: '/', label: 'Singers', exact: true },
  { to: '/covers', label: 'Covers', exact: false },
  { to: '/analyses', label: 'Analyse', exact: false },
  { to: '/queue', label: 'Queue', exact: false },
  { to: '/system', label: 'System', exact: false },
] as const;

function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label="Music Trainer — singers library">
      <svg viewBox="0 0 40 12" width="40" height="12" aria-hidden="true">
        <line x1="2" y1="6" x2="38" y2="6" className="wordmark-cable" />
        <circle cx="4" cy="6" r="3" className="wordmark-node is-done" />
        <circle cx="20" cy="6" r="3" className="wordmark-node is-done" />
        <circle cx="36" cy="6" r="3" className="wordmark-node" />
      </svg>
      <span>Music Trainer</span>
    </Link>
  );
}

function LiveJobPill() {
  const jobs = useJobs('running');
  const running = jobs.data?.items[0];
  if (!running) return null;
  const who = running.singer_name ?? running.label ?? running.type.replace('_', ' ');
  return (
    <Link to="/jobs/$jobId" params={{ jobId: running.id }} className="live-pill">
      <span className="live-dot" aria-hidden="true" />
      <span className="visually-hidden">Running now:</span>
      <span>{who}</span>
      <span className="muted">· {running.type.replace('_', ' ')}</span>
    </Link>
  );
}

function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme());
  const label = choice === 'system' ? 'Theme: system' : `Theme: ${choice}`;
  return (
    <button
      type="button"
      className="btn btn-quiet btn-sm theme-toggle"
      onClick={() => {
        const next = nextTheme(choice);
        applyTheme(next);
        setChoice(next);
      }}
      aria-label={`${label}. Switch theme`}
      title={label}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6" className="theme-ring" />
        <path d="M8 2a6 6 0 0 1 0 12z" className="theme-half" />
      </svg>
      <span className="mono">{choice}</span>
    </button>
  );
}

export function Shell() {
  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="console-strip">
        <Wordmark />
        <nav aria-label="Main">
          <ul className="nav-list">
            {NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="nav-link"
                  activeProps={{ 'aria-current': 'page' }}
                  activeOptions={{ exact: item.exact }}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="strip-right">
          <LiveJobPill />
          <Link to="/covers/new" className="btn btn-primary btn-sm">New cover</Link>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
