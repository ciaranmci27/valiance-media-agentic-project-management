'use client';

import { Check, Circle, ExternalLink, Loader2, Minus, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { agentRunDetailRead } from '@/lib/reads';
import {
  canSeeRunTrace, formatRunDuration, runDurationMs, runPill, runTitle, runTokens,
} from '@/lib/agents-tab';
import type { AgentRunPlanStep, AgentRunStatus, AgentRunSummary } from '@/lib/agent-runs';
import { formatMoneyExact, formatNumber } from '@/lib/format';
import { appLocale } from '@/lib/region';
import { timeAgo } from '@/lib/task-times';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * The pieces every run view shares: the status pill, the started and length
 * labels, and the run's own detail (its plan, notes, tokens and cost, and the
 * trace link for whoever may follow it).
 */

/** A run's pill: its real status, or for a turn what it came to (runPill), so it never contradicts the title. */
export function RunStatusPill({ status, run }: { status?: AgentRunStatus; run?: Pick<AgentRunSummary, 'source' | 'status' | 'outcome'> }) {
  const pill = runPill(run ?? { source: 'run', status: status ?? 'succeeded', outcome: null });
  return (
    <Badge variant={pill.tone} className="whitespace-nowrap">
      {pill.running && <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />}
      {pill.label}
    </Badge>
  );
}

/** "Nov 24, 2:05 PM": when a run started, in full. */
export function runStartedFull(iso: string): string {
  return new Date(iso).toLocaleString(appLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The started cell: "5 min ago", with the full time on hover and for screen readers. */
export function RunStarted({ iso }: { iso: string }) {
  const full = runStartedFull(iso);
  return (
    <Tooltip content={full}>
      <time dateTime={iso} className="tabular-nums whitespace-nowrap">
        <span aria-hidden="true">{timeAgo(iso)}</span>
        <span className="sr-only">{full}</span>
      </time>
    </Tooltip>
  );
}

/** How long it took, or "12m so far" while it runs; a dash when unknown. */
export function runLengthLabel(run: AgentRunSummary, now = Date.now()): string {
  const ms = runDurationMs(run, now);
  if (ms === null) return '';
  return run.status === 'running' ? `${formatRunDuration(ms)} so far` : formatRunDuration(ms);
}

export function runTokensLabel(run: AgentRunSummary): string {
  const tokens = runTokens(run);
  return tokens === null ? '' : formatNumber(tokens, { maximumFractionDigits: 0 });
}

function costLabel(cost: number): string {
  if (cost > 0 && cost < 0.01) return `Under ${formatMoneyExact(0.01, { currency: 'USD' })}`;
  return formatMoneyExact(cost, { currency: 'USD' });
}

const STEP_ICON: Record<AgentRunPlanStep['status'], { icon: typeof Check; className: string; label: string }> = {
  done: { icon: Check, className: 'text-emerald-300', label: 'Done' },
  running: { icon: Loader2, className: 'text-brand-300 motion-safe:animate-spin', label: 'In progress' },
  failed: { icon: X, className: 'text-red-300', label: 'Failed' },
  skipped: { icon: Minus, className: 'text-zinc-500', label: 'Skipped' },
  pending: { icon: Circle, className: 'text-zinc-500', label: 'Not started' },
};

/** The trace link, only for the run's own agent or someone who manages agents. */
export function useCanSeeTrace(): (run: AgentRunSummary) => boolean {
  const { teamMemberId, access } = useAuth();
  const manage = hasPermission(access, 'agents.manage');
  return (run) => canSeeRunTrace(run, teamMemberId ?? null, manage);
}

/**
 * One run in a small dialog: what it is, how it went, its plan steps and
 * notes (stored runs only; a turn has neither), its tokens and cost, and the
 * harness's trace link.
 */
export function RunDetailModal({ run, onClose, onOpenTask, taskTitle, projectName }: {
  run: AgentRunSummary | null;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  taskTitle?: string | null;
  projectName?: string | null;
}) {
  const canSeeTrace = useCanSeeTrace();
  const detail = useRead(run && run.source === 'run' ? agentRunDetailRead(run.id) : null);
  if (!run) return null;

  const tokensIn = run.tokens_in;
  const tokensOut = run.tokens_out;
  const facts: { label: string; value: string }[] = [
    { label: 'Agent', value: run.agent_name ?? 'Unknown agent' },
    { label: 'Started', value: runStartedFull(run.started_at) },
    { label: 'Length', value: runLengthLabel(run) || 'Not finished' },
    ...(run.trigger ? [{ label: 'Trigger', value: run.trigger.replace(/[_.-]+/g, ' ') }] : []),
    ...(run.model ? [{ label: 'Model', value: run.model }] : []),
    { label: 'Tokens in', value: tokensIn === null ? 'Not reported' : formatNumber(tokensIn, { maximumFractionDigits: 0 }) },
    { label: 'Tokens out', value: tokensOut === null ? 'Not reported' : formatNumber(tokensOut, { maximumFractionDigits: 0 }) },
    { label: 'Cost', value: run.cost_usd === null ? 'Not reported' : costLabel(run.cost_usd) },
    ...(projectName ? [{ label: 'Project', value: projectName }] : []),
  ];

  const plan = detail.data?.plan ?? [];
  const notes = detail.data?.notes ?? [];

  return (
    <Modal isOpen onClose={onClose} title={runTitle(run)} size="lg">
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusPill run={run} />
          {run.source === 'turn' && <Badge>Turn</Badge>}
          {run.task_id && taskTitle && onOpenTask && (
            <button
              type="button"
              onClick={() => onOpenTask(run.task_id!)}
              className="max-w-full truncate rounded text-sm text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-brand-300 hover:decoration-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {taskTitle}
            </button>
          )}
        </div>

        {run.summary && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">{run.summary}</p>}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 justify-between gap-3 sm:block">
              <dt className="text-xs text-zinc-500">{fact.label}</dt>
              <dd className="min-w-0 truncate text-zinc-200 tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>

        {run.source === 'run' && (
          <section className="border-t border-white/[0.06] pt-4">
            <h3 className="mb-2 text-sm font-semibold text-white">Plan</h3>
            {detail.loading ? (
              <div className="space-y-2" aria-label="Loading the plan">
                {[0, 1, 2].map((i) => <div key={i} className="h-3.5 w-2/3 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" />)}
              </div>
            ) : detail.failed ? (
              <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-300">
                Could not load the plan.
                <Button variant="secondary" size="sm" onClick={detail.reload}>Try again</Button>
              </p>
            ) : plan.length === 0 ? (
              <p className="text-sm text-zinc-400">No plan shared.</p>
            ) : (
              <ol className="space-y-1.5">
                {plan.map((step, index) => {
                  const meta = STEP_ICON[step.status] ?? STEP_ICON.pending;
                  const Icon = meta.icon;
                  return (
                    <li key={`${index}-${step.title}`} className="flex items-start gap-2 text-sm">
                      <Icon size={14} className={`mt-0.5 flex-shrink-0 ${meta.className}`} role="img" aria-label={meta.label} />
                      <span className={`min-w-0 break-words ${step.status === 'skipped' ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{step.title}</span>
                    </li>
                  );
                })}
              </ol>
            )}

            {notes.length > 0 && (
              <>
                <h3 className="mb-2 mt-4 text-sm font-semibold text-white">Notes</h3>
                <ul className="space-y-2">
                  {[...notes].reverse().map((note, index) => (
                    <li key={`${note.at}-${index}`} className="text-sm">
                      <time dateTime={note.at} className="block text-[11px] tabular-nums text-zinc-500">{runStartedFull(note.at)}</time>
                      <p className="whitespace-pre-wrap break-words text-zinc-200">{note.text}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

        {canSeeTrace(run) && (
          <div className="border-t border-white/[0.06] pt-4">
            <a
              href={run.external_url!}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-brand-300 hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              Open trace
              <ExternalLink size={13} aria-hidden="true" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </div>
        )}
      </div>
    </Modal>
  );
}
