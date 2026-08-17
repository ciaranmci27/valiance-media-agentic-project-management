'use client';

import { createClient } from '@/lib/supabase/client';
import { fetchAgentActivityRange } from '@/lib/supabase/queries';
import { prefetchQuery, useCachedQuery } from '@/lib/query-cache';
import type { DateRange } from '@/lib/finance/summary';
import type { AgentActivity } from '@/lib/types';

export interface AgentAnalyticsEvents {
  rows: AgentActivity[];
  /** No answer yet. Callers show their own shape, never stale numbers. */
  loading: boolean;
  /** The range held more rows than the ceiling, so figures under-report. */
  truncated: boolean;
  /** The query failed; the report cannot speak for this range. */
  failed: boolean;
}

interface RangeResult { rows: AgentActivity[]; truncated: boolean }

const keyFor = (range: DateRange) => `agent-activity:${range.startKey}:${range.endKey}`;

const fetchRange = async (range: DateRange): Promise<RangeResult> => {
  const supabase = createClient();
  return fetchAgentActivityRange(supabase, range);
};

/**
 * Warm a range before anyone looks at it, so opening the report is instant.
 * Safe to call repeatedly: concurrent callers share one request.
 */
export function prefetchAgentAnalytics(range: DateRange): void {
  void prefetchQuery(keyFor(range), () => fetchRange(range));
}

/**
 * Every agent event in a date range, for analytics.
 *
 * The app store keeps a small window of RECENT activity, which is the right
 * shape for a feed and the wrong shape for a report: a month of history runs to
 * thousands of rows, and telemetry is excluded from that window on purpose.
 *
 * This deliberately does NOT fall back to the store's rows while loading.
 * Doing so painted the page with plausible numbers computed from a hundred
 * narrative events, which then jumped to the real figures a moment later: the
 * page looked wrong, then looked broken for changing. A report either shows a
 * measured answer or shows that it is still measuring.
 */
export function useAgentAnalyticsEvents(
  range: DateRange,
  options?: { enabled?: boolean },
): AgentAnalyticsEvents {
  // Demo mode has no workspace to query; it renders from fixtures the store
  // already holds, so the report opens instantly there rather than waiting on
  // a request that would return nothing.
  const enabled = options?.enabled !== false;
  const key = enabled ? keyFor(range) : 'agent-activity:disabled';
  const query = useCachedQuery<RangeResult>(
    key,
    enabled ? () => fetchRange(range) : async () => ({ rows: [], truncated: false }),
  );
  return {
    rows: query.data?.rows ?? [],
    loading: enabled && query.loading,
    truncated: query.data?.truncated ?? false,
    failed: enabled && query.failed,
  };
}
