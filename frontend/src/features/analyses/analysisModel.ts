/** Pure helpers for the Analyse screens: language words, lyric lookup, timeline geometry. */
import type { Analysis, LanguageHint, LyricLine, Lyrics, Section } from '@/api/schemas';

export const LANGUAGE_OPTIONS: readonly { value: LanguageHint; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'bal', label: 'Balochi' },
  { value: 'ur', label: 'Urdu' },
  { value: 'fa', label: 'Persian (Farsi)' },
  { value: 'en', label: 'English' },
];

const NAMES: Record<string, string> = { bal: 'Balochi', ur: 'Urdu', fa: 'Persian', en: 'English' };
const RTL = new Set(['bal', 'ur', 'fa']);

export function languageName(code: string | null | undefined): string {
  return code ? NAMES[code] ?? code : 'Unknown';
}

export function isRightToLeft(code: string | null | undefined): boolean {
  return Boolean(code && RTL.has(code));
}

/** HTML `lang` for the lyric text: Balochi is written here in Urdu's script. */
export function htmlLang(code: string | null | undefined): string | undefined {
  if (!code) return undefined;
  return code === 'bal' ? 'bal-Arab' : code;
}

export function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function describeLanguage(lyrics: Pick<Lyrics, 'language' | 'language_probability' | 'approximate'>, hint: LanguageHint): string {
  if (!lyrics.language) return 'No singing found';
  const name = languageName(lyrics.language);
  if (lyrics.approximate) return `${name} · rough draft (written with Urdu)`;
  if (hint === 'auto' && typeof lyrics.language_probability === 'number') {
    return `${name} · detected, ${percent(lyrics.language_probability)} sure`;
  }
  return `${name} · as chosen`;
}

/** Index of the line being sung at `time`, or -1 between lines. */
export function currentLineIndex(segments: readonly LyricLine[], time: number): number {
  return segments.findIndex((s) => time >= s.start && time < s.end);
}

/** What "Copy" and the .txt download carry: the user's edit if any, else the detected lines. */
export function lyricsAsText(analysis: Analysis): string {
  if (analysis.lyrics_text !== null && analysis.lyrics_text !== undefined) return analysis.lyrics_text;
  return (analysis.result.lyrics?.segments ?? []).map((s) => s.text).join('\n');
}

export interface SectionSpan extends Section {
  /** Share of the song's length, 0..1: the section's width on the timeline. */
  share: number;
}

export function sectionSpans(sections: readonly Section[], duration: number | null): SectionSpan[] {
  const total = duration && duration > 0 ? duration : sections.at(-1)?.end ?? 0;
  if (total <= 0) return [];
  return sections.map((s) => ({ ...s, share: Math.max(0, s.end - s.start) / total }));
}

const STEM_LABELS: Record<string, string> = { vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other instruments' };

export interface StemRow {
  key: string;
  label: string;
  /** 0..1 */
  fraction: number;
}

export function stemRows(stems: Record<string, number>): StemRow[] {
  return Object.entries(stems)
    .map(([key, pct]) => ({ key, label: STEM_LABELS[key] ?? key, fraction: Math.min(1, Math.max(0, pct / 100)) }))
    .sort((a, b) => b.fraction - a.fraction);
}

export const SECTION_NAMES: Record<Section['label'], string> = {
  intro: 'Intro', verse: 'Verse', chorus: 'Chorus', instrumental: 'Instrumental', outro: 'Outro',
};
