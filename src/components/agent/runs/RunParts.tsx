'use client';

import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Circle, ExternalLink, Loader2, Minus, X } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { hasPermission } from '@/lib/access-control';
import { useRead } from '@/lib/query-cache';
import { agentRunDetailRead, agentRunFamilyRead, agentRunRowRead, useOpenQuestions } from '@/lib/reads';
import { useApp } from '@/lib/store';
import {
  canSeeRunTrace, formatRunDuration, runDurationMs, runPill, runTitle, runTokens, triggerLabel,
} from '@/lib/agents-tab';
import { effectiveRunStatus, type AgentRunPlanStep, type AgentRunStatus, type AgentRunSummary, type RunDisplayStatus } from '@/lib/agent-runs';
import { formatMoneyExact, formatNumber } from '@/lib/format';
import { timeAgo } from '@/lib/task-times';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { Tooltip } from '@/components/ui/Tooltip';
import { QuestionCard } from '@/components/questions/QuestionCard';
import { formatInZone } from '@/lib/time-format';

/**
 * The pieces every run view shares: the status pill, the started and length
 * labels, and the run's own detail (its plan, notes, tokens and cost, and the
 * trace link for whoever may follow it).
 */

/** A run's pill: its display status (runPill), the same column the Runs filter matches, so it never contradicts the title. */
export function RunStatusPill({ status, run }: { status?: AgentRunStatus; run?: Pick<AgentRunSummary, 'source' | 'status' | 'outcome'> & { display_status?: RunDisplayStatus } }) {
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
  return formatInZone(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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

/** How long it took, or "12m so far" while it runs or waits on a person; empty when unknown. */
export function runLengthLabel(run: AgentRunSummary, now = Date.now()): string {
  const ms = runDurationMs(run, now);
  if (ms === null) return '';
  return run.status === 'running' || run.status === 'waiting' ? `${formatRunDuration(ms)} so far` : formatRunDuration(ms);
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
 * notes (stored runs only; a step has neither), its tokens and cost, and the
 * harness's trace link. A run waiting on a person shows the open question it
 * waits on, answerable in place, and how long it has waited. Each run in its
 * chain of agents opens here too, with Back to return.
 */
export function RunDetailModal({ run, onClose, onOpenTask, taskTitle, projectName }: {
  run: AgentRunSummary | null;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  taskTitle?: string | null;
  projectName?: string | null;
}) {
  if (!run) return null;
  // A fresh history per run opened.
  return <RunDetailDialog key={run.id} run={run} onClose={onClose} onOpenTask={onOpenTask} taskTitle={taskTitle} projectName={projectName} />;
}

function RunDetailDialog({ run: opened, onClose, onOpenTask, taskTitle, projectName }: {
  run: AgentRunSummary;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  taskTitle?: string | null;
  projectName?: string | null;
}) {
  const { isDemoMode } = useDemo();
  const { team, tasks, projects } = useApp();
  // Runs opened from the chain, newest last; Back returns to the one before.
  const [trail, setTrail] = useState<string[]>([]);
  const shownId = trail[trail.length - 1] ?? null;
  const other = useRead(shownId ? agentRunRowRead(shownId, isDemoMode) : null);
  const run = shownId ? other.data ?? null : opened;
  const agentName = (id: string) => team.find((m) => m.id === id)?.name ?? 'An agent';
  const back = trail.length > 0 ? (
    <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} aria-hidden="true" />} onClick={() => setTrail(trail.slice(0, -1))}>
      Back
    </Button>
  ) : null;

  if (!run) {
    return (
      <Modal isOpen onClose={onClose} title="Run" size="lg">
        <div className="space-y-4">
          {back}
          {other.loading ? (
            <div className="space-y-2" aria-busy="true"><span className="sr-only" role="status">Loading the run</span>
              {[0, 1, 2].map((i) => <div key={i} className="h-3.5 w-2/3 animate-pulse rounded bg-white/[0.06] motion-reduce:animate-none" aria-hidden="true" />)}
            </div>
          ) : (
            <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-zinc-300">
              {other.failed ? 'Could not load this run.' : 'This run is not one you can see.'}
              {other.failed && <Button variant="secondary" size="sm" onClick={other.reload}>Try again</Button>}
            </p>
          )}
        </div>
      </Modal>
    );
  }

  const ownTask = run.id === opened.id ? taskTitle : null;
  const ownProject = run.id === opened.id ? projectName : null;
  return (
    <RunDetailBody
      run={run}
      back={back}
      agentName={agentName}
      onClose={onClose}
      onOpenTask={onOpenTask}
      onOpenRun={(id) => { if (id !== run.id) setTrail([...trail, id]); }}
      taskTitle={ownTask ?? (run.task_id ? tasks.find((t) => t.id === run.task_id)?.title ?? null : null)}
      projectName={ownProject ?? (run.project_id ? projects.find((p) => p.id === run.project_id)?.name ?? null : null)}
    />
  );
}

function RunDetailBody({ run, back, agentName, onClose, onOpenTask, onOpenRun, taskTitle, projectName }: {
  run: AgentRunSummary;
  back: ReactNode;
  agentName: (id: string) => string;
  onClose: () => void;
  onOpenTask?: (taskId: string) => void;
  onOpenRun: (runId: string) => void;
  taskTitle: string | null;
  projectName: string | null;
}) {
  const { isDemoMode } = useDemo();
  const canSeeTrace = useCanSeeTrace();
  const detail = useRead(run.source === 'run' ? agentRunDetailRead(run.id, isDemoMode) : null);
  const family = useRead(run.source === 'run' ? agentRunFamilyRead(run.id, isDemoMode) : null);
  const questions = useOpenQuestions();
  const parent = family.data?.parent ?? null;
  const children = family.data?.children ?? [];
  const chain = family.data?.chain ?? [];
  const waiting = run.status === 'waiting';
  // When the dialog opened: how long the run has waited, as of then.
  const [openedAt] = useState(() => Date.now());
  // The open questions this run waits on (questions.run_id), oldest first.
  const waitingOn = waiting ? questions.filter((q) => q.run_id === run.id && q.status === 'open') : [];

  const tokensIn = run.tokens_in;
  const tokensOut = run.tokens_out;
  const facts: { label: string; value: string }[] = [
    { label: 'Agent', value: run.agent_name ?? agentName(run.agent_id) },
    { label: 'Started', value: runStartedFull(run.started_at) },
    { label: 'Length', value: runLengthLabel(run) || 'Not reported' },
    { label: 'Started by', value: triggerLabel(run.trigger) },
    ...(run.model ? [{ label: 'Model', value: run.model }] : []),
    { label: 'Tokens sent', value: tokensIn === null ? 'Not reported' : formatNumber(tokensIn, { maximumFractionDigits: 0 }) },
    { label: 'Tokens written', value: tokensOut === null ? 'Not reported' : formatNumber(tokensOut, { maximumFractionDigits: 0 }) },
    { label: 'Cost', value: run.cost_usd === null ? 'Not reported' : costLabel(run.cost_usd) },
    ...(projectName ? [{ label: 'Project', value: projectName }] : []),
  ];

  const plan = detail.data?.plan ?? [];
  const notes = detail.data?.notes ?? [];
  const runLink = (id: string, label: ReactNode) => (
    <button
      type="button"
      onClick={() => onOpenRun(id)}
      className="min-w-0 truncate rounded text-left text-zinc-200 underline decoration-white/20 underline-offset-2 hover:text-brand-300 hover:decoration-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      {label}
    </button>
  );

  return (
    <Modal isOpen onClose={onClose} title={runTitle(run)} size="lg">
      <div className="space-y-5">
        {back}
        <div className="flex flex-wrap items-center gap-2">
          <RunStatusPill run={run} />
          {run.source === 'turn' && (
            <Tooltip content="One pass of the agent that was not part of a run it started">
              <span tabIndex={0} className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"><Badge>Step</Badge></span>
            </Tooltip>
          )}
          {run.task_id && onOpenTask && (
            <button
              type="button"
              onClick={() => onOpenTask(run.task_id!)}
              className="max-w-full truncate rounded text-sm text-zinc-300 underline decoration-white/20 underline-offset-2 hover:text-brand-300 hover:decoration-brand-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              {taskTitle ?? 'Open its task'}
            </button>
          )}
        </div>

        {run.summary && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-200">{run.summary}</p>}

        {waiting && (
          <section aria-labelledby="run-waiting-heading" className="space-y-2">
            <h3 id="run-waiting-heading" className="text-sm font-semibold text-white">
              {waitingOn[0] ? `Waiting on a person for ${formatRunDuration(Math.max(0, openedAt - Date.parse(waitingOn[0].created_at)))}` : 'Waiting on a person'}
            </h3>
            {waitingOn.length > 0
              ? waitingOn.map((q) => <QuestionCard key={q.id} question={q} variant="panel" place onOpenTask={onOpenTask} />)
              : <p className="text-sm text-zinc-400">The agent said it is waiting on someone, but asked no question you can see. It picks up again when it hears back, or reads as timed out after 7 days.</p>}
          </section>
        )}

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex min-w-0 justify-between gap-3 sm:block">
              <dt className="text-xs text-zinc-500">{fact.label}</dt>
              <dd className="min-w-0 truncate text-zinc-200 tabular-nums">{fact.value}</dd>
            </div>
          ))}
        </dl>

        {chain.length > 1 && (
          <section aria-labelledby="run-chain-heading" className="border-t border-white/[0.06] pt-4">
            <h3 id="run-chain-heading" className="text-sm font-semibold text-white">Chain of agents</h3>
            <p className="mb-2 mt-0.5 text-xs text-zinc-500">Each run sits under the run that handed it work. Open one to see it.</p>
            <ol className="space-y-1.5">
              {chain.map((link) => {
                const current = link.id === run.id;
                const otherTask = link.task_id && link.task_id !== run.task_id ? link.task_title : null;
                const label = (
                  <>
                    {agentName(link.agent_id)}
                    {link.title ? <span className="text-zinc-400">: {link.title}</span> : null}
                    {otherTask ? <span className="text-zinc-500"> on {otherTask}</span> : null}
                  </>
                );
                return (
                  <li
                    key={link.id}
                    aria-current={current ? 'true' : undefined}
                    style={{ paddingLeft: `${Math.min(link.depth, 8) * 0.875}rem` }}
                    className="flex min-w-0 items-center justify-between gap-3 text-sm"
                  >
                    <span className="flex min-w-0 items-center">
                      {link.depth > 0 && <span className="mr-1.5 text-zinc-500" aria-hidden="true">↳</span>}
                      <span className="sr-only">{`Level ${link.depth + 1}: `}</span>
                      {current ? <span className="min-w-0 truncate font-medium text-white">{label}</span> : runLink(link.id, label)}
                    </span>
                    <span className="flex flex-shrink-0 items-center gap-2">
                      {current && <Badge>This run</Badge>}
                      <RunStatusPill status={effectiveRunStatus(link)} />
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        )}

        {chain.length <= 1 && (parent || children.length > 0) && (
          <section aria-labelledby="run-chain-heading" className="border-t border-white/[0.06] pt-4">
            <h3 id="run-chain-heading" className="mb-2 text-sm font-semibold text-white">Handoff</h3>
            {parent && (
              <p className="flex min-w-0 items-center gap-1 text-sm text-zinc-300">
                <span className="flex-shrink-0 text-zinc-500">Handed this by </span>
                {runLink(parent.id, <>{agentName(parent.agent_id)}{parent.title ? <span className="text-zinc-400">: {parent.title}</span> : null}</>)}
              </p>
            )}
            {children.length > 0 && (
              <>
                <p className={`text-xs text-zinc-500 ${parent ? 'mt-3' : ''}`}>Handed work to</p>
                <ul className="mt-1.5 space-y-1.5">
                  {children.map((child) => (
                    <li key={child.id} className="flex min-w-0 items-center justify-between gap-3 text-sm">
                      {runLink(child.id, <>{agentName(child.agent_id)}{child.title ? <span className="text-zinc-400">: {child.title}</span> : null}</>)}
                      <RunStatusPill status={effectiveRunStatus(child)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        )}

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
