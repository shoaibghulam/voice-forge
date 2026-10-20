/**
 * Music style: tempo, key and loudness read like a console's meter bridge; what plays
 * (stem shares as bars, instrument tags with scores); genre and mood, marked approximate.
 */
import type { Analysis, Style, TagScore } from '@/api/schemas';
import { Loading } from '@/components/Status';
import { Note } from '@/features/shared/Note';
import { percent, stemRows } from './analysisModel';

interface StyleCardProps {
  analysis: Analysis;
}

function Fact({ label, value, unit, detail }: { label: string; value: string; unit?: string; detail?: string }) {
  return (
    <div className="an-fact">
      <dt className="eyebrow">{label}</dt>
      <dd>
        <span className="num an-fact-value">{value}</span>
        {unit ? <span className="an-fact-unit"> {unit}</span> : null}
        {detail ? <span className="muted an-fact-detail">{detail}</span> : null}
      </dd>
    </div>
  );
}

function RankedTags({ title, tags }: { title: string; tags: readonly TagScore[] }) {
  return (
    <div className="an-ranked">
      <h4 className="eyebrow">{title}</h4>
      <ol className="an-ranked-list" aria-label={`${title}, most likely first`}>
        {tags.map((tag) => (
          <li key={tag.label} className="an-ranked-row">
            <span className="an-ranked-label">{tag.label}</span>
            <span className="bar an-ranked-bar" aria-hidden="true"><span style={{ transform: `scaleX(${tag.score})` }} /></span>
            <span className="num muted">{percent(tag.score)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function StyleFacts({ style }: { style: Style }) {
  const loudness = style.loudness_lufs ?? style.loudness_dbfs;
  return (
    <dl className="an-facts">
      <Fact label="Tempo" value={Math.round(style.tempo_bpm).toString()} unit="BPM" detail={`beat ${percent(style.tempo_confidence)} steady`} />
      <Fact label="Key" value={style.key} unit={style.scale} detail={`fit ${percent(style.key_confidence)}`} />
      <Fact
        label="Loudness" value={loudness.toFixed(1)} unit={style.loudness_lufs !== null && style.loudness_lufs !== undefined ? 'LUFS' : 'dBFS'}
        detail={`mean ${style.loudness_dbfs.toFixed(1)} dBFS`}
      />
    </dl>
  );
}

function Instruments({ style }: { style: Style }) {
  const rows = stemRows(style.instruments.stems);
  return (
    <div className="an-instruments">
      <h3 className="an-sub">Instruments</h3>
      <ul className="an-stems" aria-label="Share of the sound">
        {rows.map((row) => (
          <li key={row.key} className="an-stem">
            <span className="an-stem-label">{row.label}</span>
            <span className="bar an-stem-bar" data-stem={row.key} aria-hidden="true"><span style={{ transform: `scaleX(${row.fraction})` }} /></span>
            <span className="num muted">{percent(row.fraction)}</span>
          </li>
        ))}
      </ul>
      <ul className="an-tags" aria-label="Instruments heard">
        {style.instruments.tags.map((tag) => (
          <li key={tag.label} className="chip">{tag.label} <span className="num muted">{percent(tag.score)}</span></li>
        ))}
      </ul>
    </div>
  );
}

export function StyleCard({ analysis }: StyleCardProps) {
  const style = analysis.result.style;
  return (
    <section className="section an-style" aria-labelledby="style-title">
      <div className="section-head"><h2 id="style-title">Music style</h2></div>
      {!style ? (analysis.status === 'failed' || analysis.status === 'cancelled'
        ? <p className="muted">The style step did not finish.</p>
        : <Loading label="Listening to the music…" />) : null}
      {style ? (
        <>
          <StyleFacts style={style} />
          <Instruments style={style} />
          <div className="an-genre-mood">
            <h3 className="an-sub">Genre and mood</h3>
            <div className="an-ranked-pair">
              <RankedTags title="Genre" tags={style.genre} />
              <RankedTags title="Mood" tags={style.mood} />
            </div>
            <Note>Approximate: genre, mood and instrument tags come from a general audio model (CLAP) that has heard little Balochi music.</Note>
          </div>
        </>
      ) : null}
    </section>
  );
}
