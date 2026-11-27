import { z } from 'zod';

/**
 * Per-agent limits (pm.agent_limits): optional, each field on its own. No
 * row, or a null field, is no limit, which is how every agent behaved before
 * limits existed, so nothing changes until an Owner sets one.
 *
 * - max_concurrent_runs: running runs at once (start_run answers 409
 *   limit_concurrent_runs) and live claims at once (claim_task answers 409
 *   limit_concurrent_claims). A claim is a lease on work in progress, so a
 *   harness that never records runs is held to the same number.
 * - rate_per_minute: API requests a minute across all the agent's keys, in
 *   place of DEFAULT_RATE_PER_MINUTE per key.
 * - budget_usd and budget_tokens per budget_period (day, week or month, UTC):
 *   once spent, new runs are refused (402 budget_exceeded) and the agent's
 *   owners are told once a period. Usage already happening is still recorded.
 * - max_run_spend_cents: the most one run may spend, in US cents. A start
 *   reporting more is refused, and a run reported past it (its own cost, or
 *   the usage that names it) is stopped as cancelled (402 run_spend_exceeded).
 */

/** Requests a minute per key when an agent has no rate_per_minute of its own. */
export const DEFAULT_RATE_PER_MINUTE = 120;

export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export interface AgentLimits {
  max_concurrent_runs: number | null;
  rate_per_minute: number | null;
  budget_usd: number | null;
  budget_tokens: number | null;
  budget_period: BudgetPeriod;
  max_run_spend_cents: number | null;
}

export const NO_LIMITS: AgentLimits = {
  max_concurrent_runs: null,
  rate_per_minute: null,
  budget_usd: null,
  budget_tokens: null,
  budget_period: 'month',
  max_run_spend_cents: null,
};

export const LIMIT_FIELDS = ['max_concurrent_runs', 'rate_per_minute', 'budget_usd', 'budget_tokens', 'max_run_spend_cents'] as const;

/** A change to an agent's limits: any field, null clears it. */
export const agentLimitsPatchSchema = z.object({
  max_concurrent_runs: z.number().int().min(1).max(1000).nullable().optional(),
  rate_per_minute: z.number().int().min(1).max(10000).nullable().optional(),
  budget_usd: z.number().positive().max(10_000_000).nullable().optional(),
  budget_tokens: z.number().int().positive().max(1e15).nullable().optional(),
  budget_period: z.enum(BUDGET_PERIODS).optional(),
  max_run_spend_cents: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
}).strict();
export type AgentLimitsPatch = z.infer<typeof agentLimitsPatchSchema>;

/** What counts against the limits now. */
export interface AgentUsage {
  period_start: string;
  spent_usd: number;
  spent_tokens: number;
  running_runs: number;
  live_claims: number;
}

export const LIMIT_LABELS = {
  max_concurrent_runs: 'Runs at once',
  rate_per_minute: 'Requests a minute',
  budget_usd: 'Budget (USD)',
  budget_tokens: 'Budget (tokens)',
  budget_period: 'Budget resets',
  max_run_spend_cents: 'Most one run may spend (cents)',
} as const;

export const PERIOD_LABELS: Record<BudgetPeriod, string> = { day: 'Every day', week: 'Every week', month: 'Every month' };
const PERIOD_WORDS: Record<BudgetPeriod, string> = { day: 'today', week: 'this week', month: 'this month' };

/** Reads limits off a row (or null), filling what is missing. */
export function agentLimitsOf(row: Partial<Record<keyof AgentLimits, unknown>> | null | undefined): AgentLimits {
  const num = (value: unknown) => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
  return {
    max_concurrent_runs: num(row?.max_concurrent_runs),
    rate_per_minute: num(row?.rate_per_minute),
    budget_usd: num(row?.budget_usd),
    budget_tokens: num(row?.budget_tokens),
    budget_period: (BUDGET_PERIODS as readonly string[]).includes(row?.budget_period as string) ? row!.budget_period as BudgetPeriod : 'month',
    max_run_spend_cents: num(row?.max_run_spend_cents),
  };
}

export const hasAnyLimit = (limits: AgentLimits | null | undefined) =>
  !!limits && LIMIT_FIELDS.some((field) => limits[field] !== null);

export const formatUsd = (value: number) => `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Whether the budget is spent: either measure at or over its cap. */
export function budgetSpent(limits: AgentLimits | null, usage: Pick<AgentUsage, 'spent_usd' | 'spent_tokens'>): boolean {
  if (!limits) return false;
  return (limits.budget_usd !== null && usage.spent_usd >= limits.budget_usd)
    || (limits.budget_tokens !== null && usage.spent_tokens >= limits.budget_tokens);
}

/** The limits in plain words, for the context pack and the profile. */
export function limitsInWords(limits: AgentLimits | null, usage: AgentUsage | null): string[] {
  const l = limits ?? NO_LIMITS;
  const lines: string[] = [];
  lines.push(l.max_concurrent_runs !== null
    ? `At most ${l.max_concurrent_runs} run${l.max_concurrent_runs === 1 ? '' : 's'} at once and ${l.max_concurrent_runs} claimed task${l.max_concurrent_runs === 1 ? '' : 's'} at once: another start or claim is refused (409 limit_concurrent_runs, limit_concurrent_claims) until one finishes.`
    : 'No limit on runs or claimed tasks at once.');
  lines.push(l.rate_per_minute !== null
    ? `Up to ${l.rate_per_minute} API requests a minute across all your keys (429 after that).`
    : `Up to ${DEFAULT_RATE_PER_MINUTE} API requests a minute per key (429 after that).`);
  const caps = [l.budget_usd !== null ? formatUsd(l.budget_usd) : null, l.budget_tokens !== null ? `${l.budget_tokens.toLocaleString('en-US')} tokens` : null].filter(Boolean);
  if (caps.length) {
    const spent = usage
      ? ` Spent ${PERIOD_WORDS[l.budget_period]}: ${l.budget_usd !== null ? formatUsd(usage.spent_usd) : ''}${l.budget_usd !== null && l.budget_tokens !== null ? ' and ' : ''}${l.budget_tokens !== null ? `${usage.spent_tokens.toLocaleString('en-US')} tokens` : ''}.`
      : '';
    lines.push(`Budget: ${caps.join(' or ')} ${PERIOD_LABELS[l.budget_period].toLowerCase()} (UTC).${spent} Once it is spent, new runs are refused (402 budget_exceeded) and your owners are told; finish what you are doing and report your usage as usual.`);
  } else {
    lines.push('No spending budget.');
  }
  if (l.max_run_spend_cents !== null) {
    lines.push(`One run may spend at most ${formatUsd(l.max_run_spend_cents / 100)}: a run reported past it is stopped (402 run_spend_exceeded). Report cost_usd on the run as you go.`);
  }
  return lines;
}
