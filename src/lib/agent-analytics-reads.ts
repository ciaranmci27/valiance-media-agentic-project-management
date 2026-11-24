'use client';

import { createClient } from '@/lib/supabase/client';
import { useRead, warmRead, type Read } from '@/lib/query-cache';
import { effectiveRunStatus } from '@/lib/agent-runs';
import { afterCursorFilter, keysetPages, type PageCursor } from '@/lib/agent-analytics-paging';
import type { DateRange } from '@/lib/finance/summary';
import type { ProviderPlan, QuestionRow, QuestionStats, RunRow, RunStats } from '@/lib/agent-analytics-model';
import { questionStatsFromAnswer, runStatsFromAnswer } from '@/lib/agent-analytics-window';
import { isMissingRpc } from '@/lib/supabase/queries';

/**
 * The Analytics tab's own reads beside the event window
 * (use-agent-analytics-events.ts): runs and the questions agents asked, for
 * one date range. Described Reads, cached by range, a minute fresh like the
 * rest of the report.
 *
 * Runs and questions come summed by the server (pm.agent_run_stats,
 * pm.agent_question_stats: one small answer whatever the range holds). Only
 * on a database before 20261124001200 are they read as rows, paged by keyset
 * on (time, id) so a row written mid-read never repeats, up to a cap the
 * screen names.
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

/** A server sum, or the database does not have its function yet (callers read rows instead). */
export type StatsAnswer<T> = { status: 'ready'; stats: T } | { status: 'missing' };

/** The zone days are counted in: the viewer's own, else the browser's. */
export function analyticsZone(timezone?: string): string {
  return timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Runs summed per agent, project, model, provider and day. Busy time clips
 * only the picked projects' runs against each other, so the projects are part
 * of the key.
 */
export function analyticsRunStatsRead(range: DateRange, timezone: string, projectIds: readonly string[] = []): Read<StatsAnswer<RunStats>> {
  const projects = [...projectIds].sort();
  return {
    key: `agent-analytics-run-stats:${range.startKey}:${range.endKey}:${timezone}:${projects.join(',')}`,
    ttlMs: REPORT_TTL_MS,
    load: async () => {
      const { data, error } = await createClient().rpc('agent_run_stats', {
        p_start: range.startKey,
        p_end: range.endKey,
        p_tz: timezone,
        p_project_ids: projects.length > 0 ? projects : null,
      });
      if (error) {
        if (isMissingRpc(error, 'agent_run_stats')) return { status: 'missing' };
        throw error;
      }
      return { status: 'ready', stats: runStatsFromAnswer(data) };
    },
  };
}

/** Questions summed per asker, project and day, with every answer time. */
export function analyticsQuestionStatsRead(range: DateRange, timezone: string): Read<StatsAnswer<QuestionStats>> {
  return {
    key: `agent-analytics-question-stats:${range.startKey}:${range.endKey}:${timezone}`,
    ttlMs: REPORT_TTL_MS,
    tables: ['questions'],
    load: async () => {
      const { data, error } = await createClient().rpc('agent_question_stats', {
        p_start: range.startKey,
        p_end: range.endKey,
        p_tz: timezone,
      });
      if (error) {
        if (isMissingRpc(error, 'agent_question_stats')) return { status: 'missing' };
        throw error;
      }
      return { status: 'ready', stats: questionStatsFromAnswer(data) };
    },
  };
}

/** Provider subscriptions (pm.provider_plans), for the estimate beside measured cost. Empty before its migration. */
export const providerPlansRead: Read<ProviderPlanRow[]> = {
  key: 'provider-plans',
  ttlMs: 10 * 60_000,
  tables: ['provider_plans'],
  load: async () => {
    const { data, error } = await createClient().from('provider_plans')
      .select('id, provider, monthly_cost_usd, seats, notes, updated_at').order('provider');
    if (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      provider: String(row.provider),
      monthlyCostUsd: Number(row.monthly_cost_usd),
      seats: Number(row.seats),
      notes: String(row.notes ?? ''),
      updatedAt: String(row.updated_at),
    }));
  },
};

export interface ProviderPlanRow extends ProviderPlan {
  id: string;
  notes: string;
  updatedAt: string;
}

/** Warm the range's reads, beside prefetchAgentAnalytics, so the tab opens measured. */
export function prefetchAnalyticsReads(range: DateRange, timezone?: string): void {
  const zone = analyticsZone(timezone);
  void warmRead(analyticsRunStatsRead(range, zone));
  void warmRead(analyticsQuestionStatsRead(range, zone));
}

/**
 * Runs and questions for the Analytics tab: the server's sums, else (before
 * their migration) the rows. `truncated` only ever comes from the rows.
 */
export function useAnalyticsReads(range: DateRange, options: { enabled: boolean; timezone?: string; projectIds?: readonly string[] }) {
  const zone = analyticsZone(options.timezone);
  const runStats = useRead(options.enabled ? analyticsRunStatsRead(range, zone, options.projectIds) : null);
  const questionStats = useRead(options.enabled ? analyticsQuestionStatsRead(range, zone) : null);
  const plans = useRead(options.enabled ? providerPlansRead : null);
  const runRows = options.enabled && runStats.data?.status === 'missing';
  const questionRows = options.enabled && questionStats.data?.status === 'missing';
  const runs = useRead(runRows ? analyticsRunsRead(range) : null);
  const questions = useRead(questionRows ? analyticsQuestionsRead(range) : null);
  return {
    runStats: runStats.data?.status === 'ready' ? runStats.data.stats : null,
    questionStats: questionStats.data?.status === 'ready' ? questionStats.data.stats : null,
    runs: runRows ? runs.data ?? null : null,
    questions: questionRows ? questions.data ?? null : null,
    providerPlans: plans.data ?? [],
    loading: options.enabled && (runStats.loading || questionStats.loading || (runRows && runs.loading) || (questionRows && questions.loading)),
    runsFailed: options.enabled && (runStats.failed || (runRows && runs.failed)),
    questionsFailed: options.enabled && (questionStats.failed || (questionRows && questions.failed)),
    reload: () => {
      runStats.reload();
      questionStats.reload();
      if (runRows) runs.reload();
      if (questionRows) questions.reload();
    },
  };
}
