/** Conversion controls with plain names (docs/07 "Cover"); advanced ones collapsed. */
import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { REVERBS, type CoverSettings } from '@/api/schemas';
import { Note } from '@/features/shared/Note';

interface CoverControlsProps {
  value: CoverSettings;
  onChange: (value: CoverSettings) => void;
}

interface RangeProps {
  label: string;
  help: ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}

const PAGE_STEPS = 4;

/** Keyboard stepping handled here so every browser (and jsdom) steps exactly once. */
function keyedValue(key: string, value: number, { min, max, step }: Pick<RangeProps, 'min' | 'max' | 'step'>): number | null {
  const deltas: Record<string, number> = {
    ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step,
    PageUp: step * PAGE_STEPS, PageDown: -step * PAGE_STEPS,
  };
  if (key === 'Home') return min;
  if (key === 'End') return max;
  const delta = deltas[key];
  if (delta === undefined) return null;
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(Math.min(max, Math.max(min, value + delta)).toFixed(decimals));
}

function Range({ label, help, min, max, step, value, format, onChange }: RangeProps) {
  const id = useId();
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const next = keyedValue(event.key, value, { min, max, step });
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onChange(next);
  };
  return (
    <div className="control">
      <div className="control-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="num">{format(value)}</output>
      </div>
      <input
        id={id} type="range" min={min} max={max} step={step} value={value} className="control-range"
        aria-describedby={`${id}-help`} aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.target.value))} onKeyDown={onKeyDown}
      />
      <p id={`${id}-help`} className="muted control-help">{help}</p>
    </div>
  );
}

const signed = (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');

export const DEFAULT_SETTINGS: CoverSettings = {
  octave_auto: true,
  semitones: 0,
  timbre_strength: 0.4,
  protect: 0.4,
  vocal_level: 1,
  reverb: 'light',
};

export function CoverControls({ value, onChange }: CoverControlsProps) {
  const set = (patch: Partial<CoverSettings>) => onChange({ ...value, ...patch });
  return (
    <div className="controls">
      <fieldset className="control">
        <legend>Pitch</legend>
        <label className="check">
          <input type="checkbox" checked={value.octave_auto}
            onChange={(e) => set({ octave_auto: e.target.checked })} />
          <span>Switch octave automatically (for a singer of the other register)</span>
        </label>
        <Range
          label="Semitones" min={-12} max={12} step={1} value={value.semitones} format={(v) => `${signed(v)} st`}
          help="Moves the new vocal up or down."
          onChange={(v) => set({ semitones: v })}
        />
        {value.semitones !== 0 ? (
          <Note tone="warn">A semitone shift also shifts the backing track, so the whole song changes key.</Note>
        ) : null}
      </fieldset>
      <Range
        label="Timbre strength" min={0} max={1} step={0.05} value={value.timbre_strength} format={(v) => v.toFixed(2)}
        help="How strongly the singer’s tone colour is pressed onto the vocal. Higher is closer to them, but can add artefacts."
        onChange={(v) => set({ timbre_strength: v })}
      />
      <fieldset className="control">
        <legend>Reverb</legend>
        <div role="group" aria-label="Reverb amount" className="toggle-group">
          {REVERBS.map((r) => (
            <button key={r} type="button" aria-pressed={value.reverb === r} onClick={() => set({ reverb: r })}>{r}</button>
          ))}
        </div>
        <p className="muted control-help">Room added back to the dry converted vocal.</p>
      </fieldset>
      <details className="advanced">
        <summary>Advanced</summary>
        <div>
          <Range
            label="Breath protection" min={0} max={0.5} step={0.05} value={value.protect} format={(v) => v.toFixed(2)}
            help="Keeps breaths and consonants from the original. Lower converts more of them."
            onChange={(v) => set({ protect: v })}
          />
          <Range
            label="Vocal level" min={0} max={2} step={0.05} value={value.vocal_level} format={(v) => `${v.toFixed(2)}×`}
            help="Loudness of the new vocal against the backing."
            onChange={(v) => set({ vocal_level: v })}
          />
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(DEFAULT_SETTINGS)}>Reset to defaults</button>
        </div>
      </details>
    </div>
  );
}
