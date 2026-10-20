/**
 * Synced multi-source player with ONE playhead. Every source has its own <audio>; all
 * play together, only the selected one is audible, and the others are held to the
 * audible one's currentTime. Switching A↔B (or soloing a cover track) therefore keeps
 * the exact position. Used by Voice (A/B, real voice) and Cover (four tracks).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import './abplayer.css';

export interface AbSource {
  key: string;
  label: string;
  url: string;
  /** Optional small text under the label, e.g. "sim .72". */
  detail?: string;
}

interface AbPlayerProps {
  sources: AbSource[];
  /** Name of the control group, e.g. "Compare checkpoints". */
  label: string;
  /** Word used on the selector buttons' accessible names ("Listen to" / "Solo"). */
  verb?: string;
  initialKey?: string;
  onActiveChange?: (key: string) => void;
}

const DRIFT_S = 0.12;

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return '0:00';
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function safePlay(el: HTMLAudioElement): Promise<void> {
  try {
    const result = el.play() as Promise<void> | undefined;
    return result ?? Promise.resolve();
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('play failed'));
  }
}

export function AbPlayer({ sources, label, verb = 'Listen to', initialKey, onActiveChange }: AbPlayerProps) {
  const els = useRef(new Map<string, HTMLAudioElement>());
  const [active, setActive] = useState(initialKey ?? sources[0]?.key ?? '');
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const seekId = useId();
  const activeKey = sources.some((s) => s.key === active) ? active : sources[0]?.key ?? '';

  const master = useCallback(() => els.current.get(activeKey) ?? null, [activeKey]);

  // keep mute state in step with the selection
  useEffect(() => {
    for (const [key, el] of els.current) el.muted = key !== activeKey;
  }, [activeKey, sources]);

  // stop everything when unmounting or when the source list changes
  useEffect(() => {
    const map = els.current;
    return () => { for (const el of map.values()) el.pause(); };
  }, [sources]);

  const pauseAll = useCallback(() => {
    for (const el of els.current.values()) el.pause();
    setPlaying(false);
  }, []);

  const playAll = useCallback(() => {
    const lead = master();
    if (!lead) return;
    setFailed(null);
    for (const [key, el] of els.current) {
      if (key !== activeKey) el.currentTime = lead.currentTime;
      safePlay(el).catch(() => {
        if (key === activeKey) { setFailed('This browser could not play the audio.'); setPlaying(false); }
      });
    }
    setPlaying(true);
  }, [activeKey, master]);

  const select = (key: string) => {
    const lead = master();
    const next = els.current.get(key);
    if (lead && next) next.currentTime = lead.currentTime;
    setActive(key);
    onActiveChange?.(key);
  };

  const seek = (value: number) => {
    for (const el of els.current.values()) el.currentTime = value;
    setTime(value);
  };

  const onTimeUpdate = (key: string) => {
    if (key !== activeKey) return;
    const lead = els.current.get(key);
    if (!lead) return;
    setTime(lead.currentTime);
    for (const [other, el] of els.current) {
      if (other !== key && !el.ended && Math.abs(el.currentTime - lead.currentTime) > DRIFT_S) el.currentTime = lead.currentTime;
    }
  };

  return (
    <div className="ab-player" role="group" aria-label={label}>
      {sources.map((s) => (
        <audio
          key={s.key} preload="metadata" src={s.url}
          ref={(el) => { if (el) els.current.set(s.key, el); else els.current.delete(s.key); }}
          onTimeUpdate={() => onTimeUpdate(s.key)}
          onLoadedMetadata={(e) => { if (s.key === activeKey || duration === 0) setDuration(e.currentTarget.duration || 0); }}
          onEnded={() => { if (s.key === activeKey) pauseAll(); }}
          onError={() => { if (s.key === activeKey) setFailed(`Could not load “${s.label}”.`); }}
        />
      ))}
      <div className="ab-sources" role="group" aria-label="Audible source">
        {sources.map((s, i) => (
          <button
            key={s.key} type="button" className="ab-source" aria-pressed={s.key === activeKey}
            aria-label={`${verb} ${s.label}`} onClick={() => select(s.key)}
          >
            <span className="ab-letter mono" aria-hidden="true">{String.fromCharCode(65 + i)}</span>
            <span className="ab-label">{s.label}</span>
            {s.detail ? <span className="ab-detail mono">{s.detail}</span> : null}
          </button>
        ))}
      </div>
      <div className="ab-transport">
        <button type="button" className="btn btn-primary btn-icon ab-play" onClick={playing ? pauseAll : playAll} aria-label={playing ? 'Pause' : 'Play'}>
          <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
        </button>
        <label htmlFor={seekId} className="visually-hidden">Position</label>
        <input
          id={seekId} type="range" className="ab-seek" min={0} max={duration || 0} step={0.01} value={Math.min(time, duration || 0)}
          onChange={(e) => seek(Number(e.target.value))}
          aria-valuetext={`${fmt(time)} of ${fmt(duration)}`}
        />
        <span className="num ab-time">{fmt(time)} / {fmt(duration)}</span>
      </div>
      {failed ? <p className="ab-error" role="alert">✕ {failed}</p> : null}
    </div>
  );
}
