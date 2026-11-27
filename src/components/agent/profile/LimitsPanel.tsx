'use client';

import { useState } from 'react';
import { Gauge } from 'lucide-react';
import {
  BUDGET_PERIODS,
  LIMIT_LABELS,
  PERIOD_LABELS,
  agentLimitsOf,
  budgetSpent,
  formatUsd,
  type AgentLimits,
  type AgentUsage,
  type BudgetPeriod,
} from '@/lib/agent-limits';
import { workspaceApi } from '@/lib/agent-workspace';
import { periodWords } from '@/lib/agent-profile';
import { useDemo } from '@/lib/demo-context';
import { invalidateTables } from '@/lib/query-cache';
import { Card } from '@/components/ui/Card';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';
import { formatAgo } from '@/lib/time-format';

/**
 * Rules > Limits: how hard the agent may run (runs at once, requests a
 * minute, a budget per period), and a status line while it is paused. An
 * empty field is no limit. Limits are a workspace Owner's to change. The
 * card is controlled: the Rules tab holds its draft and saves it with the
 * rest of the tab through one save bar (DESIGN.md Rule 8). Pausing is for
 * whoever may manage the agent, from the profile header (useAgentPause).
 * Paused, it still reads, reports its heartbeat and its usage; every other
 * write is refused.
 */

export type LimitsDraft = Record<'max_concurrent_runs' | 'rate_per_minute' | 'budget_usd' | 'budget_tokens' | 'max_run_spend_usd' | 'write_rate_per_minute' | 'send_rate_per_minute', number | ''> & { budget_period: BudgetPeriod };

export const limitsDraftOf = (limits: AgentLimits | null | undefined): LimitsDraft => {
  const l = agentLimitsOf(limits ?? null);
  return {
    max_concurrent_runs: l.max_concurrent_runs ?? '',
    rate_per_minute: l.rate_per_minute ?? '',
    budget_usd: l.budget_usd ?? '',
    budget_tokens: l.budget_tokens ?? '',
    budget_period: l.budget_period,
    // Shown in dollars, stored in cents.
    max_run_spend_usd: l.max_run_spend_cents === null ? '' : l.max_run_spend_cents / 100,
    write_rate_per_minute: l.write_rate_per_minute ?? '',
    send_rate_per_minute: l.send_rate_per_minute ?? '',
  };
};

const valueOf = (value: number | '') => (value === '' ? null : value);

/** The limits as the agent update takes them. */
export function limitsBody(draft: LimitsDraft) {
  return {
    max_concurrent_runs: valueOf(draft.max_concurrent_runs),
    rate_per_minute: valueOf(draft.rate_per_minute),
    budget_usd: valueOf(draft.budget_usd),
    budget_tokens: valueOf(draft.budget_tokens),
    budget_period: draft.budget_period,
    max_run_spend_cents: draft.max_run_spend_usd === '' ? null : Math.max(1, Math.round(draft.max_run_spend_usd * 100)),
    write_rate_per_minute: valueOf(draft.write_rate_per_minute),
    send_rate_per_minute: valueOf(draft.send_rate_per_minute),
  };
}

export const sameLimits = (a: LimitsDraft, b: LimitsDraft) => JSON.stringify(a) === JSON.stringify(b);

/** What a write in demo mode says instead of saving. */
export const DEMO_NOTICE = 'Demo mode: changes are not saved.';

/**
 * Pauses or resumes one agent: one call, no confirmation (it is undone by
 * the same button). Answers whether it took.
 */
export function useAgentPause(agentId: string, agentName: string) {
  const { isDemoMode } = useDemo();
  const [busy, setBusy] = useState(false);
  /** quiet: the caller shows the result in place (an UndoLine), so no toast on success. */
  const setPaused = async (paused: boolean, { quiet = false }: { quiet?: boolean } = {}): Promise<boolean> => {
    if (isDemoMode) {
      toast('info', DEMO_NOTICE);
      return false;
    }
    setBusy(true);
    try {
      await workspaceApi(`/api/workspace/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: { paused } });
      invalidateTables(['team_members']);
      if (!quiet) toast('success', paused ? `${agentName} is paused` : `${agentName} is working again`);
      return true;
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not change it');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, setPaused };
}

export function LimitsPanel({ agentName, limits, usage, pausedAt, canEditLimits, draft, onDraft }: {
  agentName: string;
  limits: AgentLimits | null | undefined;
  usage: AgentUsage | null | undefined;
  pausedAt: string | null;
  canEditLimits: boolean;
  draft: LimitsDraft;
  onDraft: (next: (draft: LimitsDraft) => LimitsDraft) => void;
}) {
  const spent = usage && budgetSpent(agentLimitsOf(limits ?? null), usage);
  const set = (key: keyof LimitsDraft) => (value: number | '') => onDraft((d) => ({ ...d, [key]: value }));
  const hint = (text: string, empty = 'no limit') => (canEditLimits ? `${text} Empty: ${empty}.` : text);

  return (
    <Card
      title="Limits"
      icon={<Gauge />}
      id="rp-limits"
      className="scroll-mt-6"
      description={`How hard ${agentName} may run. Over its budget, or with a run past its limit, it is refused writes as if paused: it still reads, reports its heartbeat and its usage. Spend is what its host reports, so set a limit with your AI provider too.`}
    >
      <div className="space-y-4">
        {pausedAt && (
          <p role="status" className="rounded-xl bg-amber-500/[0.08] px-4 py-3 text-sm text-zinc-200">
            Paused {formatAgo(pausedAt, { midSentence: true })}. It reads and reports only.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <NumberInput label={LIMIT_LABELS.max_concurrent_runs} description={hint('Runs and claimed tasks at once.')} value={draft.max_concurrent_runs} onChange={set('max_concurrent_runs')} min={1} max={1000} step={1} disabled={!canEditLimits} placeholder="No limit" />
          <NumberInput label={LIMIT_LABELS.rate_per_minute} description={hint('Across all its keys.', '120 a minute per key')} value={draft.rate_per_minute} onChange={set('rate_per_minute')} min={1} max={10000} step={1} disabled={!canEditLimits} placeholder="120 a minute per key" />
          <NumberInput label={LIMIT_LABELS.budget_usd} description={hint('Spend before its writes stop.')} value={draft.budget_usd} onChange={set('budget_usd')} min={0.01} step={1} precision={2} prefix="$" disabled={!canEditLimits} placeholder="No budget" />
          <NumberInput label={LIMIT_LABELS.budget_tokens} description={hint('Input and output tokens.')} value={draft.budget_tokens} onChange={set('budget_tokens')} min={1} step={1000} disabled={!canEditLimits} placeholder="No budget" />
          <NumberInput label="Most one run may spend" description={hint('A run past it is stopped.')} value={draft.max_run_spend_usd} onChange={set('max_run_spend_usd')} min={0.01} step={1} precision={2} prefix="$" disabled={!canEditLimits} placeholder="No limit" />
          <NumberInput label={LIMIT_LABELS.write_rate_per_minute} description={hint('Across all its keys. Reads are not counted.')} value={draft.write_rate_per_minute} onChange={set('write_rate_per_minute')} min={1} max={10000} step={1} disabled={!canEditLimits} placeholder="No limit" />
          <NumberInput label={LIMIT_LABELS.send_rate_per_minute} description={hint('Chat, notifications, questions and approvals.')} value={draft.send_rate_per_minute} onChange={set('send_rate_per_minute')} min={1} max={10000} step={1} disabled={!canEditLimits} placeholder="No limit" />
          <Select
            label={LIMIT_LABELS.budget_period}
            value={draft.budget_period}
            onChange={(value) => onDraft((d) => ({ ...d, budget_period: value as BudgetPeriod }))}
            options={BUDGET_PERIODS.map((period) => ({ value: period, label: PERIOD_LABELS[period] }))}
            disabled={!canEditLimits}
            helperText="In UTC."
          />
        </div>
        {usage && (
          <div>
            <p className="text-sm font-medium text-zinc-300">Now</p>
            <p className={`mt-1.5 text-sm ${spent ? 'text-amber-300' : 'text-zinc-400'}`}>
              {usage.running_runs} running, {usage.live_claims} claimed. Spent {formatUsd(usage.spent_usd)} and {usage.spent_tokens.toLocaleString('en-US')} tokens {periodWords(agentLimitsOf(limits ?? null).budget_period)}.
              {spent ? ' Its budget is spent: its writes are refused until it resets.' : ''}
            </p>
          </div>
        )}
        {!canEditLimits && <p className="text-xs text-zinc-500">Only a workspace Owner changes limits.</p>}
      </div>
    </Card>
  );
}
