'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { Check, CheckCircle2, ChevronDown, Eye, GitMerge, Lightbulb, MessageSquareWarning, X } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { agentsListRead, decidedQuestionsRead, useTaskWarmer } from '@/lib/reads';
import { useNeedsYou } from '@/lib/use-needs-you';
import { useNeedsYouActions } from '@/lib/needs-you-actions';
import { useRemembered } from '@/lib/use-remembered';
import { suggestionsInReach } from '@/lib/suggestion-reach';
import { answerLine, decisionLine } from '@/lib/questions';
import { getReviewProfile } from '@/lib/autonomy';
import type { AgentNeedsYou, AgentReviewItem } from '@/lib/agents-tab';
import {
  defaultNeedsYouGrouping, groupNeedsYou, windowOf, type NeedsYouEntry, type NeedsYouGrouping, showMoreLabel,
} from '@/lib/agents-ui';
import { timeAgo } from '@/lib/task-times';
import type { Task, TaskSuggestion } from '@/lib/types';
import type { QuestionView } from '@/lib/questions';
import { Button } from '@/components/ui/Button';
import { QuestionCard } from '@/components/questions/QuestionCard';
import { ReviewQueue } from '@/components/agent/ReviewQueue';
import { ApproveModal } from '@/components/agent/ApproveModal';
import { EditSuggestionModal } from '@/components/agent/EditSuggestionModal';
import { DeclineSuggestionModal } from '@/components/agent/DeclineSuggestionModal';
import { MergeReviewModal } from '@/components/tasks/MergeReviewModal';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar } from '@/components/agent/AgentAvatar';

/**
 * Everything agents are waiting on the signed-in person for, as one calm
 * inbox of decisions: questions and approvals, agents blocked on a task,
 * work ready to merge or review, and suggested tasks. Each reads as a
 * decision with its actions on the row (a suggestion: Approve and Decline,
 * on desktop and phone). Items from agents the person owns lead. At scale it
 * groups by agent and each group shows a few, with the rest a click away, so
 * the counts always add up to the tab's badge. The counts come from
 * useNeedsYou, the one hook My Tasks and the sidebar read too. Decided keeps what was
 * decided lately: who decided each, how, and when.
 */
export function useAgentNeedsYou(): AgentNeedsYou {
  return useNeedsYou().agents;
}

type Item = NeedsYouEntry & (
  | { kind: 'approval' | 'question'; question: QuestionView }
  | { kind: 'blocked'; task: Task; text: string; questionId?: string }
  | { kind: 'merge' | 'review'; review: AgentReviewItem }
  | { kind: 'suggestion'; suggestion: TaskSuggestion }
);

/** How many of a group show before "Show more". */
const GROUP_PAGE = 5;

function entriesOf(needs: AgentNeedsYou): Item[] {
  return [
    ...needs.questions.map((q): Item => ({ id: q.id, kind: q.kind === 'approval' ? 'approval' : 'question', agentId: q.asked_by, at: q.created_at, question: q })),
    ...needs.blocked.map(({ task, question, agentId, questionId }): Item => ({
      id: task.id, kind: 'blocked', agentId, at: task.updated_at, task, text: question, questionId,
    })),
    ...needs.inReview.map((review): Item => ({
      id: review.task.id, kind: review.reviewerVerdict !== undefined ? 'merge' : 'review', agentId: review.agentId || null, at: review.task.updated_at, review,
    })),
    ...needs.pendingSuggestions.map((s): Item => ({ id: s.id, kind: 'suggestion', agentId: s.proposed_by, at: s.created_at, suggestion: s })),
  ];
}

const isGrouping = (value: unknown): value is NeedsYouGrouping | null => value === null || value === 'kind' || value === 'agent';

export function NeedsYouView({ needs, onOpenTask, compact = false }: {
  needs: AgentNeedsYou;
  onOpenTask: (taskId: string) => void;
  /** Inside an agent's profile: no grouping switch, no full suggestion queue, a short empty line. */
  compact?: boolean;
}) {
  const { tasks, taskSuggestions, projects, team, timeEntries, updateSuggestion } = useApp();
  const actions = useNeedsYouActions();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const agents = useRead(agentsListRead(isDemoMode));
  const warmTask = useTaskWarmer();
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [editModalId, setEditModalId] = useState<string | null>(null);
  const [declineModalId, setDeclineModalId] = useState<string | null>(null);
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const [grouping, setGrouping] = useRemembered<NeedsYouGrouping | null>('pm:needs-you-grouping', null, isGrouping);
  const [open, setOpen] = useState<Record<string, number>>({});
  const [queueOpen, setQueueOpen] = useState(false);
  const [view, setView] = useState<'open' | 'decided'>('open');

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const memberById = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const owned = useMemo(() => new Set((agents.data ?? []).filter((a) => a.owners.some((o) => o.id === teamMemberId)).map((a) => a.id)), [agents.data, teamMemberId]);
  const items = useMemo(() => entriesOf(needs), [needs]);
  const by = compact ? 'kind' : grouping ?? defaultNeedsYouGrouping(items);
  const groups = useMemo(
    () => groupNeedsYou(items, by, { ownedAgentIds: owned, agentNames: new Map(team.map((m) => [m.id, m.name])) }),
    [items, by, owned, team],
  );

  const approveTarget = approveModalId ? taskSuggestions.find((s) => s.id === approveModalId) : undefined;
  const editTarget = editModalId ? taskSuggestions.find((s) => s.id === editModalId) : undefined;
  const declineTarget = declineModalId ? taskSuggestions.find((s) => s.id === declineModalId) : undefined;
  const reviewingTask = reviewingTaskId ? tasks.find((t) => t.id === reviewingTaskId) ?? null : null;
  const reviewingProfile = reviewingTask
    ? getReviewProfile(
        reviewingTask,
        reviewingTask.source_task_suggestion_id ? taskSuggestions.find((s) => s.id === reviewingTask.source_task_suggestion_id) : undefined,
        timeEntries,
      )
    : null;

  const who = (agentId: string | null) => (agentId ? memberById.get(agentId) : undefined);

  /** One decision row: who asks, what, where, and the actions that answer it (under the text on phones). */
  const decisionRow = (item: Item, opts: { icon: ReactNode; title: string; context: string; projectId?: string | null; action: ReactNode; onOpen?: () => void; warm?: object }) => {
    const agent = who(item.agentId);
    const project = opts.projectId ? projectById.get(opts.projectId) : undefined;
    return (
      <div className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
        {agent ? <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar || null} size="sm" /> : <span className="mt-0.5">{opts.icon}</span>}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
            <span className="font-medium text-zinc-300">{agent?.name ?? 'An agent'}</span>
            <span aria-hidden="true">·</span>
            <span>{opts.context}</span>
            <time dateTime={item.at} className="tabular-nums">· {timeAgo(item.at)}</time>
          </p>
          {opts.onOpen ? (
            <button type="button" onClick={opts.onOpen} {...opts.warm} className="mt-1 block max-w-full text-left text-[15px] font-medium leading-snug text-white hover:text-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
              {opts.title}
            </button>
          ) : (
            <p className="mt-1 text-[15px] font-medium leading-snug text-white">{opts.title}</p>
          )}
          {project && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
              {project.color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: project.color }} aria-hidden="true" />}
              {project.name}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 sm:hidden">{opts.action}</div>
        </div>
        <div className="hidden flex-shrink-0 items-center gap-2 self-center sm:flex">{opts.action}</div>
      </div>
    );
  };

  const renderItem = (item: Item) => {
    switch (item.kind) {
      case 'approval':
      case 'question':
        // The question card is the decision itself: choices, approve and reject, answer in place.
        return <QuestionCard question={item.question} variant="band" place onOpenTask={onOpenTask} />;
      case 'blocked':
        // The task panel shows the open question it raised (to answer there); an older block has none, so it just opens the task.
        return decisionRow(item, {
          icon: <MessageSquareWarning size={16} className="text-red-300" aria-hidden="true" />,
          title: item.text || 'Waiting on a person',
          context: `Blocked on ${item.task.title}`,
          projectId: item.task.project_id,
          action: <Button size="sm" onClick={() => onOpenTask(item.task.id)} {...warmTask(item.task.id)}>{item.questionId ? 'See question' : 'Open task'}</Button>,
        });
      case 'merge': {
        const verdict = item.review.reviewerVerdict;
        const context = verdict?.verdict === 'approved' ? 'Reviewed, ready to merge'
          : verdict?.verdict === 'changes_requested' ? `Changes requested, round ${verdict.round}` : 'Built, ready to merge';
        return decisionRow(item, {
          icon: <GitMerge size={16} className="text-emerald-300" aria-hidden="true" />,
          title: item.review.task.title,
          context,
          projectId: item.review.task.project_id,
          onOpen: () => setReviewingTaskId(item.review.task.id),
          action: <Button size="sm" onClick={() => setReviewingTaskId(item.review.task.id)}>Review changes</Button>,
        });
      }
      case 'review':
        return decisionRow(item, {
          icon: <Eye size={16} className="text-brand-300" aria-hidden="true" />,
          title: item.review.task.title,
          context: 'Finished, waiting on review',
          projectId: item.review.task.project_id,
          onOpen: () => onOpenTask(item.review.task.id),
          warm: warmTask(item.review.task.id),
          action: <Button size="sm" variant="secondary" onClick={() => onOpenTask(item.review.task.id)} {...warmTask(item.review.task.id)}>Review</Button>,
        });
      case 'suggestion':
        return decisionRow(item, {
          icon: <Lightbulb size={16} className="text-amber-300" aria-hidden="true" />,
          title: item.suggestion.title,
          // An info request the agent answered is back with you to decide.
          context: item.suggestion.status === 'needs_info' ? 'Answered your question about a task it suggests' : 'Suggests a task',
          projectId: item.suggestion.project_id,
          onOpen: () => setEditModalId(item.suggestion.id),
          action: (
            <>
              <Button size="sm" variant="ghost" onClick={() => setEditModalId(item.suggestion.id)} className="hidden sm:inline-flex">Edit</Button>
              <Button size="sm" variant="secondary" onClick={() => setDeclineModalId(item.suggestion.id)}>Decline</Button>
              <Button size="sm" onClick={() => setApproveModalId(item.suggestion.id)}>Approve</Button>
            </>
          ),
        });
    }
  };

  const viewSwitch = !compact && (
    <div className="seg-track seg-sm" role="group" aria-label="Show">
      <button type="button" className={`seg-item ${view === 'open' ? 'is-active' : ''}`} aria-pressed={view === 'open'} onClick={() => setView('open')}>
        Waiting on you{items.length > 0 ? ` (${items.length})` : ''}
      </button>
      <button type="button" className={`seg-item ${view === 'decided' ? 'is-active' : ''}`} aria-pressed={view === 'decided'} onClick={() => setView('decided')}>
        Decided
      </button>
    </div>
  );

  if (!compact && view === 'decided') {
    return (
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-zinc-400">Decided in the last 30 days, newest first.</p>
          {viewSwitch}
        </div>
        <DecidedList onOpenTask={onOpenTask} />
      </div>
    );
  }

  return (
    <div className={compact ? '' : 'mx-auto max-w-4xl'}>
      {!compact && items.length === 0 && <div className="mb-2 flex justify-end">{viewSwitch}</div>}
      {items.length === 0 && compact ? (
        <p className="flex items-center gap-2 text-sm text-zinc-400"><CheckCircle2 size={15} className="text-emerald-300" aria-hidden="true" />Nothing from this agent needs you.</p>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-20 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/[0.12] text-emerald-300" aria-hidden="true"><CheckCircle2 size={26} /></span>
          <h2 className="mt-5 text-lg font-semibold tracking-tight text-white">Nothing needs you</h2>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-400">
            When an agent asks a question, wants an approval, gets stuck or finishes work for you to check, it lands here.
          </p>
          <Link href="/agent?tab=agents" className="mt-5 text-sm font-medium text-brand-300 hover:text-brand-200">See what your agents are doing</Link>
        </div>
      ) : (
        <>
          {!compact && <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            {/* The count is the tab's badge and the page subtitle; this line only says how it is ordered. */}
            {viewSwitch}
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-zinc-400">
                {owned.size > 0 && items.some((i) => i.agentId && owned.has(i.agentId)) ? 'Your agents first, then newest.' : 'Newest first.'}
              </p>
              <div className="seg-track seg-sm" role="group" aria-label="Group by">
                {(['kind', 'agent'] as const).map((g) => (
                  <button key={g} type="button" className={`seg-item ${by === g ? 'is-active' : ''}`} aria-pressed={by === g} onClick={() => setGrouping(g)}>
                    {g === 'kind' ? 'By kind' : 'By agent'}
                  </button>
                ))}
              </div>
            </div>
          </div>}

          <div className="space-y-6">
            {groups.map((group) => {
              const { shown, hidden } = windowOf(group.items, open[group.key] ?? 1, GROUP_PAGE);
              const agent = by === 'agent' ? memberById.get(group.key) : undefined;
              return (
                <section key={group.key} aria-labelledby={`needs-${group.key}`}>
                  <h3 id={`needs-${group.key}`} className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-zinc-200">
                    {agent && <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar || null} size="xs" />}
                    {group.label}
                    <span className="text-xs font-normal tabular-nums text-zinc-500">{group.items.length}</span>
                  </h3>
                  <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
                    {shown.map((item) => <li key={`${item.kind}:${item.id}`}>{renderItem(item)}</li>)}
                  </ul>
                  {hidden > 0 && (
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setOpen({ ...open, [group.key]: (open[group.key] ?? 1) + 1 })}>
                      {showMoreLabel(hidden, GROUP_PAGE)}
                    </Button>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}

      {/* The full suggestion queue: history, bundles and bulk actions, out of the way. */}
      {!compact && <section className="mt-10 border-t border-white/[0.06] pt-5">
        <button
          type="button"
          onClick={() => setQueueOpen(!queueOpen)}
          aria-expanded={queueOpen}
          className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left text-sm text-zinc-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <span>All suggestions: history, bundles and bulk actions</span>
          <ChevronDown size={16} className={`transition-transform duration-200 ${queueOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {queueOpen && (
          <div className="animate-slideDown mt-4">
            <ReviewQueue onApprove={(id) => setApproveModalId(id)} onEdit={(id) => setEditModalId(id)} onDecline={(id) => setDeclineModalId(id)} />
          </div>
        )}
      </section>}

      {approveTarget && (
        <ApproveModal
          suggestion={approveTarget}
          onClose={() => setApproveModalId(null)}
          onApprove={async (overrides) => {
            const id = approveTarget.id;
            setApproveModalId(null);
            const outcome = await actions.acceptSuggestion(id, overrides);
            if (outcome.status === 'done') toast('success', 'Approved, task created');
          }}
        />
      )}

      {editTarget && (
        <EditSuggestionModal
          suggestion={editTarget}
          onClose={() => setEditModalId(null)}
          onSave={async (updates) => {
            const id = editTarget.id;
            setEditModalId(null);
            // Said once it is saved; a failed save is reverted and says so itself.
            if (await updateSuggestion(id, updates)) toast('success', 'Suggestion updated');
          }}
        />
      )}

      <DeclineSuggestionModal suggestion={declineTarget} onClose={() => setDeclineModalId(null)} />

      <MergeReviewModal
        task={reviewingTask}
        profile={reviewingProfile}
        projectName={reviewingTask ? projectById.get(reviewingTask.project_id)?.name ?? null : null}
        open={!!reviewingTask}
        onClose={() => setReviewingTaskId(null)}
        onOpenTask={(task) => onOpenTask(task.id)}
      />
    </div>
  );
}

/** How far back Decided reaches. */
const DECIDED_DAYS = 30;
const DECIDED_PAGE = 20;

interface DecidedEntry {
  id: string;
  agentId: string | null;
  at: string;
  title: string;
  /** Who decided, how and what: "Approved by Mia in the app", "You declined". */
  line: string;
  /** A yes (approved, answered) or a no (rejected, declined). */
  yes: boolean;
  projectId: string | null;
  taskId: string | null;
}

/**
 * What was decided lately on agents' questions, approvals and suggestions:
 * who decided each, how (in the app, with a key, through an agent) and when,
 * so a decision stays visible after the moment for the decider and the team.
 */
function DecidedList({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const { taskSuggestions, projects, team } = useApp();
  const { teamMemberId } = useAuth();
  const { isDemoMode } = useDemo();
  const decided = useRead(decidedQuestionsRead(isDemoMode));
  const [pages, setPages] = useState(1);
  // When this list was opened: the 30 days it covers.
  const [openedAt] = useState(() => Date.now());

  const memberById = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const entries = useMemo(() => {
    const agentIds = new Set(team.filter((m) => m.role === 'agent').map((m) => m.id));
    const since = new Date(openedAt - DECIDED_DAYS * 86_400_000).toISOString();
    const nameOf = (id: string | null | undefined, fallback: string | null | undefined) => (id ? memberById.get(id)?.name : null) ?? fallback ?? 'a teammate';
    const out: DecidedEntry[] = [];
    for (const q of decided.data ?? []) {
      if (!agentIds.has(q.asked_by) || !q.answered_at || q.answered_at < since) continue;
      const approval = q.kind === 'approval';
      const yours = (approval ? q.decided_by ?? q.answered_by : q.answered_by) === teamMemberId;
      out.push({
        id: `q:${q.id}`,
        agentId: q.asked_by,
        at: q.answered_at,
        title: approval ? q.action?.summary ?? q.question : q.question,
        line: approval
          ? decisionLine({ ...q, decided_by_name: q.decided_by_name ?? nameOf(q.decided_by, q.answered_by_name) }, yours)
          : `${yours ? 'You answered' : `Answered by ${nameOf(q.answered_by, q.answered_by_name)}`}: ${answerLine(q)}`,
        yes: approval ? q.decision === 'approved' : true,
        projectId: q.project_id,
        taskId: q.task_id,
      });
    }
    const verbs = { approved: 'approved', rejected: 'rejected', declined: 'declined' } as const;
    for (const s of suggestionsInReach(taskSuggestions, projects)) {
      if (!(s.status in verbs) || !s.reviewed_at || s.reviewed_at < since) continue;
      const verb = verbs[s.status as keyof typeof verbs];
      const yours = !!s.reviewed_by && s.reviewed_by === teamMemberId;
      const who = yours ? `You ${verb}` : `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${s.reviewed_by ? ` by ${nameOf(s.reviewed_by, null)}` : ''}`;
      out.push({
        id: `s:${s.id}`,
        agentId: s.proposed_by,
        at: s.reviewed_at,
        title: s.title,
        line: `${who}${s.status === 'rejected' && s.rejection_reason ? `: ${s.rejection_reason}` : ''}`,
        yes: s.status === 'approved',
        projectId: s.project_id,
        taskId: s.status === 'approved' ? s.converted_task_id ?? null : null,
      });
    }
    return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [decided.data, taskSuggestions, projects, team, memberById, teamMemberId, openedAt]);

  const { shown, hidden } = windowOf(entries, pages, DECIDED_PAGE);

  if (decided.loading && entries.length === 0) {
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only" role="status">Loading decisions</span>
        {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-2xl bg-white/[0.03] motion-reduce:animate-none" aria-hidden="true" />)}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <p className="text-sm text-zinc-300">Nothing decided in the last {DECIDED_DAYS} days.</p>
        <p className="mt-1 text-xs text-zinc-500">Approvals, answers and suggestions you or your team decide show here, with who decided and when.</p>
      </div>
    );
  }

  return (
    <>
      {decided.failed && (
        <p role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-xs text-red-300">
          Could not load decided questions; suggestions still show.
          <Button size="sm" variant="secondary" onClick={decided.reload}>Try again</Button>
        </p>
      )}
      <ul className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">
        {shown.map((entry) => {
          const agent = entry.agentId ? memberById.get(entry.agentId) : undefined;
          const project = entry.projectId ? projectById.get(entry.projectId) : undefined;
          const Icon = entry.yes ? Check : X;
          return (
            <li key={entry.id} className="flex items-start gap-3.5 px-4 py-4 sm:px-5">
              {agent ? <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar || null} size="sm" /> : <Lightbulb size={16} className="mt-0.5 text-zinc-500" aria-hidden="true" />}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-zinc-500">
                  <span className="font-medium text-zinc-300">{agent?.name ?? 'An agent'}</span>
                  {project && <><span aria-hidden="true">·</span><span>{project.name}</span></>}
                </p>
                {entry.taskId ? (
                  <button type="button" onClick={() => onOpenTask(entry.taskId!)} className="mt-1 block max-w-full rounded text-left text-sm font-medium leading-snug text-white hover:text-brand-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    {entry.title}
                  </button>
                ) : (
                  <p className="mt-1 text-sm font-medium leading-snug text-white">{entry.title}</p>
                )}
                <p className="mt-1 flex items-start gap-1.5 text-xs text-zinc-400">
                  <Icon size={13} className={`mt-px flex-shrink-0 ${entry.yes ? 'text-emerald-300' : 'text-zinc-500'}`} aria-hidden="true" />
                  <span className="min-w-0 break-words">{entry.line}</span>
                  <span aria-hidden="true">·</span>
                  <time dateTime={entry.at} className="flex-shrink-0 tabular-nums">{timeAgo(entry.at)}</time>
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPages(pages + 1)}>{showMoreLabel(hidden, DECIDED_PAGE)}</Button>
      )}
    </>
  );
}
