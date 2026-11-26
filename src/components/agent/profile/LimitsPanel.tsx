'use client';

import { useEffect, useState } from 'react';
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
import { timeAgo } from '@/lib/task-times';
import { Button } from '@/components/ui/Button';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select } from '@/components/ui/inputs/Select';
import { toast } from '@/components/ui/Toast';

/**
 * Rules and powers > Limits: how hard the agent may run (runs at once,
 * requests a minute, a budget per period), and a status line while it is
 * paused. An empty field is no limit. Limits are a workspace Owner's to
 * change. Pausing is for whoever may manage the agent, from the profile
 * header (useAgentPause). Paused, it still reads, reports its heartbeat and
 * its usage; every other write is refused.
 */

type Draft = Record<'max_concurrent_runs' | 'rate_per_minute' | 'budget_usd' | 'budget_tokens', number | ''> & { budget_period: BudgetPeriod };

const draftOf = (limits: AgentLimits | null | undefined): Draft => {
  const l = agentLimitsOf(limits ?? null);
  return {
    max_concurrent_runs: l.max_concurrent_runs ?? '',
    rate_per_minute: l.rate_per_minute ?? '',
    budget_usd: l.budget_usd ?? '',
    budget_tokens: l.budget_tokens ?? '',
    budget_period: l.budget_period,
  };
};

const valueOf = (value: number | '') => (value === '' ? null : value);

/** What a write in demo mode says instead of saving. */
export const DEMO_NOTICE = 'Demo mode: changes are not saved.';

/**
 * Pauses or resumes one agent: one call, no confirmation (it is undone by
 * the same button). Answers whether it took.
 */
export function useAgentPause(agentId: string, agentName: string) {
  const { isDemoMode } = useDemo();
  const [busy, setBusy] = useState(false);
  const setPaused = async (paused: boolean): Promise<boolean> => {
    if (isDemoMode) {
      toast('info', DEMO_NOTICE);
      return false;
    }
    setBusy(true);
    try {
      await workspaceApi(`/api/workspace/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body: { paused } });
      invalidateTables(['team_members']);
      toast('success', paused ? `${agentName} is paused` : `${agentName} is working again`);
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

export function LimitsPanel({ agentId, agentName, limits, usage, pausedAt, canEditLimits, onDirtyChange }: {
  agentId: string;
  agentName: string;
  limits: AgentLimits | null | undefined;
  usage: AgentUsage | null | undefined;
  pausedAt: string | null;
  canEditLimits: boolean;
  /** Told when its edits become unsaved or saved, for the page's one leave guard. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { isDemoMode } = useDemo();
  const [draft, setDraft] = useState<Draft>(() => draftOf(limits));
  const [busy, setBusy] = useState(false);
  const saved = draftOf(limits);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const spent = usage && budgetSpent(agentLimitsOf(limits ?? null), usage);
  const set = (key: keyof Draft) => (value: number | '') => setDraft((d) => ({ ...d, [key]: value }));

  const save = async () => {
    if (isDemoMode) return void toast('info', DEMO_NOTICE);
    setBusy(true);
    try {
      await workspaceApi(`/api/workspace/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: {
          limits: {
            max_concurrent_runs: valueOf(draft.max_concurrent_runs),
            rate_per_minute: valueOf(draft.rate_per_minute),
            budget_usd: valueOf(draft.budget_usd),
            budget_tokens: valueOf(draft.budget_tokens),
            budget_period: draft.budget_period,
          },
        },
      });
      invalidateTables(['team_members']);
      toast('success', 'Limits saved');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save the limits');
    } finally {
      setBusy(false);
    }
  };

  const hint = (text: string, empty = 'no limit') => (canEditLimits ? `${text} Empty: ${empty}.` : text);

  return (
    <section aria-labelledby="rp-limits" className="space-y-5 lg:col-span-2">
      <div className="border-t border-white/[0.06] pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="rp-limits" className="text-[15px] font-semibold text-white">Limits</h2>
          {dirty && <span className="rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-300">Unsaved</span>}
        </div>
        <p className="mt-1 max-w-xl text-xs text-zinc-500">
          How hard {agentName} may run. Pause it from the top of this page: it still reads, reports its heartbeat and its usage; everything else it tries is refused until it is resumed.
        </p>
      </div>

      {pausedAt && (
        <p role="status" className="rounded-xl bg-amber-500/[0.08] px-4 py-3 text-sm text-zinc-200">
          Paused {timeAgo(pausedAt).toLowerCase()}. It reads and reports only.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <NumberInput label={LIMIT_LABELS.max_concurrent_runs} description={hint('Runs and claimed tasks at once.')} value={draft.max_concurrent_runs} onChange={set('max_concurrent_runs')} min={1} max={1000} step={1} disabled={!canEditLimits} placeholder="No limit" />
        <NumberInput label={LIMIT_LABELS.rate_per_minute} description={hint('Across all its keys.', '120 a minute per key')} value={draft.rate_per_minute} onChange={set('rate_per_minute')} min={1} max={10000} step={1} disabled={!canEditLimits} placeholder="120 a minute per key" />
        <NumberInput label={LIMIT_LABELS.budget_usd} description={hint('Spend before new runs stop.')} value={draft.budget_usd} onChange={set('budget_usd')} min={0.01} step={1} precision={2} prefix="$" disabled={!canEditLimits} placeholder="No budget" />
        <NumberInput label={LIMIT_LABELS.budget_tokens} description={hint('Input and output tokens.')} value={draft.budget_tokens} onChange={set('budget_tokens')} min={1} step={1000} disabled={!canEditLimits} placeholder="No budget" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label={LIMIT_LABELS.budget_period}
          value={draft.budget_period}
          onChange={(value) => setDraft((d) => ({ ...d, budget_period: value as BudgetPeriod }))}
          options={BUDGET_PERIODS.map((period) => ({ value: period, label: PERIOD_LABELS[period] }))}
          disabled={!canEditLimits}
          helperText="In UTC."
        />
        {usage && (
          <div className="sm:col-span-1 lg:col-span-3">
            <p className="text-sm font-medium text-zinc-300">Now</p>
            <p className={`mt-1.5 text-sm ${spent ? 'text-amber-300' : 'text-zinc-400'}`}>
              {usage.running_runs} running, {usage.live_claims} claimed. Spent {formatUsd(usage.spent_usd)} and {usage.spent_tokens.toLocaleString('en-US')} tokens {periodWords(agentLimitsOf(limits ?? null).budget_period)}.
              {spent ? ' Its budget is spent: new runs are refused.' : ''}
            </p>
          </div>
        )}
      </div>
      {!canEditLimits && <p className="text-xs text-zinc-500">Only a workspace Owner changes limits.</p>}
      {canEditLimits && (
        <div className="flex items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-xs text-amber-300">Limits not saved yet</span>}
          {dirty && <Button variant="ghost" onClick={() => setDraft(saved)}>Discard</Button>}
          <Button onClick={save} disabled={!dirty || busy}>{busy ? 'Saving' : 'Save limits'}</Button>
        </div>
      )}
    </section>
  );
}
