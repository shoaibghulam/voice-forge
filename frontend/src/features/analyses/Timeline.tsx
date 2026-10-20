/**
 * The song's shape on one strip: sections in proportion to their length, sung ones in the
 * signal colour, instrumental ones plain; a playhead that grows by scaleX; click to hear.
 */
import type { Analysis } from '@/api/schemas';
import { Loading } from '@/components/Status';
import { formatClock } from '@/features/shared/format';
import { SECTION_NAMES, sectionSpans } from './analysisModel';

interface TimelineProps {
  analysis: Analysis;
  time: number;
  onSeek: (seconds: number) => void;
}

export function Timeline({ analysis, time, onSeek }: TimelineProps) {
  const sections = analysis.result.sections;
  const duration = analysis.result.duration_s ?? sections?.at(-1)?.end ?? 0;
  const spans = sectionSpans(sections ?? [], duration);
  const played = duration > 0 ? Math.min(1, Math.max(0, time / duration)) : 0;
  const columns = spans.map((s) => `minmax(0, ${s.share.toFixed(4)}fr)`).join(' ');

  return (
    <section className="section an-timeline" aria-labelledby="timeline-title">
      <div className="section-head">
        <h2 id="timeline-title">Timeline</h2>
        {spans.length > 0 ? (
          <p className="an-legend muted">
            <span className="an-key" data-vocal="true" aria-hidden="true" /> singing
            <span className="an-key" data-vocal="false" aria-hidden="true" /> instrumental
            <span className="an-small"> · sections are estimated</span>
          </p>
        ) : null}
      </div>
      {!sections ? (analysis.status === 'failed' || analysis.status === 'cancelled'
        ? <p className="muted">The timeline step did not finish.</p>
        : <Loading label="Finding verses and choruses…" />) : null}
      {spans.length > 0 ? (
        <div className="an-strip-wrap">
          <ol className="an-strip" style={{ gridTemplateColumns: columns }} aria-label="Song sections, in order">
            {spans.map((s) => {
              const name = SECTION_NAMES[s.label];
              return (
                <li key={`${s.start}-${s.label}`} className="an-section" data-vocal={s.has_vocals} data-label={s.label}>
                  <button
                    type="button" className="an-section-button" onClick={() => onSeek(s.start)}
                    aria-label={`${name}, ${formatClock(s.start)} to ${formatClock(s.end)}, ${s.has_vocals ? 'singing' : 'instrumental'}. Play from here`}
                  >
                    <span className="an-section-name">{name}</span>
                    <span className="an-section-icon" aria-hidden="true">{s.has_vocals ? '♪' : '–'}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <span className="an-playhead" aria-hidden="true" style={{ transform: `scaleX(${played})` }} />
          <div className="an-ruler num muted" aria-hidden="true">
            <span>0:00</span>
            <span>{formatClock(duration)}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
