/**
 * VU-style meter. The fill grows with `scaleX` (never width). For 1 Hz live data the
 * parent writes through `fillRef`/`valueRef` in requestAnimationFrame instead of
 * re-rendering; `value` is the initial/static value.
 */
import type { Ref } from 'react';
import './meter.css';

interface MeterProps {
  label: string;
  value: number;
  text: string;
  isWarning?: boolean;
  fillRef?: Ref<HTMLSpanElement>;
  valueRef?: Ref<HTMLSpanElement>;
  meterRef?: Ref<HTMLDivElement>;
}

export function Meter({ label, value, text, isWarning = false, fillRef, valueRef, meterRef }: MeterProps) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div className="meter" data-warn={isWarning ? 'true' : 'false'}>
      <span className="meter-label">{label}</span>
      <div
        className="meter-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuetext={text}
        ref={meterRef}
      >
        <span className="meter-fill" ref={fillRef} style={{ transform: `scaleX(${clamped})` }} />
      </div>
      <span className="meter-value num" ref={valueRef}>{text}</span>
    </div>
  );
}
