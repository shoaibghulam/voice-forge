/**
 * One QC clip: 3 s waveform, Listen / Keep / Reject. With the row focused:
 * space = play/pause, k = keep, r = reject.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import type { Clip } from '@/api/schemas';
import { Waveform, type WaveformHandle } from '@/components/Waveform';

interface ClipRowProps {
  clip: Clip;
  pending: boolean;
  onVerdict: (verdict: 'keep' | 'reject') => void;
}

export function reasonLabel(reason: string | null | undefined): string {
  return (reason ?? 'other').replace(/_/g, ' ');
}

export function ClipRow({ clip, pending, onVerdict }: ClipRowProps) {
  const wave = useRef<WaveformHandle>(null);
  const [playing, setPlaying] = useState(false);
  const title = `${clip.song_title ?? 'Clip'} at ${clip.start_s.toFixed(1)} s`;
  const verdictText = clip.verdict === 'keep' ? 'kept' : `rejected: ${reasonLabel(clip.reason)}`;

  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key === ' ' || key === 'spacebar') {
      event.preventDefault();
      wave.current?.playPause();
    } else if (key === 'k') {
      event.preventDefault();
      if (clip.verdict !== 'keep') onVerdict('keep');
    } else if (key === 'r') {
      event.preventDefault();
      if (clip.verdict !== 'reject') onVerdict('reject');
    }
  };

  return (
    <li
      className="clip-row" data-verdict={clip.verdict} tabIndex={0}
      aria-label={`${title}, ${verdictText}${clip.user_override ? ', your override' : ''}`}
      aria-keyshortcuts="Space K R"
      onKeyDown={onKeyDown}
    >
      <div className="clip-meta">
        <span className="clip-title">{clip.song_title ?? 'Clip'}</span>
        <span className="num muted">{clip.start_s.toFixed(1)} s · {clip.duration_s.toFixed(1)} s</span>
      </div>
      <div className="clip-wave">
        {clip.audio_url ? (
          <Waveform ref={wave} url={clip.audio_url} peaks={clip.peaks ?? null} duration={clip.duration_s} height={36}
            label={`Waveform of ${title}`} onPlayingChange={setPlaying} />
        ) : <span className="muted">no audio</span>}
      </div>
      <div className="clip-state">
        <span className="chip" data-tone={clip.verdict === 'keep' ? 'ok' : 'fail'}>
          <span aria-hidden="true">{clip.verdict === 'keep' ? '✓' : '✕'}</span> {verdictText}
        </span>
        {clip.user_override ? <span className="chip" data-tone="accent">your override</span> : null}
      </div>
      <div className="clip-actions" role="group" aria-label={`Actions for ${title}`}>
        <button type="button" className="btn btn-sm" onClick={() => wave.current?.playPause()} disabled={!clip.audio_url} aria-pressed={playing}>
          {playing ? 'Pause' : 'Listen'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onVerdict('keep')} disabled={pending || clip.verdict === 'keep'}>Keep</button>
        <button type="button" className="btn btn-sm btn-danger" onClick={() => onVerdict('reject')} disabled={pending || clip.verdict === 'reject'}>Reject</button>
      </div>
    </li>
  );
}
