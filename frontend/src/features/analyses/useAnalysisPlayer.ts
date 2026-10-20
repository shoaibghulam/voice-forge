/**
 * One <audio> for the analysis page: the original song or its vocal stem, switched in place
 * at the same position, and a `seek` the lyric lines and the timeline call (it also starts
 * playback, so clicking a line plays it).
 */
import { useCallback, useRef, useState, type SyntheticEvent } from 'react';

export type PlayerTrack = 'original' | 'vocals';

export interface AnalysisPlayer {
  track: PlayerTrack;
  src: string | null;
  canSwitch: boolean;
  time: number;
  duration: number;
  isPlaying: boolean;
  error: string | null;
  setTrack: (track: PlayerTrack) => void;
  toggle: () => void;
  seek: (seconds: number) => void;
  audioProps: {
    ref: (el: HTMLAudioElement | null) => void;
    onTimeUpdate: (e: SyntheticEvent<HTMLAudioElement>) => void;
    onLoadedMetadata: (e: SyntheticEvent<HTMLAudioElement>) => void;
    onEnded: () => void;
    onError: () => void;
  };
}

export function useAnalysisPlayer(urls: Record<PlayerTrack, string | null>, fallbackDuration = 0): AnalysisPlayer {
  const element = useRef<HTMLAudioElement | null>(null);
  const resume = useRef<{ at: number; play: boolean } | null>(null);
  const [track, setTrackState] = useState<PlayerTrack>('original');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const src = urls[track] ?? urls.original;

  const play = useCallback(() => {
    const el = element.current;
    if (!el) return;
    setError(null);
    Promise.resolve(el.play())
      .then(() => setPlaying(true))
      .catch(() => { setPlaying(false); setError('This browser could not play the audio.'); });
  }, []);

  const pause = useCallback(() => {
    element.current?.pause();
    setPlaying(false);
  }, []);

  const seek = useCallback((seconds: number) => {
    const el = element.current;
    if (!el) return;
    el.currentTime = seconds;
    setTime(seconds);
    play();
  }, [play]);

  const setTrack = useCallback((next: PlayerTrack) => {
    if (next === track || !urls[next]) return;
    resume.current = { at: element.current?.currentTime ?? time, play: isPlaying };
    setTrackState(next);
  }, [isPlaying, time, track, urls]);

  return {
    track, src, canSwitch: Boolean(urls.original && urls.vocals),
    time, duration: duration || fallbackDuration, isPlaying, error,
    setTrack, toggle: isPlaying ? pause : play, seek,
    audioProps: {
      ref: (el) => { element.current = el; },
      onTimeUpdate: (e) => setTime(e.currentTarget.currentTime),
      onLoadedMetadata: (e) => {
        const el = e.currentTarget;
        if (Number.isFinite(el.duration)) setDuration(el.duration);
        const pending = resume.current;
        resume.current = null;
        if (!pending) return;
        el.currentTime = pending.at;
        if (pending.play) play();
      },
      onEnded: () => setPlaying(false),
      onError: () => setError('Could not load this audio.'),
    },
  };
}
