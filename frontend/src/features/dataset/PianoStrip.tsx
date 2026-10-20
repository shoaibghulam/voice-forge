/** F0 median and 5–95 % range drawn on a C2–C6 keyboard, with the notes as text. */

const LOW = 36; // C2
const HIGH = 84; // C6
const WHITE_W = 14;
const WHITE_H = 56;
const BLACK_W = 9;
const BLACK_H = 34;
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const;
const WHITE_PCS = new Set([0, 2, 4, 5, 7, 9, 11]);

export function hzToMidi(hz: number): number {
  return Math.round(69 + 12 * Math.log2(hz / 440));
}

export function midiName(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12] ?? '?'}${Math.floor(midi / 12) - 1}`;
}

interface Key {
  midi: number;
  x: number;
  white: boolean;
}

function layout(): Key[] {
  const keys: Key[] = [];
  let whiteIndex = 0;
  for (let midi = LOW; midi <= HIGH; midi += 1) {
    const white = WHITE_PCS.has(midi % 12);
    if (white) {
      keys.push({ midi, x: whiteIndex * WHITE_W, white });
      whiteIndex += 1;
    } else {
      keys.push({ midi, x: whiteIndex * WHITE_W - BLACK_W / 2, white });
    }
  }
  return keys;
}

const KEYS = layout();
const WIDTH = KEYS.filter((k) => k.white).length * WHITE_W;

interface PianoStripProps {
  medianHz: number;
  lowHz: number;
  highHz: number;
}

export function PianoStrip({ medianHz, lowHz, highHz }: PianoStripProps) {
  const lo = hzToMidi(lowHz);
  const hi = hzToMidi(highHz);
  const med = hzToMidi(medianHz);
  const inRange = (midi: number) => midi >= lo && midi <= hi;
  const keyClass = (k: Key) =>
    `${k.white ? 'key-white' : 'key-black'}${inRange(k.midi) ? ' in-range' : ''}${k.midi === med ? ' is-median' : ''}`;
  const summary = `Median ${midiName(med)} (${Math.round(medianHz)} Hz). Most singing between ${midiName(lo)} and ${midiName(hi)} (${Math.round(lowHz)}–${Math.round(highHz)} Hz).`;

  return (
    <figure className="piano">
      <svg viewBox={`0 0 ${WIDTH} ${WHITE_H + 16}`} className="piano-svg" role="img" aria-label={summary}>
        {KEYS.filter((k) => k.white).map((k) => (
          <rect key={k.midi} x={k.x} y={0} width={WHITE_W} height={WHITE_H} className={keyClass(k)} />
        ))}
        {KEYS.filter((k) => !k.white).map((k) => (
          <rect key={k.midi} x={k.x} y={0} width={BLACK_W} height={BLACK_H} className={keyClass(k)} />
        ))}
        {KEYS.filter((k) => k.midi === med).map((k) => (
          <circle key="median" cx={k.x + (k.white ? WHITE_W : BLACK_W) / 2} cy={k.white ? WHITE_H - 9 : BLACK_H - 7} r={3.5} className="median-dot" />
        ))}
        {KEYS.filter((k) => k.midi % 12 === 0).map((k) => (
          <text key={`l${k.midi}`} x={k.x + 2} y={WHITE_H + 12} className="piano-label">{midiName(k.midi)}</text>
        ))}
      </svg>
      <figcaption className="piano-caption">
        <span><span className="eyebrow">Median</span> <span className="num">{midiName(med)}</span> <span className="muted num">{Math.round(medianHz)} Hz</span></span>
        <span><span className="eyebrow">5–95 %</span> <span className="num">{midiName(lo)}–{midiName(hi)}</span> <span className="muted num">{Math.round(lowHz)}–{Math.round(highHz)} Hz</span></span>
      </figcaption>
    </figure>
  );
}
