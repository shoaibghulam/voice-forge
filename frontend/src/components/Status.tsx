/** Small shared states: loading line, error note with help text, empty note. */
import type { ReactNode } from 'react';
import { describeError } from '@/api/errors';
import './status.css';

interface ErrorNoteProps {
  error: unknown;
  onRetry?: () => void;
}

export function ErrorNote({ error, onRetry }: ErrorNoteProps) {
  const { title, help } = describeError(error);
  return (
    <div className="error-note" role="alert">
      <span className="error-note-icon" aria-hidden="true">✕</span>
      <div>
        <p className="error-note-title">{title}</p>
        {help ? <p className="error-note-help">{help}</p> : null}
      </div>
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>
      ) : null}
    </div>
  );
}

interface LoadingProps {
  label: string;
}

export function Loading({ label }: LoadingProps) {
  return (
    <div className="loading" role="status">
      <span className="loading-trace" aria-hidden="true"><span /></span>
      <span className="muted">{label}</span>
    </div>
  );
}

interface EmptyProps {
  title: string;
  children?: ReactNode;
}

export function Empty({ title, children }: EmptyProps) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
    </div>
  );
}
