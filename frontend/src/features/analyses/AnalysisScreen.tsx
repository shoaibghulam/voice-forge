/**
 * `/analyses/$id` — while the job runs, the live signal path; as stages finish, the
 * player, timeline, lyrics and music style fill in. Everything seeks one player.
 */
import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, getRouteApi } from '@tanstack/react-router';
import { TERMINAL_STATUSES } from '@/api/events';
import { analysisExportUrl, keys, useAnalysis } from '@/api/hooks';
import type { Analysis } from '@/api/schemas';
import { ErrorNote, Loading } from '@/components/Status';
import { StatusChip } from '@/features/shared/StatusChip';
import { formatDate } from '@/features/shared/format';
import '@/features/shared/library.css';
import { AnalysisPlayer } from './AnalysisPlayer';
import { AnalysisProgress } from './AnalysisProgress';
import { LANGUAGE_OPTIONS } from './analysisModel';
import { LyricsPanel } from './LyricsPanel';
import { StyleCard } from './StyleCard';
import { Timeline } from './Timeline';
import { useAnalysisPlayer } from './useAnalysisPlayer';
import './analyses.css';

const route = getRouteApi('/analyses/$id');

function hintLabel(analysis: Analysis): string {
  return LANGUAGE_OPTIONS.find((o) => o.value === analysis.language_hint)?.label ?? analysis.language_hint;
}

function Result({ analysis }: { analysis: Analysis }) {
  const player = useAnalysisPlayer(
    { original: analysis.audio.original, vocals: analysis.audio.vocals },
    analysis.result.duration_s ?? 0,
  );
  return (
    <>
      <section className="section an-listen" aria-labelledby="listen-title">
        <div className="section-head"><h2 id="listen-title">Listen</h2></div>
        <AnalysisPlayer player={player} />
      </section>
      <Timeline analysis={analysis} time={player.time} onSeek={player.seek} />
      <div className="an-columns">
        <LyricsPanel analysis={analysis} time={player.time} onSeek={player.seek} />
        <StyleCard analysis={analysis} />
      </div>
    </>
  );
}

export function AnalysisScreen() {
  const { id } = route.useParams();
  const analysis = useAnalysis(id);
  const qc = useQueryClient();
  const data = analysis.data;
  const refresh = useCallback(() => void qc.invalidateQueries({ queryKey: keys.analysis(id) }), [qc, id]);
  const showProgress = Boolean(data?.job_id && data.status !== 'done');

  return (
    <article className="page an-page" aria-labelledby="analysis-title">
      <header className="page-head">
        <div>
          <Link to="/analyses" className="eyebrow">← Analyses</Link>
          <h1 id="analysis-title" className="an-title">{data?.original_filename ?? (analysis.isPending ? 'Loading…' : 'Analysis')}</h1>
          {data ? (
            <p className="muted an-meta">
              Language: {hintLabel(data)}{data.created_at ? ` · ${formatDate(data.created_at)}` : ''}
            </p>
          ) : null}
        </div>
        {data ? (
          <div className="inline-actions">
            <StatusChip status={data.status} context="Analysis status" />
            {TERMINAL_STATUSES.has(data.status) ? (
              <a className="btn btn-sm" href={analysisExportUrl(data.id, 'json')} download>Export JSON</a>
            ) : null}
          </div>
        ) : null}
      </header>
      {analysis.isPending ? <Loading label="Loading the analysis…" /> : null}
      {analysis.error ? <ErrorNote error={analysis.error} onRetry={() => void analysis.refetch()} /> : null}
      {data?.job_id && showProgress ? <AnalysisProgress jobId={data.job_id} onStageDone={refresh} /> : null}
      {data ? <Result analysis={data} /> : null}
    </article>
  );
}
