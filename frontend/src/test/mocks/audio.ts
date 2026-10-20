/**
 * Synthesised audio for mock mode: a short mono 16-bit WAV of a "sung" tone (a few
 * harmonics, vibrato, a slow phrase envelope). The base pitch is derived from a key so
 * every clip / checkpoint / cover track sounds a little different. Buffers are cached.
 */
const SAMPLE_RATE = 8_000;
const cache = new Map<string, ArrayBuffer>();

/** Small stable hash → 0..1. */
export function hashUnit(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

export interface ToneOptions {
  seconds: number;
  /** Base frequency in Hz; defaults to one derived from the key (A2–A3 range). */
  baseHz?: number;
  /** 0..1 amount of broadband "backing" noise mixed in. */
  noise?: number;
  /** Drop the sung tone entirely (a backing-only track). */
  toneless?: boolean;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function sampleAt(t: number, seconds: number, hz: number, opts: ToneOptions, rnd: () => number): number {
  const vibrato = 1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t);
  const phase = 2 * Math.PI * hz * vibrato * t;
  const phrase = Math.sin(Math.PI * Math.min(1, t / seconds)) ** 0.6;
  const syllable = 0.65 + 0.35 * Math.sin(2 * Math.PI * 1.6 * t) ** 2;
  const tone = opts.toneless
    ? 0
    : (Math.sin(phase) + 0.45 * Math.sin(2 * phase) + 0.2 * Math.sin(3 * phase)) * phrase * syllable * 0.45;
  const noise = (opts.noise ?? 0) * (rnd() * 2 - 1) * 0.3;
  return Math.max(-1, Math.min(1, tone + noise));
}

function seeded(seed: number): () => number {
  let s = Math.floor(seed * 2 ** 31) || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Build (or return the cached) WAV for `key`. */
export function synthWav(key: string, opts: ToneOptions): ArrayBuffer {
  const cacheKey = `${key}|${opts.seconds}|${opts.baseHz ?? ''}|${opts.noise ?? 0}|${opts.toneless ? 1 : 0}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const frames = Math.round(SAMPLE_RATE * opts.seconds);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, frames * 2, true);
  const hz = opts.baseHz ?? 110 * 2 ** hashUnit(key);
  const rnd = seeded(hashUnit(`${key}:noise`));
  for (let i = 0; i < frames; i += 1) {
    const value = sampleAt(i / SAMPLE_RATE, opts.seconds, hz, opts, rnd);
    view.setInt16(44 + i * 2, Math.round(value * 32_767), true);
  }
  cache.set(cacheKey, buffer);
  return buffer;
}

/** Normalised peaks (0..1) for a waveform preview, `count` values long. */
export function peaksFor(key: string, count = 120): number[] {
  const rnd = seeded(hashUnit(`${key}:peaks`));
  const peaks: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const envelope = Math.sin((Math.PI * (i + 0.5)) / count) ** 0.5;
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin((i / count) * Math.PI * 5));
    peaks.push(Math.round(Math.min(1, envelope * syllable * (0.7 + 0.3 * rnd())) * 1000) / 1000);
  }
  return peaks;
}

export function wavResponseInit(byteLength: number): ResponseInit {
  return {
    status: 200,
    headers: {
      'content-type': 'audio/wav',
      'content-length': String(byteLength),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    },
  };
}
