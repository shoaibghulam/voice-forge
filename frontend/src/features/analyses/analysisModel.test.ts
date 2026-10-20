import { describe, expect, it } from 'vitest';
import { REAL_RESULT } from '@/test/fixtures/analysisResult';
import type { Analysis } from '@/api/schemas';
import {
  currentLineIndex, describeLanguage, isRightToLeft, lyricsAsText, percent, sectionSpans, stemRows,
} from './analysisModel';

const segments = REAL_RESULT.lyrics?.segments ?? [];

function analysis(patch: Partial<Analysis> = {}): Analysis {
  return {
    id: 'a1', job_id: 'j1', status: 'done', original_filename: 'Laila.mp3', created_at: null, language_hint: 'auto',
    result: REAL_RESULT, lyrics_text: null, audio: { original: null, vocals: null, accompaniment: null }, ...patch,
  };
}

describe('analysisModel', () => {
  it('finds the line being sung at a time, or none between lines', () => {
    expect(currentLineIndex(segments, 3)).toBe(0);
    expect(currentLineIndex(segments, 10)).toBe(-1); // 7.04 → 14.4 is a gap
    expect(currentLineIndex(segments, 15)).toBe(1);
    expect(currentLineIndex([], 3)).toBe(-1);
  });

  it('writes Arabic-script languages right to left', () => {
    expect(isRightToLeft('fa')).toBe(true);
    expect(isRightToLeft('bal')).toBe(true);
    expect(isRightToLeft('ur')).toBe(true);
    expect(isRightToLeft('en')).toBe(false);
    expect(isRightToLeft(null)).toBe(false);
  });

  it('describes the language in words, flagging Balochi as a draft', () => {
    expect(describeLanguage({ language: 'fa', language_probability: 0.832, approximate: false }, 'auto'))
      .toBe('Persian · detected, 83% sure');
    expect(describeLanguage({ language: 'bal', language_probability: 1, approximate: true }, 'bal'))
      .toBe('Balochi · rough draft (written with Urdu)');
    expect(describeLanguage({ language: 'en', language_probability: 1, approximate: false }, 'en'))
      .toBe('English · as chosen');
    expect(describeLanguage({ language: null, approximate: false }, 'auto')).toBe('No singing found');
  });

  it('exports the edited lyrics when there are any, else the detected lines', () => {
    expect(lyricsAsText(analysis())).toBe(segments.map((s) => s.text).join('\n'));
    expect(lyricsAsText(analysis({ lyrics_text: 'my words' }))).toBe('my words');
    expect(lyricsAsText(analysis({ result: {} }))).toBe('');
  });

  it('lays sections out in proportion to their length', () => {
    const spans = sectionSpans(REAL_RESULT.sections ?? [], REAL_RESULT.duration_s ?? null);

    expect(spans).toHaveLength(7);
    expect(spans.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 5);
    expect(spans[0]?.share).toBeCloseTo(39.36 / 193.02, 5);
    expect(sectionSpans([], 100)).toEqual([]);
  });

  it('orders stem shares and keeps them within 0..1 for the bars', () => {
    const rows = stemRows({ vocals: 49, drums: 5.8, bass: 0, other: 45.2 });

    expect(rows.map((r) => r.label)).toEqual(['Vocals', 'Other instruments', 'Drums', 'Bass']);
    expect(rows[0]?.fraction).toBeCloseTo(0.49);
    expect(percent(0.2834)).toBe('28%');
  });
});
