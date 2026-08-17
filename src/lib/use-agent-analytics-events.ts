'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { fetchAgentActivityRange } from '@/lib/supabase/queries';
import type { DateRange } from '@/lib/finance/summary';
import type { AgentActivity } from '@/lib/types';

export interface AgentAnalyticsEvents {
  rows: AgentActivity[];
  loading: boolean;
  /** The range held more rows than the ceiling, so figures under-report. */
  truncated: boolean;
  /** The query failed and `rows` is the caller's fallback, not the range. */
  failed: boolean;
}

interface Loaded {
  rangeKey: string;
  rows: AgentActivity[];
  truncated: boolean;
  failed: boolean;
}

/**
 * Every agent event in a date range, for analytics only.
 *
 * The app store keeps a small window of RECENT activity, which is the right
 * shape for a feed and the wrong shape for a report: a month of history runs to
 * thousands of rows, and telemetry (token deltas, turn runtimes) is excluded
 * from that window on purpose after it buried every real event. So the report
 * asks the database for exactly the range it is drawing.
 *
 * Failing soft is deliberate. Before the first response, and on any error, the
 * caller's store rows are returned so the page says something true about recent
 * activity rather than rendering an empty report, and `failed` lets the UI admit
 * the range may be incomplete instead of quietly under-reporting.
 */
export function useAgentAnalyticsEvents(range: DateRange, fallback: AgentActivity[]): AgentAnalyticsEvents {
  const rangeKey = `${range.startKey}_${range.endKey}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let dead = false;
    const [startKey, endKey] = rangeKey.split('_');

    (async () => {
      try {
        const supabase = createClient();
        const { rows, truncated } = await fetchAgentActivityRange(supabase, { startKey, endKey });
        if (!dead) setLoaded({ rangeKey, rows, truncated, failed: false });
      } catch {
        if (!dead) setLoaded({ rangeKey, rows: [], truncated: false, failed: true });
      }
    })();

    return () => { dead = true; };
  }, [rangeKey]);

  // Compared during render rather than cleared in an effect: a stale result for
  // a previous range must never be presented as this range's data.
  const current = loaded?.rangeKey === rangeKey ? loaded : null;
  return {
    rows: current && !current.failed ? current.rows : fallback,
    loading: current === null,
    truncated: current?.truncated ?? false,
    failed: current?.failed ?? false,
  };
}
