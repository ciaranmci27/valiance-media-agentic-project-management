'use client';

import { useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { PriorityBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { TaskForm } from '@/components/tasks/TaskForm';
import Link from 'next/link';
import {
  ListTodo, Zap, Activity, Hourglass, GitMerge, Eye, CalendarClock,
  Inbox, ChevronRight, Check, Hammer, MessageSquareWarning,
} from 'lucide-react';
import { Task } from '@/lib/types';
import { parseDateOnly } from '@/lib/date-utils';
import { hasPermission } from '@/lib/access-control';
import {
  computeNeedsYou, getTaskLane, getReviewProfile, type NeedsYouItem,
} from '@/lib/autonomy';
import { MergeReviewModal } from '@/components/tasks/MergeReviewModal';

/**
 * Radar: the owner's attention surface. Three bands, strictest first:
 *
 *   1. Needs you now   — concrete actions, visually loudest, always present
 *                        (its empty state IS the good news)
 *   2. In progress     — work YOU have started; moving a task to
 *                        in_progress is the owner's own "I'm on this"
 *   3. Coming your way — agent work in flight that will predictably ask
 *                        for one merge click later
 *
 * Design rules learned the hard way elsewhere in this app: every band uses
 * ONE shared row anatomy (icon square, title + context line, right-aligned
 * meta) so nothing sits ragged; and a band never repeats its own meaning on
 * every row (the old version stamped "AUTO + YOUR MERGE" on all four rows
 * of the band whose title already said it).
 */

export default function RadarPage() {
  const { tasks, projects, taskSuggestions, timeEntries, agentActivity, deleteTask } = useApp();
  const { teamMemberId, access } = useAuth();

  const [viewingTaskId, setViewingTaskId] = useState<string | null>(null);
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const suggestionById = useMemo(
    () => new Map(taskSuggestions.map(s => [s.id, s])),
    [taskSuggestions],
  );
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);

  const laneOf = useMemo(() => {
    return (task: Task) =>
      getTaskLane(
        task,
        task.source_task_suggestion_id ? suggestionById.get(task.source_task_suggestion_id) : undefined,
        projectById.get(task.project_id),
      );
  }, [suggestionById, projectById]);

  const needsYou = useMemo(
    () => computeNeedsYou({
      tasks,
      suggestions: taskSuggestions,
      projects,
      teamMemberId,
      includeSuggestions: false,
      agentActivity,
    }),
    [tasks, taskSuggestions, projects, teamMemberId, agentActivity],
  );

  // Suggestions get their own band rather than a row inside "Needs you
  // now": they are batch review work with their own home (the Agent queue
  // and its badge), not a one-click action here.
  const pendingSuggestions = isAgentsEnabled && canManageAgents
    ? taskSuggestions.filter(s => s.status === 'pending').length
    : 0;

  const inProgress = useMemo(
    () => tasks
      .filter(t => t.status === 'in_progress' && teamMemberId && t.assignee_ids.includes(teamMemberId))
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [tasks, teamMemberId],
  );

  const comingYourWay = useMemo(
    () => tasks
      .filter(t => {
        if (t.status !== 'todo' && t.status !== 'in_progress') return false;
        const lane = laneOf(t);
        return lane === 'needs_merge' || lane === 'merge_unknown';
      })
      .sort((a, b) => {
        // Building first (closest to needing you), then queue order.
        if (a.status !== b.status) return a.status === 'in_progress' ? -1 : 1;
        return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
      }),
    [tasks, laneOf],
  );

  // The latest milestone the agent logged for a building task: shows
  // "Verification started 14m ago" instead of a static "Building now".
  const buildPhase = (task: Task) => {
    const latest = agentActivity
      .filter(a => a.reference_type === 'task' && a.reference_id === task.id)
      .reduce<{ title: string; created_at: string } | null>(
        (best, a) => (!best || a.created_at > best.created_at ? a : best), null);
    if (!latest) return 'Building now';
    const mins = Math.max(0, Math.floor((Date.now() - new Date(latest.created_at).getTime()) / 60000));
    const ago = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
    return `${latest.title} · ${ago}`;
  };

  const viewingTask = viewingTaskId ? tasks.find(t => t.id === viewingTaskId) ?? null : null;
  const reviewingTask = reviewingTaskId ? tasks.find(t => t.id === reviewingTaskId) ?? null : null;
  const reviewingProfile = reviewingTask
    ? getReviewProfile(
        reviewingTask,
        reviewingTask.source_task_suggestion_id ? suggestionById.get(reviewingTask.source_task_suggestion_id) : undefined,
        timeEntries,
      )
    : null;
  const allClear = needsYou.length === 0 && inProgress.length === 0 && comingYourWay.length === 0 && pendingSuggestions === 0;

  // ── The one row anatomy every band uses ────────────────────────────────
  //    [icon square] [title / project · context]        [meta] [affordance]

  const iconSquare = (Icon: typeof Zap, tone: string) => (
    <span className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${tone}`}>
      <Icon size={15} aria-hidden="true" />
    </span>
  );

  const dueLabel = (task: Task) => {
    if (!task.due_date) return null;
    const d = parseDateOnly(task.due_date);
    const overdue = d < new Date(new Date().setHours(0, 0, 0, 0)) && task.status !== 'done';
    return (
      <span className={`text-xs flex items-center gap-1 flex-shrink-0 tabular-nums ${overdue ? 'text-red-400 font-medium' : 'text-zinc-500'}`}>
        <CalendarClock size={12} aria-hidden="true" />
        {overdue ? 'Overdue ' : ''}
        {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    );
  };

  const row = (opts: {
    key: string;
    icon: React.ReactNode;
    title: string;
    projectId?: string;
    context: string;
    task?: Task;
    href?: string;
    showPriority?: boolean;
    showChevron?: boolean;
    onOpen?: () => void;
  }) => {
    const project = opts.projectId ? projectById.get(opts.projectId) : undefined;
    const inner = (
      <>
        {opts.icon}
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-white truncate">{opts.title}</span>
          <span className="flex items-center gap-1.5 mt-0.5 min-w-0 text-xs text-zinc-500">
            {project && (
              <>
                {project.color && (
                  <span className="w-1.5 h-1.5 rounded-full inline-block flex-shrink-0" style={{ backgroundColor: project.color }} />
                )}
                <span className="truncate flex-shrink-0 max-w-[180px] text-zinc-400">{project.name}</span>
                <span className="text-zinc-600" aria-hidden="true">·</span>
              </>
            )}
            <span className="truncate">{opts.context}</span>
          </span>
        </span>
        <span className="flex items-center gap-3 flex-shrink-0">
          {opts.task && dueLabel(opts.task)}
          {opts.task && opts.showPriority && <PriorityBadge priority={opts.task.priority} />}
          {opts.showChevron && <ChevronRight size={16} className="text-zinc-600" aria-hidden="true" />}
        </span>
      </>
    );
    const className =
      'w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/[0.03] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500';

    return opts.href ? (
      <Link key={opts.key} href={opts.href} className={className}>{inner}</Link>
    ) : (
      <button
        key={opts.key}
        type="button"
        onClick={() => (opts.onOpen ? opts.onOpen() : opts.task && setViewingTaskId(opts.task.id))}
        className={className}
      >
        {inner}
      </button>
    );
  };

  const needsYouRow = (item: NeedsYouItem, index: number) => {
    // Suggestions render in their own band; this band is task actions only.
    if (item.kind === 'suggestions' || !item.task) return null;
    const task = item.task;
    if (item.kind === 'blocked') {
      return row({
        key: `blocked-${task.id}`,
        icon: iconSquare(MessageSquareWarning, 'bg-red-500/15 text-red-300'),
        title: task.title,
        projectId: task.project_id,
        context: `Blocked: ${item.question || 'waiting on your answer'}`,
        task,
        showChevron: true,
      });
    }
    const meta = {
      merge: {
        icon: iconSquare(GitMerge, 'bg-amber-500/15 text-amber-300'),
        context: item.lane === 'needs_merge' ? 'Built and waiting on your merge' : 'In review; may be waiting on your merge',
      },
      review: { icon: iconSquare(Eye, 'bg-brand-500/15 text-brand-300'), context: 'Waiting on your review' },
      due: {
        icon: iconSquare(CalendarClock, 'bg-red-500/15 text-red-300'),
        context: task.priority === 'urgent' ? 'Urgent and unstarted' : 'Due and unstarted',
      },
    }[item.kind];
    return row({
      key: `${item.kind}-${task.id}-${index}`,
      icon: meta.icon,
      title: task.title,
      projectId: task.project_id,
      context: meta.context,
      task,
      showChevron: true,
      // Action rows open the briefing modal (what kind of review, why held,
      // straight to the PR); the side panel stays the plain task overview.
      onOpen: item.kind === 'merge' || item.kind === 'review'
        ? () => setReviewingTaskId(task.id)
        : undefined,
    });
  };

  const band = (opts: {
    icon: typeof Zap;
    title: string;
    hint: string;
    count: number;
    emphasis?: boolean;
    children: React.ReactNode;
  }) => (
    <section
      className={`glass-card rounded-xl overflow-hidden ${opts.emphasis ? 'border border-amber-500/20' : ''}`}
    >
      <div className={`flex items-center gap-2 px-4 py-3 border-b ${opts.emphasis ? 'border-amber-500/15 bg-amber-500/[0.05]' : 'border-white/[0.08]'}`}>
        <opts.icon size={15} className={opts.emphasis ? 'text-amber-300' : 'text-zinc-400'} aria-hidden="true" />
        <h2 className="text-sm font-semibold text-white">{opts.title}</h2>
        <span className={`text-xs tabular-nums px-1.5 py-0.5 rounded-full ${
          opts.emphasis && opts.count > 0 ? 'bg-amber-500/15 text-amber-300' : 'bg-white/[0.06] text-zinc-400'
        }`}>
          {opts.count}
        </span>
        <span className="text-xs text-zinc-500 ml-auto hidden sm:block truncate pl-3">{opts.hint}</span>
      </div>
      <div className="divide-y divide-white/[0.04]">{opts.children}</div>
    </section>
  );

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="My Tasks"
        subtitle={
          needsYou.length > 0
            ? `${needsYou.length} thing${needsYou.length === 1 ? '' : 's'} need${needsYou.length === 1 ? 's' : ''} you`
            : 'All clear. Nothing needs you right now'
        }
      />

      {/* One centered reading column: a queue reads top-down, and centering
          is what makes the narrow measure look deliberate on wide screens
          instead of abandoned. */}
      <div className="p-4 lg:p-6">
        <div className="max-w-3xl mx-auto space-y-5">
          {allClear ? (
            <div className="text-center py-20 glass-card rounded-xl">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/[0.06] flex items-center justify-center">
                <ListTodo className="text-brand-300" size={30} aria-hidden="true" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">All clear</h3>
              <p className="text-zinc-400 max-w-md mx-auto">
                Nothing needs you, nothing is in your hands, and nothing in
                flight is headed your way. The moment that changes, it
                appears here.
              </p>
            </div>
          ) : (
            <>
              {/* Band 1 is ALWAYS rendered: its empty state is the good
                  news, and a band that disappears makes the reader hunt
                  for whether they missed it. */}
              {band({
                icon: Zap,
                title: 'Needs you now',
                hint: 'each row is one action',
                count: needsYou.length,
                emphasis: true,
                children: needsYou.length > 0
                  ? needsYou.map(needsYouRow)
                  : (
                    <div className="flex items-center gap-3 px-4 py-4 text-sm text-zinc-400">
                      <span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-300 flex items-center justify-center flex-shrink-0">
                        <Check size={15} aria-hidden="true" />
                      </span>
                      Nothing needs you right now.
                    </div>
                  ),
              })}

              {inProgress.length > 0 &&
                band({
                  icon: Activity,
                  title: 'In progress',
                  hint: 'work you have started',
                  count: inProgress.length,
                  children: inProgress.map(task => row({
                    key: task.id,
                    icon: iconSquare(Activity, 'bg-brand-500/15 text-brand-300'),
                    title: task.title,
                    projectId: task.project_id,
                    context: task.subtasks.length > 0
                      ? `${task.subtasks.filter(s => s.completed).length} of ${task.subtasks.length} subtasks done`
                      : 'Started by you',
                    task,
                    showPriority: true,
                  })),
                })}

              {pendingSuggestions > 0 &&
                band({
                  icon: Inbox,
                  title: 'Suggestions',
                  hint: 'reviewed in the Agent queue',
                  count: pendingSuggestions,
                  children: row({
                    key: 'suggestions',
                    icon: iconSquare(Inbox, 'bg-brand-500/15 text-brand-300'),
                    title: `${pendingSuggestions} suggestion${pendingSuggestions === 1 ? '' : 's'} awaiting your review`,
                    context: 'Approve or decline in the review queue',
                    href: '/agent',
                    showChevron: true,
                  }),
                })}

              {comingYourWay.length > 0 &&
                band({
                  icon: Hourglass,
                  title: 'Coming your way',
                  hint: 'each will ask for one merge click when built',
                  count: comingYourWay.length,
                  children: comingYourWay.map(task => row({
                    key: task.id,
                    icon: task.status === 'in_progress'
                      ? iconSquare(Hammer, 'bg-brand-500/15 text-brand-300')
                      : iconSquare(Hourglass, 'bg-white/[0.06] text-zinc-400'),
                    title: task.title,
                    projectId: task.project_id,
                    context: task.status === 'in_progress' ? buildPhase(task) : 'Queued for the agent',
                    task,
                    showPriority: true,
                  })),
                })}
            </>
          )}
        </div>
      </div>

      <MergeReviewModal
        task={reviewingTask}
        profile={reviewingProfile}
        projectName={reviewingTask ? projectById.get(reviewingTask.project_id)?.name ?? null : null}
        open={!!reviewingTask}
        onClose={() => setReviewingTaskId(null)}
        onOpenTask={(task) => setViewingTaskId(task.id)}
      />

      <TaskDetailPanel
        task={viewingTask}
        onClose={() => setViewingTaskId(null)}
        onEdit={(task) => { setViewingTaskId(null); setEditingTask(task); }}
        onDelete={(id) => setDeletingTaskId(id)}
      />

      {editingTask && (
        <TaskForm
          isOpen={!!editingTask}
          onClose={() => setEditingTask(null)}
          projectId={editingTask.project_id}
          task={editingTask}
        />
      )}

      <ConfirmDialog
        isOpen={!!deletingTaskId}
        onClose={() => setDeletingTaskId(null)}
        onConfirm={() => {
          if (deletingTaskId) deleteTask(deletingTaskId);
          setViewingTaskId(null);
        }}
        title="Delete Task"
        message="This will permanently delete this task and all its subtasks and comments. This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
      />
    </div>
  );
}
