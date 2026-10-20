/**
 * A tape reel that spins with the training step rate. Rotation is written straight to the
 * SVG group's transform in requestAnimationFrame; speed eases toward the target and down
 * to zero on pause/fail/done. Reduced motion: a still reel and the rate as text.
 */
import { useRef } from 'react';
import type { RingBuffer } from '@/live/ringBuffer';
import type { StepSample } from '@/live/useJobEvents';
import { useAnimationFrame } from './motionPrefs';
import './reel.css';

interface ReelProps {
  steps: RingBuffer<StepSample>;
  isSpinning: boolean;
  isReducedMotion?: boolean;
}

/** steps per second over the retained samples (event timestamps, not arrival time). */
export function stepRate(steps: RingBuffer<StepSample>): number {
  if (steps.size < 2) return 0;
  const first = steps.at(Math.max(0, steps.size - 8));
  const last = steps.latest();
  if (!first || !last || last.tsMs <= first.tsMs) return 0;
  return (last.step - first.step) / ((last.tsMs - first.tsMs) / 1000);
}

const DEG_PER_STEP = 40;
const MAX_DEG_PER_S = 540;

export function Reel({ steps, isSpinning, isReducedMotion = false }: ReelProps) {
  const groupRef = useRef<SVGGElement>(null);
  const rateRef = useRef<HTMLSpanElement>(null);
  const motion = useRef({ angle: 0, speed: 0, version: -1, rate: 0 });

  useAnimationFrame((dt) => {
    const m = motion.current;
    if (steps.version !== m.version) {
      m.version = steps.version;
      m.rate = stepRate(steps);
      if (rateRef.current) rateRef.current.textContent = m.rate > 0 ? `${m.rate.toFixed(1)} steps/s` : 'idle';
    }
    const target = isSpinning ? Math.min(MAX_DEG_PER_S, m.rate * DEG_PER_STEP) : 0;
    m.speed += (target - m.speed) * Math.min(1, dt * 1.5);
    if (Math.abs(m.speed) < 0.5 && target === 0) m.speed = 0;
    m.angle = (m.angle + m.speed * dt) % 360;
    if (groupRef.current && !isReducedMotion) groupRef.current.style.transform = `rotate(${m.angle}deg)`;
  }, true);

  return (
    <div className="reel" data-spinning={isSpinning ? 'true' : 'false'}>
      <svg viewBox="-50 -50 100 100" width="64" height="64" aria-hidden="true">
        <circle r="47" className="reel-rim" />
        <g ref={groupRef} className="reel-spokes">
          <circle r="34" className="reel-tape" />
          {[0, 120, 240].map((deg) => (
            <path key={deg} d="M -9 -38 A 40 40 0 0 1 9 -38 L 5 -17 A 18 18 0 0 0 -5 -17 Z" transform={`rotate(${deg})`} className="reel-window" />
          ))}
          <circle r="11" className="reel-hub" />
          <rect x="-2" y="-11" width="4" height="6" className="reel-key" />
        </g>
      </svg>
      <span className="reel-rate num" ref={rateRef}>idle</span>
    </div>
  );
}
