/** Transport for the analysis page: play/pause, original ↔ vocals, position. */
import { useId } from 'react';
import { formatClock } from '@/features/shared/format';
import type { AnalysisPlayer as Player } from './useAnalysisPlayer';

interface AnalysisPlayerProps {
  player: Player;
}

export function AnalysisPlayer({ player }: AnalysisPlayerProps) {
  const seekId = useId();
  const max = player.duration || 0;
  return (
    <div className="an-player" role="group" aria-label="Listen">
      {player.src ? <audio preload="metadata" src={player.src} {...player.audioProps} /> : null}
      <button type="button" className="btn btn-primary btn-icon" onClick={player.toggle} aria-label={player.isPlaying ? 'Pause' : 'Play'} disabled={!player.src}>
        <span aria-hidden="true">{player.isPlaying ? '❚❚' : '▶'}</span>
      </button>
      <div className="toggle-group" role="group" aria-label="What to hear">
        <button type="button" aria-pressed={player.track === 'original'} onClick={() => player.setTrack('original')}>Song</button>
        <button type="button" aria-pressed={player.track === 'vocals'} onClick={() => player.setTrack('vocals')} disabled={!player.canSwitch}>
          Vocals only
        </button>
      </div>
      <label htmlFor={seekId} className="visually-hidden">Position</label>
      <input
        id={seekId} type="range" className="an-seek" min={0} max={max} step={0.1} value={Math.min(player.time, max)}
        onChange={(e) => player.seek(Number(e.target.value))}
        aria-valuetext={`${formatClock(player.time)} of ${formatClock(max)}`}
      />
      <span className="num an-time">{formatClock(player.time)} / {formatClock(max)}</span>
      {player.error ? <p className="an-player-error" role="alert">✕ {player.error}</p> : null}
    </div>
  );
}
