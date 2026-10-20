/** A toned inline note (warning / hint / live). The icon carries meaning besides colour. */
import type { ReactNode } from 'react';
import './library.css';

type NoteTone = 'warn' | 'fail' | 'signal' | 'info';

interface NoteProps {
  tone?: NoteTone;
  children: ReactNode;
}

const ICON: Record<NoteTone, string> = { warn: '!', fail: '✕', signal: '◉', info: 'i' };
const LABEL: Record<NoteTone, string> = { warn: 'Warning', fail: 'Problem', signal: 'Live', info: 'Note' };

export function Note({ tone = 'info', children }: NoteProps) {
  return (
    <div className="note" data-tone={tone === 'info' ? undefined : tone}>
      <span className="note-icon" aria-hidden="true">{ICON[tone]}</span>
      <div>
        <span className="visually-hidden">{LABEL[tone]}: </span>
        {children}
      </div>
    </div>
  );
}
