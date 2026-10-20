/** Usable minutes on a track with marks at 5 (minimum), 10 (warning), 30 (target). */
import { MIN_MINUTES, TARGET_MINUTES, WARN_MINUTES, formatMinutes, minutesNote, minutesTone } from '@/features/shared/format';

interface MinutesGaugeProps {
  minutes: number;
}

const MARKS = [
  { at: MIN_MINUTES, label: 'minimum' },
  { at: WARN_MINUTES, label: 'thin below' },
  { at: TARGET_MINUTES, label: 'target' },
] as const;

export function MinutesGauge({ minutes }: MinutesGaugeProps) {
  const max = Math.max(40, Math.ceil((minutes * 1.1) / 10) * 10);
  const fraction = Math.min(1, minutes / max);
  const tone = minutesTone(minutes);

  return (
    <div className="gauge" data-tone={tone}>
      <p className="gauge-readout">
        <span className="num gauge-value">{formatMinutes(minutes)}</span>
        <span className="gauge-unit">minutes of usable singing</span>
        <span className="gauge-note">
          {tone === 'fail' ? '✕ ' : tone === 'warn' ? '! ' : '✓ '}
          {minutesNote(minutes)}
        </span>
      </p>
      <div
        className="gauge-track" role="meter" aria-label="Usable minutes"
        aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.round(minutes * 10) / 10}
        aria-valuetext={`${formatMinutes(minutes)} minutes — ${minutesNote(minutes)}`}
      >
        <span className="gauge-fill" style={{ transform: `scaleX(${fraction})` }} />
        {MARKS.map((mark) => (
          <span key={mark.at} className="gauge-mark" style={{ left: `${(mark.at / max) * 100}%` }} aria-hidden="true">
            <span className="gauge-mark-label num">{mark.at}</span>
            <span className="gauge-mark-sub">{mark.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
