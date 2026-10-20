/**
 * wavesurfer.js v8 wrapper. Draws server-computed peaks when present (no decode), plays
 * through its own media element, and exposes `playPause` via a ref handle. If
 * wavesurfer cannot start (old browser, jsdom) it falls back to an SVG of the peaks and
 * a plain <audio> element, so the row still plays and still shows its shape.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import WaveSurfer from 'wavesurfer.js';
import './waveform.css';

export interface WaveformHandle {
  playPause: () => void;
  pause: () => void;
}

interface WaveformProps {
  url: string;
  peaks?: number[] | null;
  duration?: number | null;
  height?: number;
  /** Accessible description of what the waveform shows. */
  label: string;
  onPlayingChange?: (playing: boolean) => void;
  ref?: Ref<WaveformHandle>;
}

function cssVar(el: Element, name: string, fallback: string): string {
  try {
    return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
  } catch {
    return fallback;
  }
}

function PeaksSvg({ peaks, height }: { peaks: number[]; height: number }) {
  const w = peaks.length * 3;
  return (
    <svg className="waveform-svg" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true">
      {peaks.map((p, i) => {
        const h = Math.max(1, p * (height - 2));
        return <rect key={i} x={i * 3} y={(height - h) / 2} width={2} height={h} rx={1} />;
      })}
    </svg>
  );
}

export function Waveform({ url, peaks, duration, height = 40, label, onPlayingChange, ref }: WaveformProps) {
  const container = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const [mode, setMode] = useState<'loading' | 'ready' | 'fallback'>('loading');
  const playingCb = useRef(onPlayingChange);

  useEffect(() => {
    playingCb.current = onPlayingChange;
  }, [onPlayingChange]);

  useEffect(() => {
    const el = container.current;
    if (!el) return undefined;
    let instance: WaveSurfer | null = null;
    try {
      instance = WaveSurfer.create({
        container: el,
        url,
        height,
        waveColor: cssVar(el, '--color-line-strong', 'gray'),
        progressColor: cssVar(el, '--color-signal', 'teal'),
        cursorColor: cssVar(el, '--color-accent', 'red'),
        barWidth: 2,
        barGap: 1,
        barRadius: 1,
        normalize: true,
        ...(peaks && peaks.length > 0 ? { peaks: [peaks] } : {}),
        ...(duration ? { duration } : {}),
      });
      instance.on('ready', () => setMode('ready'));
      instance.on('error', () => setMode('fallback'));
      instance.on('play', () => playingCb.current?.(true));
      instance.on('pause', () => playingCb.current?.(false));
      instance.on('finish', () => playingCb.current?.(false));
      ws.current = instance;
    } catch {
      setMode('fallback');
    }
    return () => {
      ws.current = null;
      try {
        instance?.destroy();
      } catch {
        // already torn down
      }
    };
  }, [url, peaks, duration, height]);

  useImperativeHandle(ref, () => ({
    playPause: () => {
      const current = ws.current;
      if (current && mode !== 'fallback') {
        current.playPause().catch(() => setMode('fallback'));
        return;
      }
      const el = audio.current;
      if (!el) return;
      if (el.paused) el.play().catch(() => playingCb.current?.(false));
      else el.pause();
    },
    pause: () => {
      try {
        ws.current?.pause();
      } catch {
        // not started
      }
      audio.current?.pause();
    },
  }), [mode]);

  return (
    <div className="waveform" data-mode={mode} style={{ minHeight: height }}>
      <span className="visually-hidden">{label}</span>
      <div ref={container} className="waveform-canvas" aria-hidden="true" />
      {mode !== 'ready' && peaks && peaks.length > 0 ? <PeaksSvg peaks={peaks} height={height} /> : null}
      {mode === 'fallback' ? (
        <audio
          ref={audio} src={url} preload="none"
          onPlay={() => playingCb.current?.(true)}
          onPause={() => playingCb.current?.(false)}
          onEnded={() => playingCb.current?.(false)}
        />
      ) : null}
    </div>
  );
}
