/**
 * A counter whose digits roll (translateY inside a clipped box) when the value changes.
 * Reduced motion: plain text. Screen readers get the whole number once.
 */
import './digit-roll.css';

interface DigitRollProps {
  value: number;
  minDigits?: number;
  isReducedMotion?: boolean;
  className?: string;
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function DigitRoll({ value, minDigits = 1, isReducedMotion = false, className = '' }: DigitRollProps) {
  const text = String(Math.max(0, Math.floor(value))).padStart(minDigits, '0');
  if (isReducedMotion) {
    return <span className={`digit-roll num ${className}`}>{text}</span>;
  }
  return (
    <span className={`digit-roll num ${className}`} aria-label={text} role="img">
      {text.split('').map((ch, i) => (
        <span className="digit-roll-window" key={text.length - i} aria-hidden="true">
          <span className="digit-roll-column" style={{ transform: `translateY(${-Number(ch) * 10}%)` }}>
            {DIGITS.map((d) => <span key={d}>{d}</span>)}
          </span>
        </span>
      ))}
    </span>
  );
}
