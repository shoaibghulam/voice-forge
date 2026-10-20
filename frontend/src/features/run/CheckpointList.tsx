/** Checkpoints as they are saved: rows slide in (translateY + opacity), ▶ plays the sample. */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { checkpointSampleUrl } from '@/api/hooks';
import type { CheckpointState } from '@/live/reducers';

interface CheckpointListProps {
  checkpoints: readonly CheckpointState[];
  isReducedMotion: boolean;
}

/** One shared <audio> so only one sample plays at a time. */
function useSamplePlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => () => audioRef.current?.pause(), []);
  const toggle = (url: string) => {
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    if (playing === url) {
      audio.pause();
      setPlaying(null);
      return;
    }
    audio.src = url;
    audio.onended = () => setPlaying(null);
    setFailed(null);
    setPlaying(url);
    audio.play().catch(() => {
      setPlaying(null);
      setFailed(url);
    });
  };
  return { playing, failed, toggle };
}

const fmtSim = (v: number | null) => (v === null ? '—' : v.toFixed(2).replace(/^0/, ''));

/** The event's sample URL, else the checkpoint's sample route once the server says it has one. */
function sampleOf(c: CheckpointState): string | null {
  if (c.sampleUrl) return c.sampleUrl;
  return c.hasSample && c.checkpointId ? checkpointSampleUrl(c.checkpointId) : null;
}

export function CheckpointList({ checkpoints, isReducedMotion }: CheckpointListProps) {
  const player = useSamplePlayer();
  const transition = isReducedMotion ? { duration: 0 } : { duration: 0.28, ease: [0.2, 0.7, 0.2, 1] as const };
  return (
    <section className="run-panel checkpoints" aria-labelledby="ckpt-title">
      <header className="panel-head">
        <h2 id="ckpt-title" className="eyebrow">Checkpoints</h2>
        <span className="muted num">{checkpoints.length}</span>
      </header>
      {checkpoints.length === 0 ? (
        <p className="muted ckpt-empty">The first checkpoint is saved after epoch 5.</p>
      ) : (
        <ul className="ckpt-list">
          <AnimatePresence initial={false}>
            {checkpoints.map((c) => {
              const sample = sampleOf(c);
              const isPlaying = sample !== null && player.playing === sample;
              return (
                <motion.li
                  key={c.checkpointId ?? `ep-${c.epoch}`}
                  className="ckpt-row"
                  data-recommended={c.recommended ? 'true' : 'false'}
                  layout={false}
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={transition}
                >
                  <span className="ckpt-epoch num">ep {c.epoch}</span>
                  <span className="ckpt-sim num" title="similarity to the real voice">sim {fmtSim(c.similarity)}</span>
                  {sample ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-icon"
                      aria-pressed={isPlaying}
                      aria-label={`${isPlaying ? 'Stop' : 'Play'} sample from epoch ${c.epoch}`}
                      onClick={() => player.toggle(sample)}
                    >
                      {isPlaying ? '■' : '▶'}
                    </button>
                  ) : <span />}
                  <span className="ckpt-star">
                    {c.recommended ? <><span aria-hidden="true">★</span> recommended</> : null}
                    {sample !== null && player.failed === sample ? <span className="chip" data-tone="fail">sample unavailable</span> : null}
                  </span>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
