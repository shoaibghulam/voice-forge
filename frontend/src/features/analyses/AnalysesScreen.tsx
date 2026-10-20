/** `/analyses` — every song analysed, newest first, with its key facts once done. */
import { Link } from '@tanstack/react-router';
import { useAnalyses } from '@/api/hooks';
import type { Analysis } from '@/api/schemas';
import { Empty, ErrorNote, Loading } from '@/components/Status';
import { StatusChip } from '@/features/shared/StatusChip';
import { formatDate } from '@/features/shared/format';
import { languageName } from './analysisModel';
import './analyses.css';

function summary(analysis: Analysis): string {
  const { lyrics, style } = analysis.result;
  const parts = [
    lyrics?.language ? languageName(lyrics.language) : null,
    style ? `${Math.round(style.tempo_bpm)} BPM` : null,
    style ? `${style.key} ${style.scale}` : null,
    style?.genre[0]?.label ?? null,
  ];
  const text = parts.filter(Boolean).join(' · ');
  return text || (analysis.status === 'done' ? 'no result' : 'in progress');
}

export function AnalysesScreen() {
  const analyses = useAnalyses();
  const items = analyses.data?.items ?? [];

  return (
    <section className="page" aria-labelledby="analyses-title">
      <header className="page-head">
        <div>
          <span className="eyebrow">Listen closely</span>
          <h1 id="analyses-title">Analyse</h1>
          <p className="muted">Upload a song: get its lyrics, tempo, key, instruments, genre, mood and shape.</p>
        </div>
        <Link to="/analyses/new" className="btn btn-primary">New analysis</Link>
      </header>
      {analyses.isPending ? <Loading label="Loading analyses…" /> : null}
      {analyses.error ? <ErrorNote error={analyses.error} onRetry={() => void analyses.refetch()} /> : null}
      {analyses.isSuccess && items.length === 0 ? (
        <Empty title="Nothing analysed yet">Upload a song to read its lyrics and music style.</Empty>
      ) : null}
      {items.length > 0 ? (
        <ol className="an-list sheet" aria-label="Analyses, newest first">
          {items.map((analysis) => (
            <li key={analysis.id} className="an-row">
              <span className="an-glyph" aria-hidden="true">≋</span>
              <div className="an-row-title">
                <Link to="/analyses/$id" params={{ id: analysis.id }} className="an-row-link">{analysis.original_filename}</Link>
                <span className="muted an-small">{summary(analysis)}</span>
              </div>
              <StatusChip status={analysis.status} context="Analysis status" />
              <span className="num muted an-small an-row-date">{analysis.created_at ? formatDate(analysis.created_at) : ''}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
