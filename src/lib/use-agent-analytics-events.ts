'use client';

import { createClient } from '@/lib/supabase/client';
import {
  fetchAgentActivityRange,
  fetchAgentAnalyticsWindow,
  fetchBillingGapReviews,
  fetchTaskReopens,
} from '@/lib/supabase/queries';
import { useRead, warmRead, type Read } from '@/lib/query-cache';
import type { DateRange } from '@/lib/finance/summary';
import type { AgentActivity, FleetAgentActivity } from '@/lib/types';
import type { AttributionDelta } from '@/lib/agent-telemetry-analytics';
import type { AgentHealthTransition } from '@/lib/agent-analytics';

export interface AgentAnalyticsEvents {
  rows: AgentActivity[];
  /** Fleet host alerts: no agent, so not AgentActivity rows. */
  fleet: FleetAgentActivity[];
  /** Directed-session usage for token attribution, when usage came summed per hour. */
  attribution: AttributionDelta[] | undefined;
  /** No answer yet. Callers show their own shape, never stale numbers. */
  loading: boolean;
  /** The range held more rows than the ceiling, so figures under-report. */
  truncated: boolean;
  /** The query failed; the report cannot speak for this range. */
  failed: boolean;
}

interface RangeResult {
  rows: AgentActivity[];
  fleet: FleetAgentActivity[];
  truncated: boolean;
  attribution?: AttributionDelta[];
}

// v3: one database round trip (agent_analytics_window).
const keyFor = (range: DateRange) => `agent-activity:v3:${range.startKey}:${range.endKey}`;

/** PostgREST and Postgres both say "no such function" before its migration. */
const isMissingFunction = (error: unknown) => {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'PGRST202' || e?.code === '42883' || /agent_analytics_window/.test(e?.message ?? '');
};

// Reports are large and read rarely: a minute fresh, and no live refresh on
// every agent event (the narrative feed does that).
const REPORT_TTL_MS = 60_000;

const fetchRange = async (range: DateRange): Promise<RangeResult> => {
  const supabase = createClient();
  try {
    const window = await fetchAgentAnalyticsWindow(supabase, range);
    return { rows: window.rows, fleet: window.fleet, attribution: window.attribution, truncated: false };
  } catch (error) {
    // Until 20261011033458_agent_analytics_window.sql is applied, read the raw
    // rows as before: slower, same numbers.
    if (!isMissingFunction(error)) throw error;
    return fetchAgentActivityRange(supabase, range);
  }
};

const rangeRead = (range: DateRange): Read<RangeResult> =>
  ({ key: keyFor(range), load: () => fetchRange(range), ttlMs: REPORT_TTL_MS });

/**
 * Warm a range before anyone looks at it, so opening the report is instant.
 * Safe to call repeatedly: concurrent callers share one request.
 */
export function prefetchAgentAnalytics(range: DateRange): void {
  void warmRead(rangeRead(range));
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
  const query = useRead<AgentHealthTransition[]>(enabled ? {
    key: 'agent-health-history',
    ttlMs: REPORT_TTL_MS,
    load: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from('agent_health_history')
        .select('member_id, container_running, changed_at')
        .order('changed_at', { ascending: true })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as AgentHealthTransition[];
    },
  } : null);
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
  const query = useRead<RangeResult>(enabled ? rangeRead(range) : null);
  return {
    rows: query.data?.rows ?? [],
    fleet: query.data?.fleet ?? [],
    attribution: query.data?.attribution,
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
  const query = useRead<BillingGapReviewRow[]>(enabled
    ? { key: 'agent-billing-gap-reviews', ttlMs: REPORT_TTL_MS, load: () => fetchBillingGapReviews(createClient()) }
    : null);
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
  const query = useRead<ReopenAnswer | null>(enabled
    ? { key: 'task-reopens:v2', ttlMs: REPORT_TTL_MS, load: () => fetchTaskReopens(createClient()) }
    : null);
  const answer = query.failed ? null : query.data ?? null;
  return { rows: answer?.rows ?? null, since: answer?.since ?? null, loading: enabled && query.loading };
}
