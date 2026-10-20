/** Shapes for the generated run: seeded randomness, loss curves, song titles. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface LossRow {
  mel: number;
  kl: number;
  fm: number;
  adv: number;
  g_total: number;
  d_adv: number;
  grad_g: number;
  grad_d: number;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** RVC-like losses at fractional epoch `x`: mel and kl decay, fm rises slowly, GAN terms hover. */
export function lossAt(x: number, rnd: () => number): LossRow {
  const noise = () => (rnd() - 0.5) * 2;
  const mel = 17.5 + 13 * Math.exp(-x / 9) + noise() * 0.9;
  const kl = 0.9 + 1.6 * Math.exp(-x / 6) + noise() * 0.12;
  const fm = 9.5 - 3.2 * Math.exp(-x / 10) + noise() * 0.5;
  const adv = 2.6 + noise() * 0.35;
  const dAdv = 2.45 + noise() * 0.3;
  return {
    mel: round(mel),
    kl: round(kl),
    fm: round(fm),
    adv: round(adv),
    g_total: round(mel + kl + fm + adv),
    d_adv: round(dAdv),
    grad_g: round(40 + noise() * 12),
    grad_d: round(18 + noise() * 6),
  };
}

export const SONG_TITLES = [
  'Laila Mor (1978 cassette).mp3',
  'Kech Makuran Zahirok.mp3',
  'Dazgohar live Turbat.m4a',
  'Shey Mureed side B.mp3',
  'Hani o Shey Mureed.flac',
  'Lewa night session.wav',
  'Zaheerok slow.mp3',
  'Mehrgan wedding song.mp3',
  'Gwadar shore.ogg',
  'Sasui Punnu (radio).mp3',
  'Balochi Sepat.mp3',
  'Nazink for the bride.opus',
];
