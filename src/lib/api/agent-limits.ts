import type { SupabaseClient } from '@supabase/supabase-js';
import {
  agentLimitsOf,
  budgetSpent,
  formatUsd,
  type AgentLimits,
  type AgentLimitsPatch,
  type AgentUsage,
} from '@/lib/agent-limits';
import { ApiError } from './errors';

/**
 * Per-agent limits on the server (see src/lib/agent-limits.ts): reading what
 * counts against them (pm.agent_limit_state), refusing a run start or a
 * claim past them, telling an agent's owners once a period when its budget
 * is spent, and writing them. A database without the limits schema yet (new
 * code before its migration) reads as no limits, which is how every agent
 * behaved before.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/**
 * A database without the limits schema yet: a missing table or column
 * (Postgres 42P01, 42703; PostgREST PGRST205, PGRST204) or function
 * (PGRST202). By code only: any other error is real, and the run start,
 * claim or read that hit it fails, as the request gate does.
 */
export const missingLimitsSchema = (error: { code?: string; message?: string } | null) =>
  !!error && ['42P01', '42703', 'PGRST205', 'PGRST204', 'PGRST202'].includes(error.code ?? '');

export interface LimitState {
  limits: AgentLimits | null;
  usage: AgentUsage;
  /** The budget period whose overrun the owners were told about. */
  alerted_period: string | null;
}

/**
 * An agent's limits and what counts against them now; null on a database
 * before the limits. Without withUsage only what its limits need is counted.
 */
export async function loadLimitState(db: SupabaseClient, agentId: string, withUsage = false): Promise<LimitState | null> {
  const { data, error } = await db.rpc('agent_limit_state', { p_agent_id: agentId, p_with_usage: withUsage });
  if (error) {
    if (missingLimitsSchema(error)) return null;
    throw error;
  }
  const state = (data ?? {}) as Row;
  return {
    limits: state.limits ? agentLimitsOf(state.limits) : null,
    usage: {
      period_start: String(state.period_start ?? ''),
      spent_usd: Number(state.spent_usd ?? 0),
      spent_tokens: Number(state.spent_tokens ?? 0),
      running_runs: Number(state.running_runs ?? 0),
      live_claims: Number(state.live_claims ?? 0),
    },
    alerted_period: (state.limits?.budget_alerted_period as string | null | undefined) ?? null,
  };
}

function budgetExceeded(state: LimitState): ApiError {
  const l = state.limits!;
  const caps = [
    l.budget_usd !== null ? `${formatUsd(state.usage.spent_usd)} of ${formatUsd(l.budget_usd)}` : null,
    l.budget_tokens !== null ? `${state.usage.spent_tokens.toLocaleString('en-US')} of ${l.budget_tokens.toLocaleString('en-US')} tokens` : null,
  ].filter(Boolean).join(', ');
  return new ApiError(402, 'BUDGET_EXCEEDED', `This agent has spent its budget for the ${l.budget_period} (${caps}). New runs are refused until it resets or an Owner raises it.`, {
    reason: 'budget_exceeded',
    budget_usd: l.budget_usd,
    budget_tokens: l.budget_tokens,
    budget_period: l.budget_period,
    period_start: state.usage.period_start,
    spent_usd: state.usage.spent_usd,
    spent_tokens: state.usage.spent_tokens,
    hint: 'Finish what you are doing and keep reporting usage. An Owner raises the budget on the agent\'s Rules tab.',
  });
}

/**
 * Refuses a new run past the agent's limits: 409 limit_concurrent_runs at
 * max_concurrent_runs running runs, 402 budget_exceeded once the budget is
 * spent (telling its owners once a period). No limits, nothing to check.
 */
export async function enforceRunStart(db: SupabaseClient, agentId: string): Promise<void> {
  const state = await loadLimitState(db, agentId);
  if (!state?.limits) return;
  const max = state.limits.max_concurrent_runs;
  if (max !== null && state.usage.running_runs >= max) {
    throw new ApiError(409, 'CONFLICT', `This agent already has ${state.usage.running_runs} run${state.usage.running_runs === 1 ? '' : 's'} going, its limit at once. Finish one before starting another.`, {
      reason: 'limit_concurrent_runs',
      max_concurrent_runs: max,
      running_runs: state.usage.running_runs,
    });
  }
  if (budgetSpent(state.limits, state.usage)) {
    await notifyBudgetSpent(db, agentId, state);
    throw budgetExceeded(state);
  }
}

/** The 402 for a run past the agent's per-run spend limit. */
export function runSpendExceeded(runId: string, spentUsd: number, capCents: number, stopped: boolean): ApiError {
  return new ApiError(402, 'BUDGET_EXCEEDED', `This run has spent ${formatUsd(spentUsd)}, past the ${formatUsd(capCents / 100)} one run may spend.${stopped ? ' It was stopped.' : ''}`, {
    reason: 'run_spend_exceeded',
    run_id: runId,
    spent_usd: spentUsd,
    max_run_spend_cents: capCents,
    stopped,
    hint: 'Stop this work and report what you have. An Owner raises the limit on the agent\'s Rules and powers (max_run_spend_cents).',
  });
}

/** The agent's per-run spend limit in cents, or null (none, or a database before it). */
export async function runSpendCap(db: SupabaseClient, agentId: string): Promise<number | null> {
  return (await agentLimitsRow(db, agentId))?.max_run_spend_cents ?? null;
}

/**
 * What a run has spent: its own cost_usd when it reports one, else the
 * usage.recorded rows that name it (the same rule as pm.agent_spend_facts).
 */
export async function runSpent(db: SupabaseClient, run: { id: string; cost_usd?: unknown }): Promise<number> {
  if (run.cost_usd !== null && run.cost_usd !== undefined) return Number(run.cost_usd);
  const { data, error } = await db.from('agent_activities').select('metadata').eq('activity_type', 'usage.recorded').eq('metadata->>run_id', run.id);
  if (error) throw error;
  return ((data ?? []) as Row[]).reduce((sum, row) => sum + (Number.isFinite(Number(row.metadata?.cost_usd)) ? Number(row.metadata.cost_usd) : 0), 0);
}

/**
 * Stops a run past the agent's per-run spend limit: an unfinished run is
 * cancelled with a note saying why. Answers the 402 to give the caller, or
 * null when the run is within it (or there is no limit).
 */
export async function enforceRunSpend(db: SupabaseClient, run: Row): Promise<ApiError | null> {
  const cap = await runSpendCap(db, run.agent_id as string);
  if (cap === null) return null;
  const spent = await runSpent(db, run as { id: string; cost_usd?: unknown });
  if (spent * 100 <= cap) return null;
  let stopped = false;
  if (run.status === 'running' || run.status === 'waiting') {
    const note = { at: new Date().toISOString(), text: `Stopped: spent ${formatUsd(spent)}, past the ${formatUsd(cap / 100)} one run may spend.` };
    const notes = [...(Array.isArray(run.notes) ? run.notes : []), note].slice(-50);
    const { data, error } = await db.from('agent_runs')
      .update({ status: 'cancelled', finished_at: new Date().toISOString(), notes, blocked_at: null, blocked_reason: null })
      .eq('id', run.id).in('status', ['running', 'waiting']).select('id');
    if (error) throw error;
    stopped = (data ?? []).length > 0;
  }
  return runSpendExceeded(run.id as string, spent, cap, stopped);
}

/**
 * Refuses a new claim (not a renewal of one the agent holds) at
 * max_concurrent_runs live claims: 409 limit_concurrent_claims.
 */
export async function enforceClaimLimit(db: SupabaseClient, agentId: string): Promise<void> {
  const state = await loadLimitState(db, agentId);
  const max = state?.limits?.max_concurrent_runs ?? null;
  if (max === null || !state) return;
  if (state.usage.live_claims >= max) {
    throw new ApiError(409, 'CONFLICT', `This agent already holds ${state.usage.live_claims} claimed task${state.usage.live_claims === 1 ? '' : 's'}, its limit at once. Finish or release one before claiming another.`, {
      reason: 'limit_concurrent_claims',
      max_concurrent_runs: max,
      live_claims: state.usage.live_claims,
    });
  }
}

/**
 * After usage is recorded: when the budget is now spent, tell the owners
 * (once a period). Never refuses anything: telemetry is always kept.
 */
export async function checkBudgetAfterUsage(db: SupabaseClient, agentId: string): Promise<boolean> {
  const state = await loadLimitState(db, agentId);
  if (!state?.limits || !budgetSpent(state.limits, state.usage)) return false;
  await notifyBudgetSpent(db, agentId, state);
  return true;
}

/** Who hears about an agent: its active people owners, else the workspace's active Owners. */
async function ownersToTell(db: SupabaseClient, agentId: string): Promise<string[]> {
  const { data: owners, error } = await db.from('agent_owners').select('member_id').eq('agent_id', agentId);
  if (error) throw error;
  const ids = ((owners ?? []) as Row[]).map((row) => row.member_id as string);
  const query = ids.length
    ? db.from('team_members').select('id, role, status').in('id', ids)
    : db.from('team_members').select('id, role, status').eq('role', 'owner');
  const { data, error: membersError } = await query;
  if (membersError) throw membersError;
  return ((data ?? []) as Row[]).filter((row) => row.role !== 'agent' && (row.status ?? 'active') === 'active').map((row) => row.id as string);
}

/**
 * Tells the agent's owners its budget is spent, once a budget period: the
 * period is claimed on its limits row first, so two requests at once send
 * one notice. Never fails the caller.
 */
export async function notifyBudgetSpent(db: SupabaseClient, agentId: string, state: LimitState): Promise<number> {
  try {
    const period = state.usage.period_start;
    if (!period || state.alerted_period === period) return 0;
    // Compare and swap on the value read: only one writer moves it on.
    const claim = db.from('agent_limits').update({ budget_alerted_period: period }).eq('agent_id', agentId);
    const { data: claimed, error } = await (state.alerted_period === null
      ? claim.is('budget_alerted_period', null)
      : claim.eq('budget_alerted_period', state.alerted_period)).select('agent_id');
    if (error) throw error;
    if (!claimed?.length) return 0;
    const [{ data: agent }, recipients] = await Promise.all([
      db.from('team_members').select('name').eq('id', agentId).maybeSingle(),
      ownersToTell(db, agentId),
    ]);
    if (recipients.length === 0) return 0;
    const name = (agent as Row | null)?.name ?? 'An agent';
    const l = state.limits!;
    const cap = [l.budget_usd !== null ? formatUsd(l.budget_usd) : null, l.budget_tokens !== null ? `${l.budget_tokens.toLocaleString('en-US')} tokens` : null].filter(Boolean).join(' or ');
    const rows = recipients.map((id) => ({
      user_id: id,
      title: `${name} spent its budget`,
      message: `${name} reached its ${cap} budget for the ${l.budget_period}. New runs are refused until it resets or you raise it; its usage is still recorded.`,
      link: `/ai/agents/${agentId}?tab=rules`,
      entity_type: 'member',
      entity_id: agentId,
    }));
    const { error: insertError } = await db.from('team_member_notifications').insert(rows);
    if (insertError) throw insertError;
    return rows.length;
  } catch (error) {
    console.error('[agents] could not tell the owners about a spent budget', error);
    return 0;
  }
}

/** An agent's limits row (null without one, or before the migration). */
export async function agentLimitsRow(db: SupabaseClient, agentId: string): Promise<AgentLimits | null> {
  const { data, error } = await db.from('agent_limits').select('*').eq('agent_id', agentId).maybeSingle();
  if (error) {
    if (missingLimitsSchema(error)) return null;
    throw error;
  }
  return data ? agentLimitsOf(data as Row) : null;
}

/**
 * Writes the fields sent (null clears one), keeping the rest. A row left
 * with no limit at all is removed. Answers the limits as they now are.
 */
export async function setAgentLimits(db: SupabaseClient, agentId: string, patch: AgentLimitsPatch, actorId: string | null): Promise<AgentLimits | null> {
  const current = await agentLimitsRow(db, agentId);
  const next: AgentLimits = { ...(current ?? agentLimitsOf(null)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as AgentLimits;
  const empty = next.max_concurrent_runs === null && next.rate_per_minute === null && next.budget_usd === null && next.budget_tokens === null
    && next.max_run_spend_cents === null;
  if (empty) {
    if (current) {
      const { error } = await db.from('agent_limits').delete().eq('agent_id', agentId);
      if (error) throw error;
    }
    return null;
  }
  const { data, error } = await db
    .from('agent_limits')
    .upsert({ agent_id: agentId, ...next, updated_at: new Date().toISOString(), updated_by: actorId }, { onConflict: 'agent_id' })
    .select('*')
    .single();
  if (error) {
    if (missingLimitsSchema(error)) {
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Agent limits work once the database update 20261124001500_limits_audit.sql is applied', { reason: 'migration_pending' });
    }
    throw error;
  }
  return agentLimitsOf(data as Row);
}
