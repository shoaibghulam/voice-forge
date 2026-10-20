/**
 * Lyrics: timestamped lines (click to hear that line), the line being sung highlighted,
 * an editor for corrections (saved on the server), copy and a .txt download.
 */
import { useState } from 'react';
import { analysisExportUrl, useSaveLyrics } from '@/api/hooks';
import type { Analysis, Lyrics } from '@/api/schemas';
import { ErrorNote, Loading } from '@/components/Status';
import { Note } from '@/features/shared/Note';
import { formatClock } from '@/features/shared/format';
import { currentLineIndex, describeLanguage, htmlLang, isRightToLeft, lyricsAsText } from './analysisModel';

interface LyricsPanelProps {
  analysis: Analysis;
  time: number;
  onSeek: (seconds: number) => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function DetectedLines({ lyrics, time, onSeek }: { lyrics: Lyrics; time: number; onSeek: (s: number) => void }) {
  const current = currentLineIndex(lyrics.segments, time);
  return (
    <ol className="an-lines" aria-label="Lyric lines" lang={htmlLang(lyrics.language)} dir={isRightToLeft(lyrics.language) ? 'rtl' : 'ltr'}>
      {lyrics.segments.map((line, i) => (
        <li key={`${line.start}-${i}`}>
          <button type="button" className="an-line" aria-current={i === current ? 'true' : undefined} onClick={() => onSeek(line.start)}>
            <span className="num an-line-time" dir="ltr">{formatClock(line.start)}</span>
            <span className="an-line-text">{line.text}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function Editor({ analysis, onDone }: { analysis: Analysis; onDone: () => void }) {
  const [draft, setDraft] = useState(() => lyricsAsText(analysis));
  const save = useSaveLyrics(analysis.id);
  const language = analysis.result.lyrics?.language;
  return (
    <form className="an-editor" onSubmit={(e) => { e.preventDefault(); save.mutate(draft, { onSuccess: onDone }); }}>
      <label className="field">
        <span>Lyrics (one line per line of the song)</span>
        <textarea
          className="input an-textarea" value={draft} onChange={(e) => setDraft(e.target.value)} rows={14}
          lang={htmlLang(language)} dir={isRightToLeft(language) ? 'rtl' : 'auto'}
        />
      </label>
      {save.error ? <ErrorNote error={save.error} /> : null}
      <div className="inline-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save lyrics'}</button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

export function LyricsPanel({ analysis, time, onSeek }: LyricsPanelProps) {
  const [isEditing, setEditing] = useState(false);
  const [copy, setCopy] = useState<CopyState>('idle');
  const restore = useSaveLyrics(analysis.id);
  const lyrics = analysis.result.lyrics;
  const edited = analysis.lyrics_text ?? null;
  const hasText = lyricsAsText(analysis).length > 0;

  const onCopy = () => void copyText(lyricsAsText(analysis)).then((ok) => setCopy(ok ? 'copied' : 'failed'));

  return (
    <section className="section an-lyrics" aria-labelledby="lyrics-title">
      <div className="section-head">
        <h2 id="lyrics-title">Lyrics</h2>
        {lyrics && !isEditing ? (
          <div className="inline-actions">
            <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>Edit</button>
            <button type="button" className="btn btn-sm" onClick={onCopy} disabled={!hasText}>Copy</button>
            <a className="btn btn-sm" href={analysisExportUrl(analysis.id, 'txt')} download>Download .txt</a>
          </div>
        ) : null}
      </div>
      <p className="visually-hidden" aria-live="polite">{copy === 'copied' ? 'Lyrics copied.' : copy === 'failed' ? 'Copy failed.' : ''}</p>
      {!lyrics ? (analysis.status === 'failed' || analysis.status === 'cancelled'
        ? <p className="muted">The lyrics step did not finish.</p>
        : <Loading label="Listening for the words…" />) : null}
      {lyrics ? <p className="chip an-lang">{describeLanguage(lyrics, analysis.language_hint)}</p> : null}
      {lyrics?.approximate ? (
        <Note tone="warn">Whisper has no Balochi model, so this is a rough draft written with Urdu letters. Fix it with Edit.</Note>
      ) : null}
      {lyrics?.note === 'no_singing' ? <Note>No singing was found: this sounds like an instrumental.</Note> : null}
      {lyrics && isEditing ? <Editor analysis={analysis} onDone={() => setEditing(false)} /> : null}
      {lyrics && !isEditing && edited !== null ? (
        <>
          <pre className="an-edited" lang={htmlLang(lyrics.language)} dir={isRightToLeft(lyrics.language) ? 'rtl' : 'auto'}>{edited}</pre>
          <div className="inline-actions">
            <span className="muted an-small">Your edited lyrics. Timestamps belong to the detected lines.</span>
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => restore.mutate(null)} disabled={restore.isPending}>
              Discard my edit
            </button>
          </div>
        </>
      ) : null}
      {lyrics && !isEditing && edited === null && lyrics.segments.length > 0 ? <DetectedLines lyrics={lyrics} time={time} onSeek={onSeek} /> : null}
    </section>
  );
}
