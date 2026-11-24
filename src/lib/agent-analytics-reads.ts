'use client';

import { createClient } from '@/lib/supabase/client';
import { useRead, warmRead, type Read } from '@/lib/query-cache';
import { effectiveRunStatus } from '@/lib/agent-runs';
import { afterCursorFilter, keysetPages, type PageCursor } from '@/lib/agent-analytics-paging';
import type { DateRange } from '@/lib/finance/summary';
import type { QuestionRow, RunRow } from '@/lib/agent-analytics-model';

/**
 * The Analytics tab's own reads beside the event window
 * (use-agent-analytics-events.ts): the run feed and the questions agents
 * asked, for one date range. Described Reads, cached by range, a minute fresh
 * like the rest of the report. Paged by keyset on (time, id), so a row
 * written mid-read never repeats.
 */

const REPORT_TTL_MS = 60_000;
const PAGE = 1000;
/** A range with more rows than this is cut short; the screen says so. */
export const ANALYTICS_ROW_CAP = 10_000;

const DAY = 86_400_000;
/** Date keys are calendar days in the viewer's zone: widen a day each side, then bucket on the client. */
function bounds(range: DateRange) {
  return {
    from: new Date(Date.parse(`${range.startKey}T00:00:00.000Z`) - DAY).toISOString(),
    to: new Date(Date.parse(`${range.endKey}T23:59:59.999Z`) + DAY).toISOString(),
  };
}

export interface RangeRows<T> {
  rows: T[];
  truncated: boolean;
  /** The source does not exist here (not migrated); callers fall back. Never set for other errors. */
  unavailable: boolean;
}

/** PostgREST and Postgres for a missing relation. */
const isMissing = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST205' || code === '42P01';
};

class Missing extends Error {}

type Row = Record<string, unknown>;

async function readKeyset(
  page: (after: PageCursor | null, limit: number) => PromiseLike<{ data: unknown; error: unknown }>,
  column: string,
  dedupe: (row: Row) => string,
): Promise<RangeRows<Row>> {
  try {
    const answer = await keysetPages<Row>(
      async (after, limit) => {
        const { data, error } = await page(after, limit);
        if (error) throw isMissing(error) ? new Missing() : error;
        return (data ?? []) as Row[];
      },
      (row) => ({ at: String(row[column]), id: String(row.id) }),
      dedupe,
      { pageSize: PAGE, cap: ANALYTICS_ROW_CAP },
    );
    return { ...answer, unavailable: false };
  } catch (error) {
    if (error instanceof Missing) return { rows: [], truncated: false, unavailable: true };
    throw error;
  }
}

const count = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
function toRunRow(row: Record<string, any>): RunRow {
  return {
    source: row.source === 'turn' ? 'turn' : 'run',
    agentId: row.agent_id,
    projectId: row.project_id ?? null,
    status: row.source === 'turn' ? 'succeeded' : effectiveRunStatus({ status: row.status, updated_at: row.updated_at }),
    outcome: row.outcome ?? null,
    title: row.title ?? null,
    model: row.model ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: count(row.duration_ms),
    tokensIn: count(row.tokens_in),
    tokensOut: count(row.tokens_out),
    costUsd: count(row.cost_usd),
  };
}

const RUN_COLUMNS = 'id, source, agent_id, project_id, status, outcome, title, model, started_at, finished_at, duration_ms, tokens_in, tokens_out, cost_usd, updated_at, sort_at';

export function analyticsRunsRead(range: DateRange): Read<RangeRows<RunRow>> {
  return {
    key: `agent-analytics-runs:${range.startKey}:${range.endKey}`,
    ttlMs: REPORT_TTL_MS,
    load: async () => {
      const supabase = createClient();
      const { from, to } = bounds(range);
      const answer = await readKeyset((after, limit) => {
        let query = supabase.from('agent_run_feed').select(RUN_COLUMNS).gte('sort_at', from).lte('sort_at', to);
        if (after) query = query.or(afterCursorFilter('sort_at', after));
        return query.order('sort_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
      }, 'sort_at', (row) => `${row.source}:${row.id}`);
      return { ...answer, rows: answer.rows.map(toRunRow) };
    },
  };
}

export function analyticsQuestionsRead(range: DateRange): Read<RangeRows<QuestionRow>> {
  return {
    key: `agent-analytics-questions:${range.startKey}:${range.endKey}`,
    ttlMs: REPORT_TTL_MS,
    tables: ['questions'],
    load: async () => {
      const supabase = createClient();
      const { from, to } = bounds(range);
      const answer = await readKeyset((after, limit) => {
        let query = supabase.from('questions').select('id, asked_by, project_id, kind, created_at, answered_at')
          .is('deleted_at', null).gte('created_at', from).lte('created_at', to);
        if (after) query = query.or(afterCursorFilter('created_at', after));
        return query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
      }, 'created_at', (row) => String(row.id));
      return {
        ...answer,
        rows: answer.rows.map((row) => ({
          askedBy: row.asked_by as string,
          projectId: (row.project_id as string | null) ?? null,
          kind: row.kind === 'approval' ? 'approval' : 'question',
          createdAt: row.created_at as string,
          answeredAt: (row.answered_at as string | null) ?? null,
        })),
      };
    },
  };
}

/** Warm both for a range, beside prefetchAgentAnalytics, so the tab opens measured. */
export function prefetchAnalyticsReads(range: DateRange): void {
  void warmRead(analyticsRunsRead(range));
  void warmRead(analyticsQuestionsRead(range));
}

export function useAnalyticsReads(range: DateRange, options: { enabled: boolean }) {
  const runs = useRead(options.enabled ? analyticsRunsRead(range) : null);
  const questions = useRead(options.enabled ? analyticsQuestionsRead(range) : null);
  return {
    runs: runs.data ?? null,
    questions: questions.data ?? null,
    loading: options.enabled && (runs.loading || questions.loading),
    runsFailed: options.enabled && runs.failed,
    questionsFailed: options.enabled && questions.failed,
    reload: () => { runs.reload(); questions.reload(); },
  };
}
