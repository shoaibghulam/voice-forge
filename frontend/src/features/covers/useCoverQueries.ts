/**
 * Queries the cover screens need with an "only when there is an id" guard — the shared
 * hooks in api/hooks.ts always fire. Same query keys, so caches are shared.
 */
import { useQuery } from '@tanstack/react-query';
import { TERMINAL_STATUSES } from '@/api/events';
import { api, apiList } from '@/api/client';
import { keys, useSingers } from '@/api/hooks';
import { jobSchema, runSchema, type Cover } from '@/api/schemas';
import { formatDate } from '@/features/shared/format';

const JOB_POLL_MS = 2000;

export function useOptionalRuns(singerId: string) {
  return useQuery({
    queryKey: keys.runs(singerId),
    queryFn: () => apiList(`/singers/${encodeURIComponent(singerId)}/runs`, runSchema),
    enabled: singerId.length > 0,
  });
}

/** Singer names by id, from the (shared, cached) singers list. Covers carry only the id. */
export function useSingerNames(): ReadonlyMap<string, string> {
  const singers = useSingers();
  const items = singers.data?.items ?? [];
  return new Map(items.map((s) => [s.id, s.name]));
}

export function coverTitle(cover: Cover, singerName: string | undefined): string {
  const who = singerName ?? 'Unknown singer';
  return cover.created_at ? `${who} · ${formatDate(cover.created_at)}` : who;
}

/** A cover's convert job, polled until it reaches a terminal state. */
export function useCoverJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: keys.job(jobId ?? ''),
    queryFn: () => api(`/jobs/${encodeURIComponent(jobId ?? '')}`, jobSchema),
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data && TERMINAL_STATUSES.has(query.state.data.status) ? false : JOB_POLL_MS),
  });
}
