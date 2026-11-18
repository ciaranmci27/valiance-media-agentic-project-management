'use client';

import { Suspense, useMemo, useState } from 'react';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { Header } from '@/components/layout/Header';
import { PriorityBadge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { useTaskWarmer } from '@/lib/reads';
import Link from 'next/link';
import {
  ListTodo, Zap, Activity, Hourglass, GitMerge, Eye, CalendarClock,
  Inbox, ChevronRight, Check, Hammer, MessageSquareWarning, ClipboardList, BellRing,
} from 'lucide-react';
import { Task } from '@/lib/types';
import { parseDateOnly } from '@/lib/date-utils';
import { hasPermission } from '@/lib/access-control';
import {
  computeNeedsYou, getTaskLane, getReviewProfile, type NeedsYouItem,
} from '@/lib/autonomy';
import { MergeReviewModal } from '@/components/tasks/MergeReviewModal';
import { ReminderRow } from '@/components/reminders/ReminderRow';
import { ReminderComposer } from '@/components/reminders/ReminderComposer';
import { compareReminders, reminderGroup } from '@/lib/reminders';
import { UnreadLabel, useCardUnread } from '@/components/tasks/TaskUnread';
import { MyTaskSubtasks, type SubtaskFlag } from '@/components/tasks/MyTaskSubtasks';

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
 * Your reminders live here too: one due today or overdue is a row in
 * "Needs you now" (ticking it off is the one action), and the rest sit in
 * their own band with a quick add, so this page is the one place to check.
 *
 * That is the owner's view, and anyone else who oversees agent work. A team
 * member gets the same first two bands scoped to their own actions, and an
 * "Assigned to you" band in place of the agent pipeline: without it their
 * ordinary queued work appeared nowhere on a page called My Tasks.
 *
 * Design rules learned the hard way elsewhere in this app: every band uses
 * ONE shared row anatomy (icon square, title + context line, right-aligned
 * meta) so nothing sits ragged; and a band never repeats its own meaning on
 * every row (the old version stamped "AUTO + YOUR MERGE" on all four rows
 * of the band whose title already said it).
 *
 * Subtasks never get rows of their own. Each parent appears once, in the
 * first band it or any of its subtasks belongs to, with its subtasks grouped
 * under it. A subtask in review is one you only wait on: it rolls up into
 * its parent (an "In review" band when the parent is nowhere else) and never
 * counts as a thing to do.
 */

/** Why a task is in a band: its icon square, its context line, its action. */
type Flag = SubtaskFlag & { icon: React.ReactNode };

/** A parent on the page: why it is here itself, and which subtasks put it here. */
interface Group {
  root: Task;
  self?: Flag;
  subs: Map<string, Flag>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function RadarPage() {
  // useSearchParams (the open task) needs a Suspense boundary on a static page.
  return (
    <Suspense fallback={null}>
      <RadarPageContent />
    </Suspense>
  );
}

function RadarPageContent() {
  const { tasks, projects, taskSuggestions, timeEntries, agentActivity, deleteTask, reminders, addReminder } = useApp();
  const { teamMemberId, access } = useAuth();
  const cardUnread = useCardUnread();

  // The open task is the URL's ?task=, so the address bar is a link to it.
  const { taskId: viewingTaskId, openTask: setViewingTaskId, closeTask: closeViewingTask } = useTaskUrlParam();
  // Pointing at a task warms its panel, so it opens with its emails and files.
  const warmTask = useTaskWarmer();
  const [reviewingTaskId, setReviewingTaskId] = useState<string | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [showDoneReminders, setShowDoneReminders] = useState(false);
  // Subtask trays the person opened or closed; the rest follow the default.
  const [trayOpen, setTrayOpen] = useState<Map<string, boolean>>(() => new Map());

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const suggestionById = useMemo(
    () => new Map(taskSuggestions.map(s => [s.id, s])),
    [taskSuggestions],
  );
  const projectById = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const taskById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);

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
      oversight: canManageAgents,
      agentActivity,
    }),
    [tasks, taskSuggestions, projects, teamMemberId, canManageAgents, agentActivity],
  );

  // Your reminders. Due today or overdue ones join "Needs you now"; the
  // rest (upcoming, no date) and the last 30 days of done ones get a band.
  const myReminders = useMemo(
    () => reminders.filter(r => r.owner_id === teamMemberId).sort(compareReminders),
    [reminders, teamMemberId],
  );
  const now = new Date();
  const dueReminders = myReminders.filter(r => ['overdue', 'today'].includes(reminderGroup(r, now)));
  const laterReminders = myReminders.filter(r => ['upcoming', 'no_date'].includes(reminderGroup(r, now)));
  const doneReminders = myReminders.filter(r => r.status === 'done');
  const needsYouCount = needsYou.length + dueReminders.length;

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
    () => !(isAgentsEnabled && canManageAgents) ? [] : tasks
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
    [tasks, laneOf, isAgentsEnabled, canManageAgents],
  );

  // A member's full queue: everything assigned to them that is not done.
  // Grouping below drops what is already on the page above. Soonest due
  // first, undated last.
  const assignedToYou = useMemo(() => {
    if (canManageAgents || !teamMemberId) return [];
    const PRIORITY_RANK: Record<Task['priority'], number> = { urgent: 0, high: 1, medium: 2, low: 3 };
    return tasks
      .filter(t =>
        t.assignee_ids.includes(teamMemberId)
        && (t.status === 'todo' || t.status === 'in_review'))
      .sort((a, b) => {
        if (a.due_date !== b.due_date) {
          if (!a.due_date) return 1;
          if (!b.due_date) return -1;
          return a.due_date < b.due_date ? -1 : 1;
        }
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      });
  }, [tasks, teamMemberId, canManageAgents]);

  // Your subtasks someone finished and put in review: the ones
  // computeNeedsYou leaves out. A member's sit in "Assigned to you" instead.
  const subtasksInReview = useMemo(
    () => !canManageAgents || !teamMemberId ? [] : tasks.filter(t =>
      !!t.parent_task_id
      && t.status === 'in_review'
      && t.assignee_ids.includes(teamMemberId)
      && laneOf(t) === 'manual'),
    [tasks, teamMemberId, canManageAgents, laneOf],
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
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-white truncate">{opts.title}</span>
            {/* What changed since you looked, its subtasks' changes included. */}
            {opts.task && cardUnread(opts.task) && (
              <span className="min-w-0 flex-shrink"><UnreadLabel task={opts.task} /></span>
            )}
          </span>
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
      <Link key={opts.key} href={opts.href} className={className} {...(opts.task ? warmTask(opts.task.id) : {})}>{inner}</Link>
    ) : (
      <button
        key={opts.key}
        type="button"
        onClick={() => (opts.onOpen ? opts.onOpen() : opts.task && setViewingTaskId(opts.task.id))}
        className={className}
        {...(opts.task ? warmTask(opts.task.id) : {})}
      >
        {inner}
      </button>
    );
  };

  const needsYouFlag = (item: NeedsYouItem): Flag | null => {
    // Suggestions render in their own band; this band is task actions only.
    if (item.kind === 'suggestions' || !item.task) return null;
    const task = item.task;
    if (item.kind === 'blocked') {
      return {
        icon: iconSquare(MessageSquareWarning, 'bg-red-500/15 text-red-300'),
        context: `Blocked: ${item.question || 'waiting on your answer'}`,
        action: true,
      };
    }
    // The reviewer verdict sets expectations: approved means your merge click
    // is genuinely the last step; anything else means John has not signed off
    // yet, so the row stays visible but tells you not to reach for it.
    const verdict = item.kind === 'merge' ? item.reviewerVerdict : null;
    const mergeContext = verdict?.verdict === 'approved'
      ? 'Reviewed by John and waiting on your merge'
      : verdict?.verdict === 'changes_requested'
        ? `John requested changes (round ${verdict.round})`
        : item.lane === 'needs_merge' ? 'Built and waiting on your merge' : 'In review; may be waiting on your merge';
    const meta = {
      merge: {
        icon: verdict?.verdict === 'approved'
          ? iconSquare(GitMerge, 'bg-emerald-500/15 text-emerald-300')
          : iconSquare(GitMerge, 'bg-amber-500/15 text-amber-300'),
        context: mergeContext,
      },
      review: { icon: iconSquare(Eye, 'bg-brand-500/15 text-brand-300'), context: 'Waiting on your review' },
      due: {
        icon: iconSquare(CalendarClock, 'bg-red-500/15 text-red-300'),
        context: task.priority === 'urgent' ? 'Urgent and unstarted' : 'Due and unstarted',
      },
    }[item.kind];
    return {
      icon: meta.icon,
      context: meta.context,
      action: true,
      // Action rows open the briefing modal (what kind of review, why held,
      // straight to the PR); the side panel stays the plain task overview.
      onOpen: item.kind === 'merge' || item.kind === 'review'
        ? () => setReviewingTaskId(task.id)
        : undefined,
    };
  };

  // One row per parent. Bands claim parents in page priority order, so a
  // parent shows once: in the first band where it, or a subtask of it, belongs.
  const claimed = new Set<string>();
  const groupByParent = (entries: { task: Task; flag: Flag }[]): Group[] => {
    const groups = new Map<string, Group>();
    for (const { task, flag } of entries) {
      const root = (task.parent_task_id && taskById.get(task.parent_task_id)) || task;
      if (claimed.has(root.id)) continue;
      let group = groups.get(root.id);
      if (!group) {
        group = { root, subs: new Map() };
        groups.set(root.id, group);
      }
      if (root.id === task.id) group.self ??= flag;
      else if (!group.subs.has(task.id)) group.subs.set(task.id, flag);
    }
    for (const id of groups.keys()) claimed.add(id);
    return [...groups.values()];
  };

  const needsGroups = groupByParent(needsYou.flatMap(item => {
    const flag = needsYouFlag(item);
    return flag && item.task ? [{ task: item.task, flag }] : [];
  }));
  const inProgressGroups = groupByParent(inProgress.map(task => ({
    task,
    flag: { icon: iconSquare(Activity, 'bg-brand-500/15 text-brand-300'), context: 'Started by you' },
  })));
  const assignedGroups = groupByParent(assignedToYou.map(task => ({
    task,
    flag: task.status === 'in_review'
      ? { icon: iconSquare(Eye, 'bg-white/[0.06] text-zinc-400'), context: 'Waiting on review' }
      : { icon: iconSquare(ClipboardList, 'bg-white/[0.06] text-zinc-400'), context: 'To do' },
  })));
  const inReviewGroups = groupByParent(subtasksInReview.map(task => ({
    task,
    flag: { icon: iconSquare(Eye, 'bg-white/[0.06] text-zinc-400'), context: 'In review' },
  })));
  const comingGroups = groupByParent(comingYourWay.map(task => ({
    task,
    flag: task.status === 'in_progress'
      ? { icon: iconSquare(Hammer, 'bg-brand-500/15 text-brand-300'), context: buildPhase(task) }
      : { icon: iconSquare(Hourglass, 'bg-white/[0.06] text-zinc-400'), context: 'Queued for the agent' },
  })));

  const allClear = needsYouCount === 0 && inProgressGroups.length === 0 && comingGroups.length === 0
    && assignedGroups.length === 0 && inReviewGroups.length === 0 && pendingSuggestions === 0
    && laterReminders.length === 0;

  /**
   * A parent's row, then its subtasks. When only subtasks put it here, its
   * context line says how many. Trays start closed; the person opens them.
   */
  const groupRow = (group: Group, opts: { summarize: (count: number) => string; showPriority?: boolean; showChevron?: boolean }) => {
    const { root, self, subs } = group;
    const lead = self ?? [...subs.values()][0];
    const open = trayOpen.get(root.id) ?? false;
    return (
      <div key={root.id}>
        {row({
          key: root.id,
          icon: lead.icon,
          title: root.title,
          projectId: root.project_id,
          context: self ? self.context : opts.summarize(subs.size),
          task: root,
          showPriority: opts.showPriority,
          showChevron: opts.showChevron,
          onOpen: self?.onOpen,
        })}
        <MyTaskSubtasks
          parent={root}
          flags={subs}
          open={open}
          onToggle={() => setTrayOpen(prev => new Map(prev).set(root.id, !open))}
          onOpenTask={setViewingTaskId}
        />
      </div>
    );
  };

  const band = (opts: {
    icon: typeof Zap;
    title: string;
    hint: string;
    count: number;
    emphasis?: boolean;
    id?: string;
    children: React.ReactNode;
  }) => (
    <section
      id={opts.id}
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

  const reminderRow = (reminder: typeof myReminders[number]) => (
    <ReminderRow key={reminder.id} reminder={reminder} variant="band" onOpenTask={setViewingTaskId} />
  );

  // Always shown, so a reminder can be added from here even on a clear day.
  const remindersBand = band({
    icon: BellRing,
    title: 'Reminders',
    hint: 'next steps and follow-ups; due ones move up',
    count: laterReminders.length,
    id: 'reminders',
    children: (
      <>
        <div className="px-4 py-3">
          <ReminderComposer
            placeholder="Add a reminder..."
            onAdd={(draft) => void addReminder(draft)}
          />
        </div>
        {laterReminders.map(reminderRow)}
        {doneReminders.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setShowDoneReminders(v => !v)}
              aria-expanded={showDoneReminders}
              className="w-full flex items-center gap-1.5 px-4 py-2.5 text-xs text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
            >
              <ChevronRight size={12} className={`transition-transform ${showDoneReminders ? 'rotate-90' : ''}`} aria-hidden="true" />
              Done in the last 30 days ({doneReminders.length})
            </button>
            {showDoneReminders && doneReminders.map(reminderRow)}
          </>
        )}
      </>
    ),
  });

  return (
    <div className="animate-fadeIn min-h-screen">
      <Header
        title="My Tasks"
        subtitle={
          <span className="hidden sm:inline">
            {needsYouCount > 0
              ? `${needsYouCount} thing${needsYouCount === 1 ? '' : 's'} need${needsYouCount === 1 ? 's' : ''} you`
              : 'All clear. Nothing needs you right now'}
          </span>
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
          ) : null}
          {allClear ? remindersBand : (
            <>
              {/* Band 1 is ALWAYS rendered: its empty state is the good
                  news, and a band that disappears makes the reader hunt
                  for whether they missed it. */}
              {band({
                icon: Zap,
                title: 'Needs you now',
                hint: 'each row is one action',
                count: needsYouCount,
                emphasis: true,
                children: needsYouCount > 0
                  ? (
                    <>
                      {needsGroups.map(group => groupRow(group, {
                        summarize: n => `${plural(n, 'subtask')} need${n === 1 ? 's' : ''} you`,
                        showChevron: true,
                      }))}
                      {dueReminders.map(reminderRow)}
                    </>
                  )
                  : (
                    <div className="flex items-center gap-3 px-4 py-4 text-sm text-zinc-400">
                      <span className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-300 flex items-center justify-center flex-shrink-0">
                        <Check size={15} aria-hidden="true" />
                      </span>
                      Nothing needs you right now.
                    </div>
                  ),
              })}

              {inProgressGroups.length > 0 &&
                band({
                  icon: Activity,
                  title: 'In progress',
                  hint: 'work you have started',
                  count: inProgressGroups.length,
                  children: inProgressGroups.map(group => groupRow(group, {
                    summarize: n => `${plural(n, 'subtask')} started by you`,
                    showPriority: true,
                  })),
                })}

              {remindersBand}

              {assignedGroups.length > 0 &&
                band({
                  icon: ClipboardList,
                  title: 'Assigned to you',
                  hint: 'everything else in your queue',
                  count: assignedGroups.length,
                  children: assignedGroups.map(group => groupRow(group, {
                    summarize: n => `${plural(n, 'subtask')} for you`,
                    showPriority: true,
                  })),
                })}

              {inReviewGroups.length > 0 &&
                band({
                  icon: Eye,
                  title: 'In review',
                  hint: 'subtasks you are waiting on',
                  count: inReviewGroups.length,
                  children: inReviewGroups.map(group => groupRow(group, {
                    summarize: n => `${plural(n, 'subtask')} in review`,
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

              {comingGroups.length > 0 &&
                band({
                  icon: Hourglass,
                  title: 'Coming your way',
                  hint: 'each will ask for one merge click when built',
                  count: comingGroups.length,
                  children: comingGroups.map(group => groupRow(group, {
                    summarize: n => `${plural(n, 'subtask')} with the agent`,
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
        onClose={closeViewingTask}
        onDelete={(id) => setDeletingTaskId(id)}
      />

      <ConfirmDialog
        isOpen={!!deletingTaskId}
        onClose={() => setDeletingTaskId(null)}
        onConfirm={() => {
          if (deletingTaskId) deleteTask(deletingTaskId);
          closeViewingTask();
        }}
        title="Move task to Trash?"
        message="The task goes to Trash with its subtasks and comments."
        variant="danger"
        trash
      />
    </div>
  );
}
