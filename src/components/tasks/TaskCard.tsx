'use client';

import { useId, useState } from 'react';
import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { PriorityBadge } from '@/components/ui/Badge';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, Check, ChevronDown, History, Mail, MessageSquare, Paperclip, Trash2, Lock, FileQuestion, ArrowRight, ClipboardCopy, Link2, Hash, PanelRight, BellRing, CornerLeftUp, Plus, CircleCheck } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission, canEditTask, canManageAllTasks } from '@/lib/access-control';
import { TASK_STATUS_LABELS, taskAsText, taskUrl, copyText } from '@/lib/task-copy';
import { nextReminderFor, reminderGroup, whenLabel } from '@/lib/reminders';
import { useTaskEmailCount } from '@/components/inbox/TaskSourceEmails';
import { useTaskFileCount } from './task-file-counts';
import { useTaskWarmer } from '@/lib/reads';
import { UnreadLabel } from './TaskUnread';
import { subtaskProgress } from '@/lib/subtasks';
import { createdLabel, lastActivityAt, taskTimesTooltip, timeAgo } from '@/lib/task-times';
import { useSubtaskMenuActions } from './MakeSubtaskDialog';
import { SubtaskRing } from './SubtaskRing';

interface TaskCardProps {
  task: Task;
  onView?: (task: Task) => void;
  onDelete?: (id: string) => void;
  /** Move to another column without dragging: the keyboard and touch path. */
  onMove?: (taskId: string, status: Task['status']) => void;
}

const MOVE_ORDER: Task['status'][] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

// One line in the card's panel: an icon, what it is, and its value on the right.
const PANEL_ROW = 'grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 text-xs';

// An open subtask's checkbox ring carries its status: blue in progress,
// amber in review, grey to do, dashed backlog. Done fills it green.
const STATUS_RING: Record<Task['status'], string> = {
  done: '',
  in_review: 'border-[1.5px] border-amber-400',
  in_progress: 'border-[1.5px] border-brand-400',
  todo: 'border-[1.5px] border-zinc-400',
  backlog: 'border-[1.5px] border-dashed border-zinc-500',
};

const shortDate = (date: string) => parseDateOnly(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const longDate = (date: string) => parseDateOnly(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const daysOverdue = (date: string) => Math.max(1, Math.round((Date.now() - parseDateOnly(date).getTime()) / 86_400_000));
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Which cards have their subtasks open, kept per browser so the board looks
// the same when you come back.
const OPEN_TRAYS_KEY = 'board:open-subtask-trays';
// Cards render only once tasks have loaded in the browser, so reading
// storage on the first render cannot disagree with a server render.
function useTrayOpen(taskId: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return (JSON.parse(localStorage.getItem(OPEN_TRAYS_KEY) || '[]') as string[]).includes(taskId);
    } catch {
      // Storage unavailable: trays start closed.
      return false;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      const ids = new Set(JSON.parse(localStorage.getItem(OPEN_TRAYS_KEY) || '[]') as string[]);
      if (next) ids.add(taskId); else ids.delete(taskId);
      localStorage.setItem(OPEN_TRAYS_KEY, JSON.stringify([...ids]));
    } catch {
      // Not remembered; it still opens.
    }
  };
  return [open, set];
}

export function TaskCard({ task, onView, onDelete, onMove }: TaskCardProps) {
  const { team, tasks, getProject, reminders, getSubtasks, getTaskUpdate, taskUnread, addSubtask, updateTask } = useApp();
  const { teamMemberId, access } = useAuth();
  const trayId = useId();
  const [trayOpen, setTrayOpen] = useTrayOpen(task.id);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newSubtask, setNewSubtask] = useState('');

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const nameOf = (id: string) => team.find(m => m.id === id)?.name;
  // A subtask shown on its own (a filtered list) names the task it belongs to.
  const parent = task.parent_task_id ? tasks.find(t => t.id === task.parent_task_id) : undefined;
  const canEdit = canEditTask(access, task, teamMemberId, parent);
  const canDelete = canManageAllTasks(access);
  const subtaskList = getSubtasks(task.id);
  const subtasks = subtaskProgress(subtaskList);
  const openSubtasks = subtaskList.filter(s => s.status !== 'done');
  const doneSubtasks = subtaskList.filter(s => s.status === 'done');
  const loudPriority = task.priority === 'high' || task.priority === 'urgent';
  const needsSpec = isAgentsEnabled && canManageAgents && task.ai_readiness === 'needs_spec' && !!getProject(task.project_id)?.autonomous_enabled;
  const openBlockers = task.status === 'done' ? [] : (task.blocked_by_ids || [])
    .map(id => tasks.find(t => t.id === id))
    .filter((t): t is Task => !!t && t.status !== 'done');
  const unread = !!taskUnread(task);
  const hasBadges = unread || loudPriority || needsSpec;
  const emailCount = useTaskEmailCount(task.id);
  const fileCount = useTaskFileCount(task.id);
  const warmTask = useTaskWarmer();

  const dueOverdue = !!task.due_date && isDateOverdue(task.due_date) && task.status !== 'done' && task.status !== 'backlog';
  // The step the task is waiting on. A done task's reminders close with it.
  const next = task.status !== 'done' ? nextReminderFor(reminders, task.id) : null;
  const nextOverdue = next ? reminderGroup(next.next) === 'overdue' : false;
  const nextWhen = next ? whenLabel(next.next) : null;
  const hasPanel = subtasks.total > 0 || !!next || openBlockers.length > 0 || !!task.due_date;
  // The footer always carries when anything last happened; created is on hover.
  const lastAt = lastActivityAt(task, subtaskList, getTaskUpdate(task.id));

  const subtaskMenu = useSubtaskMenuActions(task, canEdit);
  const actions: RowAction[] = [
    ...(onView ? [{ label: 'Open', icon: <PanelRight size={14} />, onClick: () => onView(task) }] : []),
    ...(canEdit && onMove
      ? MOVE_ORDER.filter(s => s !== task.status).map((status, i) => ({
          label: `Move to ${TASK_STATUS_LABELS[status]}`,
          icon: <ArrowRight size={14} />,
          onClick: () => onMove(task.id, status),
          divider: i === 0,
        }))
      : []),
    ...subtaskMenu.actions.map((action, i) => ({ ...action, divider: i === 0 })),
    {
      label: 'Copy details',
      icon: <ClipboardCopy size={14} />,
      onClick: () => copyText(taskAsText(task, { projectName: getProject(task.project_id)?.name, team, tasks }), 'Task details'),
      divider: true,
    },
    { label: 'Copy link', icon: <Link2 size={14} />, onClick: () => copyText(taskUrl(task), 'Task link') },
    { label: 'Copy ID', icon: <Hash size={14} />, onClick: () => copyText(task.id, 'Task ID') },
    ...(canDelete && onDelete
      ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, onClick: () => onDelete(task.id), variant: 'danger' as const, divider: true }]
      : []),
  ];

  const submitSubtask = () => {
    const title = newSubtask.trim();
    if (!title) return;
    void addSubtask(task.id, title);
    setNewSubtask('');
  };

  const subtaskRow = (subtask: Task) => {
    const done = subtask.status === 'done';
    const late = !!subtask.due_date && !done && isDateOverdue(subtask.due_date);
    const people = subtask.assignee_ids.map(nameOf).filter((name): name is string => !!name);
    const first = team.find(m => m.id === subtask.assignee_ids[0]);
    const detail = [
      TASK_STATUS_LABELS[subtask.status],
      subtask.due_date ? `due ${longDate(subtask.due_date)}${late ? ', overdue' : ''}` : null,
      people.length ? people.join(', ') : 'No one assigned',
    ].filter(Boolean).join(' · ');
    return (
      <li
        key={subtask.id}
        className="group/row grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-[10px] bg-white/[0.04] px-2.5 py-2 text-xs transition-colors hover:bg-white/[0.07]"
      >
        {/* The circle finishes it (or reopens it) right here; its ring keeps the status colour. */}
        {canEdit ? (
          <Tooltip content={done ? 'Mark not done' : 'Mark done'}>
            <button
              type="button"
              onClick={() => updateTask(subtask.id, { status: done ? 'todo' : 'done' })}
              aria-label={done ? `Mark "${subtask.title}" not done` : `Mark "${subtask.title}" done`}
              aria-pressed={done}
              className="-m-1 flex rounded-full p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full transition-colors ${done ? 'bg-emerald-500' : `${STATUS_RING[subtask.status]} hover:border-emerald-400`}`}>
                {done
                  ? <Check size={10} strokeWidth={3} className="text-white" aria-hidden="true" />
                  : <Check size={9} strokeWidth={3} className="text-emerald-400 opacity-0 transition-opacity group-hover/row:opacity-60" aria-hidden="true" />}
              </span>
            </button>
          </Tooltip>
        ) : (
          <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full ${done ? 'bg-emerald-500' : STATUS_RING[subtask.status]}`} aria-hidden="true">
            {done && <Check size={10} strokeWidth={3} className="text-white" />}
          </span>
        )}
        <button
          type="button"
          onClick={() => onView?.(subtask)}
          className="grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <Tooltip content={<span className="block max-w-[240px] whitespace-normal">{detail}</span>} className="min-w-0 max-w-full justify-self-start">
            <span className={`min-w-0 truncate ${done ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
              {subtask.title}
              <span className="sr-only">, {detail}</span>
            </span>
          </Tooltip>
          <span className={late ? 'text-red-300' : 'text-zinc-400'} aria-hidden="true">
            {subtask.due_date ? shortDate(subtask.due_date) : ''}
          </span>
          {first ? <Avatar name={first.name} src={first.avatar || undefined} size="xs" /> : <span aria-hidden="true" />}
        </button>
      </li>
    );
  };

  return (
    <>
    {/* A div with a button role, not a <button>: the card holds its own menu
        button, and a native button cannot start an HTML5 drag in Firefox. */}
    <div
      role="button"
      tabIndex={0}
      className={`relative z-[1] glass-card ${unread ? 'is-unread' : ''} rounded-[14px] p-3.5 hover:shadow-md hover:border-white/[0.12] transition-[box-shadow,border-color] duration-150 group cursor-pointer focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400`}
      onClick={() => onView?.(task)}
      {...warmTask(task.id)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onView?.(task);
      }}
    >
      {/* Shown on hover, and whenever focus is inside the card, so the
          keyboard reaches it too. Pinned to the corner so a card with no
          badges starts with its title. */}
      <RowActionsMenu
        actions={actions}
        label={`Actions for ${task.title}`}
        triggerClassName="absolute right-2 top-2 lg:right-3 lg:top-3 lg:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
      />

      {/* Only what asks for attention: unread, urgent or high priority, a
          missing spec. Blockers live in the panel. */}
      {hasBadges && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2 pr-7">
          <UnreadLabel task={task} />
          {loudPriority && <PriorityBadge priority={task.priority} />}
          {needsSpec && (
            <Tooltip content="Meant for the dev agent; needs a spec before it can start">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] lg:text-xs font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-full">
                <FileQuestion size={10} aria-hidden="true" />
                Needs spec
              </span>
            </Tooltip>
          )}
        </div>
      )}

      {parent && (
        <div className={`mb-0.5 min-w-0 ${hasBadges ? '' : 'pr-7'}`}>
          <Tooltip content={`Subtask of ${parent.title}`} className="max-w-full">
            <p className="flex min-w-0 items-center gap-1 text-[11px] text-zinc-400">
              <CornerLeftUp size={11} className="flex-shrink-0" aria-hidden="true" />
              <span className="sr-only">Subtask of </span>
              <span className="truncate">{parent.title}</span>
            </p>
          </Tooltip>
        </div>
      )}
      <h3 className={`font-medium text-white text-sm leading-snug mb-1 line-clamp-2 ${hasBadges || parent ? '' : 'pr-7'}`}>
        {task.title}
      </h3>

      {task.description && (
        <p className="text-xs leading-relaxed text-zinc-400 line-clamp-2">{task.description}</p>
      )}

      {/* Where the work stands, one row per thing that applies. */}
      {hasPanel && (
        <div className="mt-3 grid gap-[7px] rounded-[10px] bg-white/[0.04] px-3 py-2.5">
          {subtasks.total > 0 && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setTrayOpen(!trayOpen); }}
              aria-expanded={trayOpen}
              aria-controls={trayId}
              className={`${PANEL_ROW} group/subtasks cursor-pointer rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500`}
            >
              <SubtaskRing done={subtasks.done} total={subtasks.total} />
              <span className="flex min-w-0 items-center gap-1 text-zinc-200 transition-colors group-hover/subtasks:text-white">
                <span className="truncate">Subtasks</span>
                {/* Says it opens: on hover (and while open) where there is a
                    pointer, always on touch screens, which have no hover. */}
                <ChevronDown
                  size={13}
                  aria-hidden="true"
                  className={`flex-shrink-0 text-zinc-400 transition-[opacity,transform] duration-150 motion-reduce:transition-none ${
                    trayOpen
                      ? 'rotate-180 opacity-100'
                      : 'opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/subtasks:opacity-100 [@media(hover:hover)]:group-focus-visible/subtasks:opacity-100'
                  }`}
                />
              </span>
              <span className={`transition-colors ${subtasks.done === subtasks.total ? 'text-emerald-300' : 'text-zinc-400 group-hover/subtasks:text-zinc-200'}`}>
                {subtasks.done} of {subtasks.total}<span className="sr-only"> done</span>
              </span>
            </button>
          )}
          {next && (
            <div className={PANEL_ROW}>
              <BellRing size={15} className="text-brand-300" aria-hidden="true" />
              <Tooltip
                className="min-w-0 max-w-full justify-self-start"
                content={(
                <span className="block max-w-[240px] whitespace-normal">
                  <span className="block">Next step: {next.next.title}</span>
                  <span className="block text-zinc-400">
                    {nextWhen ? (nextOverdue ? `Overdue: ${nextWhen}` : nextWhen) : 'No date'}
                    {next.open > 1 ? ` · ${next.open - 1} more waiting` : ''}
                  </span>
                </span>
                )}
              >
                <span className="min-w-0 truncate text-zinc-200"><span className="sr-only">Next step: </span>{next.next.title}</span>
              </Tooltip>
              <span className={nextOverdue ? 'text-red-300' : 'text-zinc-400'}>
                {nextWhen}{next.open > 1 ? `${nextWhen ? ' · ' : ''}+${next.open - 1}` : ''}
              </span>
            </div>
          )}
          {openBlockers.length > 0 && (
            <div className={PANEL_ROW}>
              <Lock size={15} className="text-amber-300" aria-hidden="true" />
              <Tooltip
                className="min-w-0 max-w-full justify-self-start"
                content={(
                <span className="block max-w-[240px] whitespace-normal">
                  <span className="block">Blocked by:</span>
                  {openBlockers.map(blocker => (
                    <span key={blocker.id} className="block text-zinc-400">{blocker.title} ({TASK_STATUS_LABELS[blocker.status]})</span>
                  ))}
                </span>
                )}
              >
                <span className="min-w-0 truncate text-zinc-200">Waiting on {openBlockers[0].title}</span>
              </Tooltip>
              <span className="text-zinc-400">{openBlockers.length}<span className="sr-only"> open {openBlockers.length === 1 ? 'blocker' : 'blockers'}</span></span>
            </div>
          )}
          {task.due_date && (
            <div className={PANEL_ROW}>
              <Calendar size={15} className={dueOverdue ? 'text-red-300' : 'text-zinc-400'} aria-hidden="true" />
              <span className="truncate text-zinc-200">Due</span>
              <Tooltip content={`Due ${longDate(task.due_date)}${dueOverdue ? ` · ${plural(daysOverdue(task.due_date), 'day')} overdue` : ''}`}>
                <span className={dueOverdue ? 'text-red-300' : 'text-zinc-400'}>
                  {shortDate(task.due_date)}{dueOverdue && <span className="sr-only">, overdue</span>}
                </span>
              </Tooltip>
            </div>
          )}
        </div>
      )}

        <div className="mt-3 flex items-center justify-between gap-2 text-xs text-zinc-400">
          <div className="flex min-w-0 items-center gap-2.5">
            {task.comments.length > 0 && (
              <Tooltip content={plural(task.comments.length, 'comment')}>
                <span className="flex items-center gap-1">
                  <MessageSquare size={14} aria-hidden="true" />
                  <span className="sr-only">{plural(task.comments.length, 'comment')}</span>
                  <span aria-hidden="true">{task.comments.length}</span>
                </span>
              </Tooltip>
            )}
            {emailCount > 0 && (
              <Tooltip content={plural(emailCount, 'linked email')}>
                <span className="flex items-center gap-1">
                  <Mail size={14} aria-hidden="true" />
                  <span className="sr-only">{plural(emailCount, 'linked email')}</span>
                  <span aria-hidden="true">{emailCount}</span>
                </span>
              </Tooltip>
            )}
            {fileCount > 0 && (
              <Tooltip content={plural(fileCount, 'file')}>
                <span className="flex items-center gap-1">
                  <Paperclip size={14} aria-hidden="true" />
                  <span className="sr-only">{plural(fileCount, 'file')}</span>
                  <span aria-hidden="true">{fileCount}</span>
                </span>
              </Tooltip>
            )}
            <Tooltip content={taskTimesTooltip(task.created_at, lastAt)} className="flex-shrink-0">
              <span className="flex items-center gap-1 whitespace-nowrap">
                <History size={14} aria-hidden="true" />
                <span className="sr-only">Updated </span>
                <time dateTime={lastAt}>{timeAgo(lastAt)}</time>
                <span className="sr-only">. {createdLabel(task.created_at)}</span>
              </span>
            </Tooltip>
            {task.tags.length > 0 && (
              <Tooltip content={`Tags: ${task.tags.join(', ')}`} className="min-w-0">
                <span className="truncate text-zinc-400">
                  <span className="sr-only">Tags: {task.tags.join(', ')}</span>
                  <span aria-hidden="true">#{task.tags[0]}{task.tags.length > 1 ? ` +${task.tags.length - 1}` : ''}</span>
                </span>
              </Tooltip>
            )}
          </div>
          {assignees.length > 0 && (
            <Tooltip content={`Assigned to ${assignees.map(a => a.name).join(', ')}`} className="flex-shrink-0">
              <AvatarGroup users={assignees} max={3} size="xs" />
            </Tooltip>
          )}
        </div>
    </div>

    {/* The subtasks slide out from under the card. Outside the card, so a
        click here never opens the parent. */}
    {subtaskList.length > 0 && (
      <div
        id={trayId}
        inert={!trayOpen}
        className={`grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${trayOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="min-h-0 overflow-hidden">
          <section
            aria-label={`Subtasks of ${task.title}`}
            className="-mt-px mx-3 rounded-b-[14px] border border-t-0 border-white/[0.08] bg-white/[0.025] px-2 pb-2 pt-2.5"
          >
            <ul className="grid gap-1.5">
              {openSubtasks.map(subtaskRow)}
              {showDone && doneSubtasks.map(subtaskRow)}
            </ul>
            {adding && (
              <form
                className="mt-1.5"
                onSubmit={(e) => { e.preventDefault(); submitSubtask(); }}
              >
                <TextInput
                  value={newSubtask}
                  onChange={setNewSubtask}
                  placeholder="Subtask title"
                  aria-label={`New subtask of ${task.title}`}
                  size="sm"
                  autoFocus
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setNewSubtask(''); } }}
                  onBlur={() => { if (!newSubtask.trim()) setAdding(false); }}
                />
              </form>
            )}
            {(doneSubtasks.length > 0 || (canEdit && !adding)) && (
              <div className="mt-1.5 flex items-center justify-between px-1">
                {doneSubtasks.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => setShowDone(!showDone)}
                    aria-expanded={showDone}
                    className="flex items-center gap-1 rounded py-0.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <CircleCheck size={13} aria-hidden="true" />
                    {showDone ? 'Hide done' : `Show ${doneSubtasks.length} done`}
                  </button>
                ) : <span />}
                {canEdit && !adding && (
                  <button
                    type="button"
                    onClick={() => setAdding(true)}
                    className="flex items-center gap-1 rounded py-0.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <Plus size={13} aria-hidden="true" />
                    Add subtask
                  </button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    )}
    {/* Outside the card: a click in the dialog must not open the card. */}
    {subtaskMenu.dialog}
    </>
  );
}
