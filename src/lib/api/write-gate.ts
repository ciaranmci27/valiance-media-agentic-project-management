import type { SupabaseClient } from '@supabase/supabase-js';
import { formatUsd } from '@/lib/agent-limits';
import { enforceRunSpend, runSpendExceeded } from './agent-limits';
import { ApiError } from './errors';

/**
 * One check per write from an agent (pm.agent_write_gate, after the request
 * gate): an agent over its budget, or holding an unfinished run past its
 * max_run_spend_cents, is refused every write a paused agent is refused
 * (pauseExempt writes still go: heartbeats, telemetry, usage, finishing or
 * updating a run, releasing a claim), and its writes and sends are counted
 * against its write_rate_per_minute and send_rate_per_minute, across all its
 * keys. An agent without limits passes at once; people's keys never come
 * here. A database before 20261127002500 has no gate: nothing is refused.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the gate's answer is read field by field
type Row = Record<string, any>;

/**
 * Writes that reach a person: a chat message out (a start or a reply), a
 * notification, a question and an approval. They count in the send bucket
 * as well as the write bucket.
 */
export function isSendWrite(pathname: string, method: string): boolean {
  if (method !== 'POST') return false;
  return /^\/api\/v1\/(notifications|questions|approvals|chat\/messages)\/?$/.test(pathname)
    || /^\/api\/v1\/chat\/messages\/[^/]+\/reply\/?$/.test(pathname);
}

const missingWriteGate = (error: { code?: string } | null) => !!error && (error.code === 'PGRST202' || error.code === '42883');

/** The 402 for an agent whose budget this period is spent. */
export function budgetSpentRefusal(gate: Row): ApiError {
  const caps = [
    gate.budget_usd !== null && gate.budget_usd !== undefined ? `${formatUsd(Number(gate.spent_usd ?? 0))} of ${formatUsd(Number(gate.budget_usd))}` : null,
    gate.budget_tokens !== null && gate.budget_tokens !== undefined ? `${Number(gate.spent_tokens ?? 0).toLocaleString('en-US')} of ${Number(gate.budget_tokens).toLocaleString('en-US')} tokens` : null,
  ].filter(Boolean).join(', ');
  return new ApiError(402, 'BUDGET_EXCEEDED', `This agent has spent its budget for the ${gate.budget_period ?? 'month'} (${caps}). Its writes are refused until the budget resets or an Owner raises it; reads, heartbeats, usage and finishing a run still work.`, {
    reason: 'budget_exceeded',
    budget_usd: gate.budget_usd ?? null,
    budget_tokens: gate.budget_tokens ?? null,
    budget_period: gate.budget_period ?? 'month',
    period_start: gate.period_start ?? null,
    spent_usd: Number(gate.spent_usd ?? 0),
    spent_tokens: Number(gate.spent_tokens ?? 0),
    hint: 'Stop starting work. Finish or update your run and keep reporting usage. An Owner raises the budget on the agent\'s Limits.',
  });
}

/**
 * The refusal for this write, or null when it may go on. A run past its cap
 * is stopped here (cancelled, with a note), so the agent is told once and
 * its next write goes through.
 */
export async function writeGateRefusal(db: SupabaseClient, agentId: string, pathname: string, method: string): Promise<ApiError | null> {
  const { data, error } = await db.rpc('agent_write_gate', { p_agent_id: agentId, p_send: isSendWrite(pathname, method), p_window_seconds: 60 });
  if (error) {
    if (missingWriteGate(error)) return null;
    throw error;
  }
  const gate = (data ?? {}) as Row;
  switch (gate.refused) {
    case 'budget_exceeded':
      return budgetSpentRefusal(gate);
    case 'run_spend_exceeded': {
      const { data: run, error: runError } = await db.from('agent_runs').select('id, agent_id, status, cost_usd, notes').eq('id', gate.run_id).maybeSingle();
      if (runError) throw runError;
      return (run ? await enforceRunSpend(db, run as Row) : null)
        ?? runSpendExceeded(String(gate.run_id), Number(gate.spent_usd ?? 0), Number(gate.max_run_spend_cents), false);
    }
    case 'write_rate_limited':
      return new ApiError(429, 'RATE_LIMIT_EXCEEDED', `This agent made ${gate.limit} writes in the last minute, its limit across all its keys. Wait a moment and try again.`, {
        reason: 'write_rate_limited', limit: gate.limit, reset_at: gate.reset_at,
        hint: 'Reads are not counted. An Owner changes the limit on the agent\'s Limits (write_rate_per_minute).',
      });
    case 'send_rate_limited':
      return sendRateLimited(gate);
    default:
      return null;
  }
}

function sendRateLimited(gate: Row): ApiError {
  return new ApiError(429, 'RATE_LIMIT_EXCEEDED', `This agent sent ${gate.limit} messages in the last minute (chat, notifications, questions and approvals), its limit. Wait a moment and try again.`, {
    reason: 'send_rate_limited', limit: gate.limit, reset_at: gate.reset_at,
    hint: 'Put several things in one message. An Owner changes the limit on the agent\'s Limits (send_rate_per_minute).',
  });
}

/**
 * One more send for a write that turned out to reach people (a task comment
 * posted with notify: true), counted in the agent's send bucket only: the
 * write gate already counted the write. null when it may go on; before
 * 20261127002900 nothing is refused.
 */
export async function sendGateRefusal(db: SupabaseClient, agentId: string): Promise<ApiError | null> {
  const { data, error } = await db.rpc('agent_send_gate', { p_agent_id: agentId, p_window_seconds: 60 });
  if (error) {
    if (missingWriteGate(error)) return null;
    throw error;
  }
  const gate = (data ?? {}) as Row;
  return gate.refused === 'send_rate_limited' ? sendRateLimited(gate) : null;
}
