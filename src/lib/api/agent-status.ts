import type { SupabaseClient } from '@supabase/supabase-js';
import { agentLimitsOf, budgetSpent, type AgentLimits, type BudgetPeriod } from '@/lib/agent-limits';
import { loadLimitState, missingLimitsSchema, notifyBudgetSpent, type LimitState } from './agent-limits';
import { afterResponse } from './after-response';

/**
 * What an agent checks before each turn (GET /api/v1/agents/me/status, MCP
 * get_my_status), from one database call (pm.agent_status): whether it may
 * start work now. Pause and budget only refuse calls into this app, so an
 * agent that works in another system reads this first and skips the turn
 * when can_start_work is false. Project pauses are left out: they stop work
 * on one project here, not the agent.
 *
 * Reading a spent budget claims the period's notice (once a period), which
 * tells the owners and sends budget.exceeded, as usage and a refused run
 * start do.
 */

/** assistants_off: a personal agent while assistants are switched off for the workspace (on hold, like a pause). */
export type PauseReason = 'agents_paused' | 'assistants_off' | 'agent_paused';
/** time_tracking_off: the project asked about tracks no time and the agent's work needs a timer (lib/api/readiness.ts). */
export type SkipReason = PauseReason | 'budget_exceeded' | 'time_tracking_off';

export interface AgentBudgetStatus {
  period: BudgetPeriod;
  period_start: string;
  /** When the period ends and spend starts again from 0 (UTC). */
  resets_at: string | null;
  /** Spend this period, counted by the shared rule (pm.agent_spend). */
  spent_usd: number;
  spent_tokens: number;
  /** The caps; null for none. */
  budget_usd: number | null;
  budget_tokens: number | null;
  exceeded: boolean;
}

export interface AgentStatus {
  member_id: string;
  /** The key's member is an agent. People are never paused and have no budget. */
  agent: boolean;
  /** False while paused or over budget: skip the turn. */
  can_start_work: boolean;
  /** Why not, the first that applies: agents_paused, assistants_off, agent_paused, budget_exceeded; null when it may. */
  skip_reason: SkipReason | null;
  paused: boolean;
  /** agents_paused (every agent, by an Owner) wins over assistants_off (a personal agent while assistants are off), then agent_paused (this agent). */
  paused_reason: PauseReason | null;
  /** A personal agent while assistants are switched off for the workspace: on hold until an Owner turns them on. */
  assistants_off: boolean;
  paused_at: string | null;
  workspace_paused_at: string | null;
  agent_paused_at: string | null;
  budget: AgentBudgetStatus;
  /** The agent's limits; null when none are set. */
  limits: AgentLimits | null;
  checked_at: string;
  /**
   * What in the app would stop its work, before it starts: on the projects
   * of its open work, or on the project asked about (project_id, task_id).
   * Filled by the status route; empty when nothing would.
   */
  blockers?: import('./readiness').WorkBlocker[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const iso = (value: unknown): string | null => (typeof value === 'string' && value ? new Date(value).toISOString() : null);

function periodEnd(start: string, period: BudgetPeriod): string | null {
  if (!start) return null;
  const at = new Date(start);
  if (Number.isNaN(at.getTime())) return null;
  if (period === 'day') at.setUTCDate(at.getUTCDate() + 1);
  else if (period === 'week') at.setUTCDate(at.getUTCDate() + 7);
  else at.setUTCMonth(at.getUTCMonth() + 1);
  return at.toISOString();
}

/** The status as answered, from its parts. Pure. */
export function composeAgentStatus(input: {
  memberId: string;
  agent: boolean;
  workspacePausedAt: string | null;
  agentPausedAt: string | null;
  /** A personal agent while assistants are switched off. */
  assistantsOff?: boolean;
  state: LimitState | null;
  resetsAt?: string | null;
  now?: Date;
}): AgentStatus {
  const workspace = input.agent ? iso(input.workspacePausedAt) : null;
  const own = input.agent ? iso(input.agentPausedAt) : null;
  const assistantsOff = input.agent && input.assistantsOff === true;
  const pausedReason: PauseReason | null = workspace ? 'agents_paused' : assistantsOff ? 'assistants_off' : own ? 'agent_paused' : null;
  const limits = input.agent ? input.state?.limits ?? null : null;
  const usage = input.state?.usage;
  const period = limits?.budget_period ?? 'month';
  const periodStart = iso(usage?.period_start) ?? '';
  const exceeded = input.agent && !!usage && budgetSpent(limits, usage);
  const skip: SkipReason | null = pausedReason ?? (exceeded ? 'budget_exceeded' : null);
  return {
    member_id: input.memberId,
    agent: input.agent,
    can_start_work: skip === null,
    skip_reason: skip,
    paused: pausedReason !== null,
    paused_reason: pausedReason,
    assistants_off: assistantsOff,
    paused_at: workspace ?? own,
    workspace_paused_at: workspace,
    agent_paused_at: own,
    budget: {
      period,
      period_start: periodStart,
      resets_at: input.resetsAt !== undefined ? iso(input.resetsAt) : periodEnd(periodStart, period),
      spent_usd: Number(usage?.spent_usd ?? 0),
      spent_tokens: Number(usage?.spent_tokens ?? 0),
      budget_usd: limits?.budget_usd ?? null,
      budget_tokens: limits?.budget_tokens ?? null,
      exceeded,
    },
    limits,
    checked_at: (input.now ?? new Date()).toISOString(),
  };
}

/** A database before pm.agent_status (by code only). */
const missingStatus = (error: { code?: string } | null) => !!error && (error.code === 'PGRST202' || error.code === '42883');

/** The limit state as loadLimitState answers it, from pm.agent_status's `state`. */
function limitStateOf(state: Row | null | undefined): LimitState | null {
  if (!state) return null;
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

/** The calling member's status now. One database call; a database before the migration takes a few. */
export async function loadAgentStatus(db: SupabaseClient, memberId: string): Promise<AgentStatus> {
  const { data, error } = await db.rpc('agent_status', { p_member_id: memberId });
  let status: AgentStatus;
  let state: LimitState | null = null;
  if (error && missingStatus(error)) {
    const [{ data: member, error: memberError }, { data: settings, error: settingsError }] = await Promise.all([
      db.from('team_members').select('role, agent_paused_at').eq('id', memberId).maybeSingle(),
      db.from('business_settings').select('agents_paused_at').limit(1).maybeSingle(),
    ]);
    if (memberError && !missingLimitsSchema(memberError)) throw memberError;
    if (settingsError && !missingLimitsSchema(settingsError)) throw settingsError;
    const agent = (member as Row | null)?.role === 'agent';
    state = agent ? await loadLimitState(db, memberId, true) : null;
    status = composeAgentStatus({
      memberId, agent, state,
      workspacePausedAt: (settings as Row | null)?.agents_paused_at ?? null,
      agentPausedAt: (member as Row | null)?.agent_paused_at ?? null,
    });
  } else {
    if (error) throw error;
    const row = (data ?? {}) as Row;
    state = limitStateOf(row.state);
    status = composeAgentStatus({
      memberId, agent: row.agent === true, state,
      workspacePausedAt: row.workspace_paused_at ?? null,
      agentPausedAt: row.agent_paused_at ?? null,
      // Before 20261127001000 the database does not say; the request gate still holds such an agent's writes.
      assistantsOff: row.assistants_off === true,
      resetsAt: row.period_end ?? null,
    });
  }
  // A spent budget nobody told about yet: tell the owners and send budget.exceeded, once a period.
  if (status.budget.exceeded && state && state.alerted_period !== state.usage.period_start) {
    const spent = state;
    afterResponse('status budget notice', async () => { await notifyBudgetSpent(db, memberId, spent); });
  }
  return status;
}
