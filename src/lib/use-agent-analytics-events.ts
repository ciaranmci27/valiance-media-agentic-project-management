'use client';

import { createClient } from '@/lib/supabase/client';
import {
  fetchAgentActivityRange,
  fetchBillingGapReviews,
  fetchTaskReopens,
} from '@/lib/supabase/queries';
import { prefetchQuery, useCachedQuery } from '@/lib/query-cache';
import type { DateRange } from '@/lib/finance/summary';
import type { AgentActivity, FleetAgentActivity } from '@/lib/types';
import type { AgentHealthTransition } from '@/lib/agent-analytics';

export interface AgentAnalyticsEvents {
  rows: AgentActivity[];
  /** Fleet host alerts: no agent, so not AgentActivity rows. */
  fleet: FleetAgentActivity[];
  /** No answer yet. Callers show their own shape, never stale numbers. */
  loading: boolean;
  /** The range held more rows than the ceiling, so figures under-report. */
  truncated: boolean;
  /** The query failed; the report cannot speak for this range. */
  failed: boolean;
}

interface RangeResult { rows: AgentActivity[]; fleet: FleetAgentActivity[]; truncated: boolean }

// v2: the read now runs past the range end and returns fleet rows.
const keyFor = (range: DateRange) => `agent-activity:v2:${range.startKey}:${range.endKey}`;

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
/**
 * Recorded container-state transitions, for availability.
 *
 * Kept separate from the event query because it answers a different question
 * and is tiny: only changes are stored, so a stable fleet writes almost nothing.
 * The whole history is fetched rather than a range slice, since the state before
 * a range is what establishes the state during it.
 */
export function useAgentHealthHistory(options?: { enabled?: boolean }): {
  rows: AgentHealthTransition[];
  loading: boolean;
} {
  const enabled = options?.enabled !== false;
  const query = useCachedQuery<AgentHealthTransition[]>(
    enabled ? 'agent-health-history' : 'agent-health-history:disabled',
    enabled
      ? async () => {
          const supabase = createClient();
          const { data, error } = await supabase
            .from('agent_health_history')
            .select('member_id, container_running, changed_at')
            .order('changed_at', { ascending: true })
            .limit(5000);
          if (error) throw error;
          return (data ?? []) as AgentHealthTransition[];
        }
      : async () => [],
  );
  return { rows: query.data ?? [], loading: enabled && query.loading };
}

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
    enabled ? () => fetchRange(range) : async () => ({ rows: [], fleet: [], truncated: false }),
  );
  return {
    rows: query.data?.rows ?? [],
    fleet: query.data?.fleet ?? [],
    loading: enabled && query.loading,
    truncated: query.data?.truncated ?? false,
    failed: enabled && query.failed,
  };
}

export type BillingGapReviewRow = Awaited<ReturnType<typeof fetchBillingGapReviews>>[number];

// Module-level empties keep a missing answer referentially stable, so memos
// downstream do not recompute on every render while a query has failed.
const NO_REVIEWS: BillingGapReviewRow[] = [];

/**
 * Ciaran's Reconciled / Dismissed marks on billing gaps. `available` is false
 * when the reviews table cannot be read (its migration is not applied yet).
 */
export function useBillingGapReviews(options?: { enabled?: boolean }): {
  rows: BillingGapReviewRow[];
  loading: boolean;
  available: boolean;
} {
  const enabled = options?.enabled !== false;
  const query = useCachedQuery<BillingGapReviewRow[]>(
    enabled ? 'agent-billing-gap-reviews' : 'agent-billing-gap-reviews:disabled',
    enabled ? () => fetchBillingGapReviews(createClient()) : async () => NO_REVIEWS,
  );
  return { rows: query.data ?? NO_REVIEWS, loading: enabled && query.loading, available: !(enabled && query.failed) };
}

type ReopenAnswer = Awaited<ReturnType<typeof fetchTaskReopens>>;

/**
 * Task reopens and when their recorder began. Both null when they cannot be
 * read (the migration is not applied yet): not tracked, never zero.
 */
export function useTaskReopens(options?: { enabled?: boolean }): {
  rows: ReopenAnswer['rows'] | null;
  since: string | null;
  loading: boolean;
} {
  const enabled = options?.enabled !== false;
  const query = useCachedQuery<ReopenAnswer | null>(
    enabled ? 'task-reopens:v2' : 'task-reopens:disabled',
    enabled ? () => fetchTaskReopens(createClient()) : async () => null,
  );
  const answer = query.failed ? null : query.data ?? null;
  return { rows: answer?.rows ?? null, since: answer?.since ?? null, loading: enabled && query.loading };
}
