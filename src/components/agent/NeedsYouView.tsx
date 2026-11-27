'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Check, CheckCircle2, Eye, GitMerge, Lightbulb, Mail, MessageSquareWarning, X, Zap } from 'lucide-react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { useDemo } from '@/lib/demo-context';
import { useRead } from '@/lib/query-cache';
import { decidedQuestionsRead, useTaskWarmer } from '@/lib/reads';
import { useNeedsYou } from '@/lib/use-needs-you';
import { useNeedsYouActions } from '@/lib/needs-you-actions';
import { suggestionsInReach } from '@/lib/suggestion-reach';
import { answerLine, decisionLine } from '@/lib/questions';
import { getReviewProfile } from '@/lib/autonomy';
import type { AgentNeedsYou } from '@/lib/agents-tab';
import { windowOf, showMoreLabel } from '@/lib/agents-ui';
import { companyHubItems, waitedWords, type BlockedCommentItem, type HubItem } from '@/lib/ai-home';
import type { AssistantDraft } from '@/lib/assistant';
import { timeAgo } from '@/lib/task-times';
import { formatFull } from '@/lib/time-format';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ShowMore } from '@/components/ui/ShowMore';
import { SubNav } from '@/components/ui/Tabs';
import { QuestionCard } from '@/components/questions/QuestionCard';
import { ReviewQueue } from '@/components/agent/ReviewQueue';
import { ApproveModal } from '@/components/agent/ApproveModal';
import { EditSuggestionModal } from '@/components/agent/EditSuggestionModal';
import { DeclineSuggestionModal } from '@/components/agent/DeclineSuggestionModal';
import { MergeReviewModal } from '@/components/tasks/MergeReviewModal';
import { toast } from '@/components/ui/Toast';
import { AgentAvatar } from '@/components/agent/AgentAvatar';

/**
 * Needs you: the one place where everything an agent waits on a person for
 * lands and is answered (the AI home's hub; owner 2026-11-27, "a comment
 * section on a task is never the place to unblock things"). Questions and
 * approvals answer in one tap (a choice, Approve, Reject; the rest behind
 * More), stuck work opens its task, finished work opens its review, a
 * suggestion is Approve or Decline, a reply draft opens in the Inbox. Each
 * row names the agent, how long it has waited and what it unblocks. Stuck
 * work an agent only reported as a "[BLOCKED]" comment lands here too until
 * agents report blocks themselves.
 *
 * The rows are exactly the items the AI home counts (companyHubItems or
 * myHubItems in lib/ai-home), so the list, its badge and the sidebar agree.
 * `compact` is one agent's slice on its page: no card, no Decided.
 */
export function useAgentNeedsYou(): AgentNeedsYou {
  return useNeedsYou().agents;
}

type Row = HubItem & (
  | { kind: 'approval' | 'question'; payload: { question: AgentNeedsYou['questions'][number] } }
  | { kind: 'blocked'; payload: { blocked: AgentNeedsYou['blocked'][number] } }
  | { kind: 'blocked_comment'; payload: { comment: BlockedCommentItem } }
  | { kind: 'merge' | 'review'; payload: { review: AgentNeedsYou['inReview'][number] } }
  | { kind: 'suggestion'; payload: { suggestion: AgentNeedsYou['pendingSuggestions'][number] } }
  | { kind: 'draft'; payload: { draft: AssistantDraft } }
);

/** The rows behind the items, in the items' order; an item whose source is gone is left out. */
function rowsOf(items: HubItem[], needs: AgentNeedsYou, comments: BlockedCommentItem[], drafts: AssistantDraft[]): Row[] {
  const rest = (key: string) => key.slice(2);
  return items.flatMap((item): Row[] => {
    const id = rest(item.key);
    switch (item.kind) {
      case 'question':
      case 'approval': {
        const question = needs.questions.find((q) => q.id === id);
        return question ? [{ ...item, kind: item.kind, payload: { question } }] : [];
      }
      case 'blocked': {
        const blocked = needs.blocked.find((b) => b.task.id === id);
        return blocked ? [{ ...item, kind: 'blocked', payload: { blocked } }] : [];
      }
      case 'blocked_comment': {
        const comment = comments.find((c) => c.task.id === id);
        return comment ? [{ ...item, kind: 'blocked_comment', payload: { comment } }] : [];
      }
      case 'merge':
      case 'review': {
        const review = needs.inReview.find((r) => r.task.id === id);
        return review ? [{ ...item, kind: item.kind, payload: { review } }] : [];
      }
      case 'suggestion': {
        const suggestion = needs.pendingSuggestions.find((s) => s.id === id);
        return suggestion ? [{ ...item, kind: 'suggestion', payload: { suggestion } }] : [];
      }
      case 'draft': {
        const draft = drafts.find((d) => d.id === id);
        return draft ? [{ ...item, kind: 'draft', payload: { draft } }] : [];
      }
    }
  });
}

/** How many rows show at first, and how many each "Show more" adds. */
const FIRST = 5;
const STEP = 10;

export function NeedsYouView({ needs, onOpenTask, compact = false, items: givenItems, comments = [], drafts = [], scope = 'company', onSeeAgents }: {
  needs: AgentNeedsYou;
  onOpenTask: (taskId: string) => void;
  /** One agent's slice on its page: rows only, a short empty line. */
  compact?: boolean;
  /** The items to show (lib/ai-home); left out, everything in `needs`. */
  items?: HubItem[];
  /** Stuck work agents reported only as a "[BLOCKED]" comment. */
  comments?: BlockedCommentItem[];
  /** Reply drafts the person's assistant wrote. */
  drafts?: AssistantDraft[];
  /** company: a manager's view of every agent (with Decided and the full suggestion queue); mine: one person's own asks. */
  scope?: 'company' | 'mine';
  /** The empty state's way on, when there is one. */
  onSeeAgents?: () => void;
}) {
  const { tasks, taskSuggestions, projects, team, timeEntries, updateSuggestion } = useApp();
  const actions = useNeedsYouActions();
  const warmTask = useTaskWarmer();
  const [approveModalId, setApproveModalId] = useState<string | null>(null);
  const [editModalId, setEditModalId] = useState<string | null>(null);
  const [declineModalId, setDeclineModalId] = useState<string | null>(null);
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const [shown, setShown] = useState(FIRST);
  const [queueOpen, setQueueOpen] = useState(false);
  const [view, setView] = useState<'open' | 'decided'>('open');
  /** Rows whose details are open (More). */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggleOpened = (key: string) => setOpened((now) => {
    const next = new Set(now);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const memberById = useMemo(() => new Map(team.map((m) => [m.id, m])), [team]);
  const items = useMemo(() => givenItems ?? companyHubItems(needs, comments), [givenItems, needs, comments]);
  const rows = useMemo(() => rowsOf(items, needs, comments, drafts), [items, needs, comments, drafts]);

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

  const avatarOf = (agentId: string | null, fallback: ReactNode) => {
    const agent = agentId ? memberById.get(agentId) : undefined;
    return agent ? <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar || null} size="sm" /> : <span className="mt-1.5 flex w-8 flex-shrink-0 justify-center">{fallback}</span>;
  };

  /**
   * One row: the ask (up to two lines), then who asked, how long it has
   * waited, and what it unblocks (its task, opened on click) in its project;
   * the actions under the text at every width, as on a question row (one
   * list, one place): primary first, More last. `details` opens under the
   * text with More, which sits in the action group, never on a line of its own.
   */
  const decisionRow = (row: Row, opts: {
    icon: ReactNode; title: string; context: string; taskId?: string | null; taskTitle?: string | null; unblocks?: boolean;
    projectId?: string | null; action: ReactNode; details?: string | null;
  }) => {
    const agent = row.agentId ? memberById.get(row.agentId) : undefined;
    const project = opts.projectId ? projectById.get(opts.projectId) : undefined;
    const open = opened.has(row.key);
    const detailsId = `needs-you-details-${row.key}`;
    const actions = (
      <>
        {opts.action}
        {opts.details && (
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={detailsId} onClick={() => toggleOpened(row.key)}>{open ? 'Less' : 'More'}</Button>
        )}
      </>
    );
    return (
      <div className="flex items-start gap-3 px-4 py-3 lg:px-5">
        {avatarOf(row.agentId, opts.icon)}
        <div className="min-w-0 flex-1">
          <p className={`break-words text-sm font-medium text-white ${open ? 'whitespace-pre-wrap' : 'line-clamp-2'}`} title={open ? undefined : opts.title}>{opts.title}</p>
          <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
            <span className="flex-shrink-0 font-medium text-zinc-300">{agent?.name ?? 'An agent'}</span>
            <span className="text-zinc-600" aria-hidden="true">·</span>
            <span className="flex-shrink-0">{opts.context}</span>
            {row.at && <><span className="text-zinc-600" aria-hidden="true">·</span><time dateTime={row.at} title={formatFull(row.at)} className="flex-shrink-0 tabular-nums">{waitedWords(row.at)}</time></>}
            {opts.taskId && opts.taskTitle && (
              <>
                <span className="text-zinc-600" aria-hidden="true">·</span>
                {opts.unblocks && <span className="flex-shrink-0">Unblocks</span>}
                <button type="button" onClick={() => onOpenTask(opts.taskId!)} {...warmTask(opts.taskId)}
                  className="max-w-full truncate rounded text-left text-zinc-400 underline decoration-white/20 underline-offset-2 transition-colors hover:text-brand-300 hover:decoration-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                  {opts.taskTitle}
                </button>
              </>
            )}
            {project && <><span className="text-zinc-600" aria-hidden="true">·</span><span className="truncate">{project.name}</span></>}
          </p>
          {opts.details && open && <p id={detailsId} className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-300">{opts.details}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2">{actions}</div>
        </div>
      </div>
    );
  };

  const renderRow = (row: Row) => {
    switch (row.kind) {
      case 'approval':
      case 'question': {
        const question = row.payload.question;
        const agent = memberById.get(question.asked_by);
        return (
          <QuestionCard question={question} variant="hub" place onOpenTask={onOpenTask}
            lead={agent ? <AgentAvatar id={agent.id} name={agent.name} src={agent.avatar || null} size="sm" /> : undefined} />
        );
      }
      case 'blocked': {
        // The task panel shows the open question it raised (to answer there); an older block has none, so it just opens the task.
        const { task, question, questionId } = row.payload.blocked;
        const [first, ...more] = (question || 'Waiting on a person').split('\n');
        return decisionRow(row, {
          icon: <MessageSquareWarning size={16} className="text-red-300" aria-hidden="true" />,
          title: first,
          details: more.join('\n').trim() || null,
          context: 'Stuck',
          taskId: task.id, taskTitle: task.title, unblocks: true,
          projectId: task.project_id,
          // Answer is the one primary step; Open task is the same quiet button as on a comment row.
          action: <Button size="sm" variant={questionId ? 'primary' : 'secondary'} onClick={() => onOpenTask(task.id)} {...warmTask(task.id)}>{questionId ? 'Answer' : 'Open task'}</Button>,
        });
      }
      case 'blocked_comment': {
        // Read-only until agents send a blocked state: the task holds the conversation.
        const { task, comment, text } = row.payload.comment;
        const rest = comment.text.split('\n').slice(1).join('\n').trim();
        return decisionRow(row, {
          icon: <MessageSquareWarning size={16} className="text-red-300" aria-hidden="true" />,
          title: text || 'Stuck, said in a comment',
          details: rest || null,
          context: 'Stuck, said in a comment',
          taskId: task.id, taskTitle: task.title, unblocks: true,
          projectId: task.project_id,
          action: <Button size="sm" variant="secondary" onClick={() => onOpenTask(task.id)} {...warmTask(task.id)}>Open task</Button>,
        });
      }
      case 'merge': {
        const { task, reviewerVerdict: verdict } = row.payload.review;
        const context = verdict?.verdict === 'approved' ? 'Reviewed, ready to merge'
          : verdict?.verdict === 'changes_requested' ? `Changes requested, round ${verdict.round}` : 'Built, ready to merge';
        return decisionRow(row, {
          icon: <GitMerge size={16} className="text-emerald-300" aria-hidden="true" />,
          title: task.title,
          context,
          projectId: task.project_id,
          action: <Button size="sm" onClick={() => setReviewingTaskId(task.id)}>Review changes</Button>,
        });
      }
      case 'review': {
        const { task } = row.payload.review;
        return decisionRow(row, {
          icon: <Eye size={16} className="text-brand-300" aria-hidden="true" />,
          title: task.title,
          context: 'Finished, waiting on review',
          projectId: task.project_id,
          action: <Button size="sm" variant="secondary" onClick={() => onOpenTask(task.id)} {...warmTask(task.id)}>Review</Button>,
        });
      }
      case 'suggestion': {
        const suggestion = row.payload.suggestion;
        return decisionRow(row, {
          icon: <Lightbulb size={16} className="text-amber-300" aria-hidden="true" />,
          title: suggestion.title,
          // An info request the agent answered is back with you to decide.
          context: suggestion.status === 'needs_info' ? 'Answered your question about a task it suggests' : 'Suggests a task',
          details: suggestion.description?.trim() || null,
          projectId: suggestion.project_id,
          action: (
            <>
              <Button size="sm" onClick={() => setApproveModalId(suggestion.id)}>Approve</Button>
              <Button size="sm" variant="secondary" onClick={() => setDeclineModalId(suggestion.id)}>Decline</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditModalId(suggestion.id)}>Edit</Button>
            </>
          ),
        });
      }
      case 'draft': {
        const draft = row.payload.draft;
        return decisionRow(row, {
          icon: <Mail size={16} className="text-sky-300" aria-hidden="true" />,
          title: draft.subject ? `Reply draft: ${draft.subject}` : 'Reply draft ready',
          context: 'Wrote a reply for you',
          action: <Button size="sm" variant="secondary" href={`/inbox?thread=${encodeURIComponent(draft.thread_id)}`}>Open</Button>,
        });
      }
    }
  };

  const list = (
    <ul className="divide-y divide-white/[0.06]">
      {rows.slice(0, compact ? rows.length : shown).map((row) => <li key={row.key}>{renderRow(row)}</li>)}
    </ul>
  );

  const modals = (
    <>
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
    </>
  );

  if (compact) {
    return (
      <div>
        {rows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-zinc-400"><CheckCircle2 size={15} className="text-emerald-300" aria-hidden="true" />Nothing from this agent needs you.</p>
        ) : (
          <div className="overflow-hidden rounded-xl bg-white/[0.025] ring-1 ring-inset ring-white/[0.06]">{list}</div>
        )}
        {modals}
      </div>
    );
  }

  const company = scope === 'company';
  const headerAction = (
    <>
      {company && needs.suggestions > 0 && view === 'open' && (
        <Button size="sm" variant="ghost" aria-expanded={queueOpen} onClick={() => setQueueOpen(!queueOpen)}>
          {queueOpen ? 'Hide suggestions' : 'All suggestions'}
        </Button>
      )}
      {company && (
        <SubNav label="Show" active={view} onChange={setView}
          items={[{ key: 'open', label: 'Waiting', count: rows.length }, { key: 'decided', label: 'Decided' }]} />
      )}
    </>
  );

  return (
    <Card
      title="Needs you"
      icon={<Zap />}
      id={`needs-you-${scope}`}
      afterTitle={view === 'open' && rows.length > 0 ? <span className="text-xs font-normal tabular-nums text-zinc-500">{rows.length}</span> : undefined}
      action={headerAction}
      bodyClassName="pb-1"
    >
      {view === 'decided' ? (
        <div className="px-4 pb-4 lg:px-5"><DecidedList onOpenTask={onOpenTask} /></div>
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          icon={<CheckCircle2 />}
          title="Nothing needs you"
          description={company
            ? 'When an agent asks a question, wants an approval, gets stuck or finishes work for you to check, it lands here.'
            : 'When an agent asks you something or gets stuck on your work, it lands here.'}
          action={onSeeAgents ? <Button size="sm" variant="secondary" onClick={onSeeAgents}>See your agents</Button> : undefined}
        />
      ) : (
        <>
          {list}
          <ShowMore shown={Math.min(shown, rows.length)} total={rows.length} step={STEP} onMore={() => setShown(shown + STEP)} noun="things waiting" className="border-t border-white/[0.06]" />
        </>
      )}
      {company && queueOpen && view === 'open' && (
        <div className="animate-slideDown border-t border-white/[0.06] px-4 py-4 lg:px-5">
          <ReviewQueue onApprove={(id) => setApproveModalId(id)} onEdit={(id) => setEditModalId(id)} onDecline={(id) => setDeclineModalId(id)} />
        </div>
      )}
      {modals}
    </Card>
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
