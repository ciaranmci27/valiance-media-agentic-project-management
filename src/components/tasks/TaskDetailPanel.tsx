'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Task, TASK_TYPES, type AiReadiness, type TaskType } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { DateInput } from '@/components/ui/inputs/DateInput';
import {
  X,
  Edit,
  Trash2,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  MessageSquare,
  Plus,
  Tag,
  Users,
  Clock,
  GripVertical,
  Bot,
  ListChecks,
  Lock,
  Maximize2,
  ClipboardCopy,
  Link2,
  Hash,
  AlignLeft,
  BellRing,
  Flag,
  CircleDot,
  Info,
  Route,
  Paperclip,
  Briefcase,
  History,
  CornerLeftUp,
  type LucideIcon,
} from 'lucide-react';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { taskAsText, taskUrl, copyText } from '@/lib/task-copy';
import { TaskReminders } from '@/components/reminders/TaskReminders';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission, canEditTask, canManageAllTasks, canBeAssignedInProject } from '@/lib/access-control';
import { TaskSourceEmailsSection, useKnownTaskEmailCount, useTaskSourceEmails } from '@/components/inbox/TaskSourceEmails';
import { RailCard, RailLayout } from '@/components/projects/TabLayout';
import { TaskSourceLine, useTaskSource } from './TaskSource';
import { NewSinceDivider, useLookedSince } from './TaskUnread';
import { TaskActivity, useTaskActivityCount } from './TaskActivity';
import { TaskFiles } from './TaskFiles';
import { TaskPanelShell } from './TaskPanelShell';
import { useTaskUrlParam } from '@/lib/use-task-url';
import { subtaskProgress } from '@/lib/subtasks';
import { lastActivityAt, timeAgo } from '@/lib/task-times';
import { SubtaskRing } from './SubtaskRing';
import { useSubtaskMenuActions } from './MakeSubtaskDialog';
import {
  DescriptionField, DetailRow, INLINE_DATE_CLASS, PeopleChips, PickField, PRIORITY_OPTIONS, STATUS_OPTIONS, TagsField, TitleField,
  taskTypeLabel, WHO_DOES_IT,
} from './TaskFields';

interface TaskDetailPanelProps {
  task: Task | null;
  onClose: () => void;
  /** Unused: every field edits in place. */
  onEdit?: (task: Task) => void;
  onDelete: (id: string) => void;
  /** 'panel' (default): slides over the page. 'page': the full task page. */
  variant?: 'panel' | 'page';
}


// Row actions (edit, delete) that show on hover or focus from sm up.
const ROW_ACTIONS = 'flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity';
const ROW_ICON_BUTTON = 'p-1 rounded text-zinc-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/** The task menu asks the open task to show its acceptance criteria. */
const ADD_CRITERIA_EVENT = 'task:add-criteria';

/** A task meant for the dev agent carries acceptance criteria; a person's task rarely does. */
function criteriaHasRole(task: Task): boolean {
  return task.ai_readiness === 'ai_ready' || task.ai_readiness === 'needs_spec';
}

/**
 * Everything you can do to a task as a whole, in one "..." menu: the side
 * panel and the task page share it, so neither carries a row of icons.
 */
export function TaskActionsMenu({ task, onDelete, showOpenAsPage = false }: {
  task: Task;
  /** Unused: every field edits in place. */
  onEdit?: (task: Task) => void;
  onDelete: (id: string) => void;
  showOpenAsPage?: boolean;
}) {
  const router = useRouter();
  const { team, tasks, getProject } = useApp();
  const { teamMemberId, access } = useAuth();
  const parent = task.parent_task_id ? tasks.find((t) => t.id === task.parent_task_id) : undefined;
  const canEdit = canEditTask(access, task, teamMemberId, parent);
  // A subtask can also go by whoever works its parent (as the database allows).
  const canDelete = canManageAllTasks(access) || (!!parent && canEditTask(access, parent, teamMemberId));
  const subtaskMenu = useSubtaskMenuActions(task, canEdit);

  const actions: RowAction[] = [
    ...(canEdit && task.acceptance_criteria.length === 0 && !criteriaHasRole(task)
      ? [{ label: 'Add acceptance criteria', icon: <ListChecks size={14} />, onClick: () => window.dispatchEvent(new CustomEvent(ADD_CRITERIA_EVENT, { detail: task.id })) }]
      : []),
    ...(showOpenAsPage
      ? [{ label: 'Open as a page', icon: <Maximize2 size={14} />, onClick: () => router.push(`/projects/${task.project_id}/tasks/${task.id}`) }]
      : []),
    ...subtaskMenu.actions,
    {
      label: 'Copy details',
      icon: <ClipboardCopy size={14} />,
      onClick: () => copyText(taskAsText(task, { projectName: getProject(task.project_id)?.name, team, tasks }), 'Task details'),
      divider: canEdit || showOpenAsPage || subtaskMenu.actions.length > 0,
    },
    { label: 'Copy link', icon: <Link2 size={14} />, onClick: () => copyText(taskUrl(task), 'Task link') },
    { label: 'Copy ID', icon: <Hash size={14} />, onClick: () => copyText(task.id, 'Task ID') },
    // The parent owns the delete and its confirmation dialog.
    ...(canDelete
      ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, onClick: () => onDelete(task.id), variant: 'danger' as const, divider: true }]
      : []),
  ];

  return (
    <>
      <RowActionsMenu label="Task actions" actions={actions} />
      {subtaskMenu.dialog}
    </>
  );
}

/**
 * One section of the task. On the page it is its own card, the project tabs'
 * RailCard; in the side panel the sections stack, split by hairlines. Same
 * heading either way: a 16px icon, a sentence-case title, a muted count.
 */
function Section({ variant, title, afterTitle, icon: Icon, count, action, children }: {
  variant: 'panel' | 'page';
  title: string;
  /** Shown right after the title (the Subtasks ring). */
  afterTitle?: ReactNode;
  icon: LucideIcon;
  count?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const end = (count !== undefined || action) && (
    <div className="flex items-center gap-3 flex-shrink-0">
      {count !== undefined && <span className="text-xs font-mono tabular-nums text-zinc-400">{count}</span>}
      {action}
    </div>
  );
  if (variant === 'page') {
    return (
      <RailCard title={title} afterTitle={afterTitle} icon={<Icon size={16} className="text-zinc-400" aria-hidden="true" />} action={end || undefined}>
        {children}
      </RailCard>
    );
  }
  return (
    <section className="px-5 py-5 border-t border-white/[0.06]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Icon size={16} className="text-zinc-400" aria-hidden="true" />
          {title}
          {afterTitle}
        </h3>
        {end}
      </div>
      {children}
    </section>
  );
}

/**
 * A section that folds away: its whole heading is the toggle, with a small
 * badge (progress) and a chevron. Closed, it is only that heading. Same look
 * as Section in the panel and on the page.
 */
function FoldingSection({ variant, title, icon: Icon, open, onToggle, badge, children }: {
  variant: 'panel' | 'page';
  title: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: () => void;
  badge?: ReactNode;
  children: ReactNode;
}) {
  const heading = (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={`flex w-full items-center gap-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
        variant === 'page' ? 'rounded-xl px-5 py-4 hover:bg-white/[0.02]' : '-mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-1.5 hover:bg-white/[0.03]'
      }`}
    >
      <Icon size={16} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
      <span className="text-sm font-semibold text-white">{title}</span>
      {badge}
      <ChevronDown
        size={16}
        className={`ml-auto flex-shrink-0 text-zinc-400 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        aria-hidden="true"
      />
    </button>
  );
  if (variant === 'page') {
    return (
      <section className="glass-card rounded-xl">
        {heading}
        {open && <div className="px-5 pb-5">{children}</div>}
      </section>
    );
  }
  return (
    <section className="px-5 py-3.5 border-t border-white/[0.06]">
      {heading}
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}

/**
 * A list's "+ Add ..." row. Closed it is one quiet line, so an empty section
 * is not an empty box; open it is the input. Enter adds and stays open for the
 * next one; Escape, or leaving it empty, closes it.
 */
function InlineAdd({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const close = () => { setOpen(false); setText(''); };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-2 -mx-2 px-2 py-1.5 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <Plus size={16} aria-hidden="true" />
        {label}
      </button>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onAdd(text.trim());
        setText('');
      }}
      className="flex items-center gap-2"
    >
      <TextInput
        value={text}
        onChange={setText}
        placeholder={placeholder}
        aria-label={label}
        size="sm"
        className="flex-1"
        autoFocus
        // preventDefault marks the Escape as handled, so the panel stays open.
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
        onBlur={() => { if (!text.trim()) close(); }}
      />
      <Button type="submit" size="sm" disabled={!text.trim()}>Add</Button>
    </form>
  );
}

/** A label and its value in the details list. */

export function TaskDetailPanel({ task, onClose, onDelete, variant = 'panel' }: TaskDetailPanelProps) {
  const {
    team,
    tasks,
    reminders,
    getTeamMember,
    getProject,
    updateTask,
    reorderTasks,
    deleteTask,
    getSubtasks,
    addSubtask,
    taskUnread,
    addCriterion,
    toggleCriterion,
    updateCriterion,
    deleteCriterion,
    addComment,
    updateComment,
    deleteComment,
    markTaskSeen,
    getTaskUpdate,
  } = useApp();
  const { teamMemberId, access } = useAuth();
  const [newComment, setNewComment] = useState('');
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [showPriorityMenu, setShowPriorityMenu] = useState(false);
  const statusMenuRef = useRef<HTMLDivElement>(null);
  const priorityMenuRef = useRef<HTMLDivElement>(null);
  const [editingSubtaskId, setEditingSubtaskId] = useState<string | null>(null);
  const [editingSubtaskTitle, setEditingSubtaskTitle] = useState('');
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingCommentText, setEditingCommentText] = useState('');
  const [draggedSubtaskId, setDraggedSubtaskId] = useState<string | null>(null);
  // Local subtask order while dragging; persisted once on drag end
  const [dragSubtaskOrder, setDragSubtaskOrder] = useState<string[] | null>(null);
  const [deleteSubtaskTarget, setDeleteSubtaskTarget] = useState<string | null>(null);
  // Finishing a task leaves its subtasks as they are; this offers to finish them too.
  const [finishSubtasksOf, setFinishSubtasksOf] = useState<string | null>(null);
  const { openTask: openTaskInPanel } = useTaskUrlParam();
  const router = useRouter();
  const [deleteCommentTarget, setDeleteCommentTarget] = useState<string | null>(null);
  const [editingCriterionId, setEditingCriterionId] = useState<string | null>(null);
  const [editingCriterionText, setEditingCriterionText] = useState('');
  const [deleteCriterionTarget, setDeleteCriterionTarget] = useState<string | null>(null);
  // Acceptance criteria are mostly for the dev agent: folded away, and not shown
  // at all on a person's task without any, unless asked for from the menu.
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [criteriaWanted, setCriteriaWanted] = useState<string | null>(null);
  const source = useTaskSource(task);

  // Opening a task reads it, and so does a change arriving while it is open.
  const openedTaskId = task?.id;
  const changedWhileOpen = openedTaskId ? getTaskUpdate(openedTaskId)?.last_at : undefined;
  useEffect(() => {
    if (openedTaskId) markTaskSeen(openedTaskId);
    // markTaskSeen is a fresh closure each render; the task and its latest change are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openedTaskId, changedWhileOpen]);

  // "Add acceptance criteria" from the task menu (which may sit outside this panel).
  useEffect(() => {
    const onWanted = (event: Event) => {
      const id = (event as CustomEvent<string>).detail;
      if (id === openedTaskId) {
        setCriteriaWanted(id);
        setCriteriaOpen(true);
      }
    };
    window.addEventListener(ADD_CRITERIA_EVENT, onWanted);
    return () => window.removeEventListener(ADD_CRITERIA_EVENT, onWanted);
  }, [openedTaskId]);

  // Known from the board's counts, so the section is there from the first
  // frame, and a task known to have no emails never asks for them.
  const knownEmailCount = useKnownTaskEmailCount(task?.id ?? '');
  // What arrived since the person last looked, fixed as the task opens.
  const isNewSince = useLookedSince(task?.id);
  const activityCount = useTaskActivityCount(task);
  const firstNewComment = task ? task.comments.findIndex((comment) => isNewSince(comment.created_at, comment.user_id)) : -1;
  const sourceEmails = useTaskSourceEmails(task && knownEmailCount !== 0 ? task.id : null);
  const emailCount = sourceEmails?.link_count ?? knownEmailCount ?? 0;

  // A half-written comment belongs to its task: switching tasks clears it.
  const [commentTaskId, setCommentTaskId] = useState(task?.id);
  if (commentTaskId !== task?.id) {
    setCommentTaskId(task?.id);
    setNewComment('');
  }

  if (!task) return null;
  const parentTask = task.parent_task_id ? tasks.find((t) => t.id === task.parent_task_id) : undefined;
  const canEdit = canEditTask(access, task, teamMemberId, parentTask);
  const subtasks = getSubtasks(task.id);
  const openSubtasks = subtasks.filter((s) => s.status !== 'done');
  // A subtask opens where its parent is: in the panel, or as a page.
  const openTask = (target: Task) => {
    if (variant === 'page') router.push(`/projects/${target.project_id}/tasks/${target.id}`);
    else openTaskInPanel(target.id);
  };
  const setStatus = (status: Task['status']) => {
    updateTask(task.id, { status });
    if (status === 'done' && task.status !== 'done' && openSubtasks.length > 0) setFinishSubtasksOf(task.id);
  };

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const project = getProject(task.project_id);
  // Task type and who does it are for whoever runs the agents.
  const showAgentFields = isAgentsEnabled && hasPermission(access, 'agents.manage');
  // Assigning other people takes managing every task; anyone else sees who is on it.
  const canAssign = canEdit && canManageAllTasks(access);
  const assignableMembers = team.filter((member) =>
    // Anyone already assigned stays listed, so they can be taken off.
    task.assignee_ids.includes(member.id) || !project || canBeAssignedInProject(member, project));
  // The project's other tasks, open ones first: a finished task rarely holds anything up.
  const blockerChoices = tasks
    .filter((t) => t.project_id === task.project_id && t.id !== task.id)
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done'));

  const assignees = team.filter((m) => task.assignee_ids.includes(m.id));
  const subtaskCounts = subtaskProgress(subtasks);
  const satisfiedCriteria = task.acceptance_criteria.filter((c) => c.satisfied).length;
  const openReminders = reminders.filter((r) => r.task_id === task.id && r.status === 'open').length;
  const blockers = (task.blocked_by_ids || [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t);
  const openBlockers = blockers.filter((b) => b.status !== 'done');

  const showCriteria = task.acceptance_criteria.length > 0 || criteriaHasRole(task) || criteriaWanted === task.id;

  const dueOverdue = !!task.due_date && isDateOverdue(task.due_date) && task.status !== 'done';
  const createdDate = new Date(task.created_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const lastAt = lastActivityAt(task, subtasks, getTaskUpdate(task.id));

  const submitComment = () => {
    if (!newComment.trim()) return;
    addComment(task.id, newComment.trim(), teamMemberId || '');
    setNewComment('');
  };

  // ── Details: one list, every row always there ──
  const details = (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {parentTask && (
        <DetailRow icon={CornerLeftUp} label="Subtask of">
          <button
            type="button"
            onClick={() => openTask(parentTask)}
            className="max-w-full truncate text-left text-zinc-200 underline decoration-white/20 underline-offset-2 hover:text-brand-300 hover:decoration-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {parentTask.title}
          </button>
        </DetailRow>
      )}
      <DetailRow icon={CircleDot} label="Status">
        <div ref={statusMenuRef}>
          <button
            type="button"
            onClick={() => canEdit && setShowStatusMenu(!showStatusMenu)}
            disabled={!canEdit}
            aria-haspopup={canEdit ? 'menu' : undefined}
            aria-expanded={canEdit ? showStatusMenu : undefined}
            aria-label={canEdit ? 'Change status' : undefined}
            className="flex items-center gap-1 -mx-1 px-1 py-0.5 rounded-md enabled:hover:bg-white/[0.06] disabled:cursor-default transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <StatusBadge status={task.status} tooltip={false} />
            {canEdit && <ChevronDown size={14} className="text-zinc-500" aria-hidden="true" />}
          </button>
          {canEdit && (
            <Popover
              anchorRef={statusMenuRef}
              open={showStatusMenu}
              onClose={() => setShowStatusMenu(false)}
              align="start"
              width={160}
              className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1"
            >
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setStatus(opt.value);
                    setShowStatusMenu(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:bg-white/[0.06] ${
                    task.status === opt.value ? 'text-white font-medium' : 'text-zinc-300'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${opt.color}`} aria-hidden="true" />
                  {opt.label}
                  {task.status === opt.value && <Check size={14} className="ml-auto text-zinc-400" aria-hidden="true" />}
                </button>
              ))}
            </Popover>
          )}
        </div>
      </DetailRow>

      <DetailRow icon={Flag} label="Priority">
        <div ref={priorityMenuRef}>
          <button
            type="button"
            onClick={() => canEdit && setShowPriorityMenu(!showPriorityMenu)}
            disabled={!canEdit}
            aria-haspopup={canEdit ? 'menu' : undefined}
            aria-expanded={canEdit ? showPriorityMenu : undefined}
            aria-label={canEdit ? 'Change priority' : undefined}
            className="flex items-center gap-1 -mx-1 px-1 py-0.5 rounded-md enabled:hover:bg-white/[0.06] disabled:cursor-default transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <PriorityBadge priority={task.priority} tooltip={false} />
            {canEdit && <ChevronDown size={14} className="text-zinc-500" aria-hidden="true" />}
          </button>
          {canEdit && (
            <Popover
              anchorRef={priorityMenuRef}
              open={showPriorityMenu}
              onClose={() => setShowPriorityMenu(false)}
              align="start"
              width={140}
              className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1"
            >
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    updateTask(task.id, { priority: opt.value });
                    setShowPriorityMenu(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:bg-white/[0.06] ${
                    task.priority === opt.value ? 'text-white font-medium' : 'text-zinc-300'
                  }`}
                >
                  <span className={`w-2 h-2 rounded-full ${opt.color}`} aria-hidden="true" />
                  {opt.label}
                  {task.priority === opt.value && <Check size={14} className="ml-auto text-zinc-400" aria-hidden="true" />}
                </button>
              ))}
            </Popover>
          )}
        </div>
      </DetailRow>

      <DetailRow icon={Users} label="Assignees">
        <PickField
          label="Assignees"
          multiple
          canEdit={canAssign}
          display={assignees.length > 0 ? <PeopleChips people={assignees} /> : null}
          emptyText="Unassigned"
          selected={task.assignee_ids}
          options={assignableMembers.map((member) => ({
            value: member.id,
            label: member.name,
            leading: <Avatar name={member.name} src={member.avatar || undefined} size="xs" />,
          }))}
          onChange={(assignee_ids) => updateTask(task.id, { assignee_ids })}
        />
      </DetailRow>

      <DetailRow icon={Calendar} label="Due">
        {canEdit ? (
          <div className="flex items-center gap-2 min-w-0">
            <DateInput
              value={task.due_date || ''}
              onChange={(v) => updateTask(task.id, { due_date: v || null })}
              placeholder="Not set"
              ariaLabel="Due date"
              size="sm"
              clearable
              inputClassName={`${INLINE_DATE_CLASS} ${dueOverdue ? '!text-red-300' : ''}`}
            />
            {dueOverdue && <span className="text-xs font-medium text-red-300">Overdue</span>}
          </div>
        ) : task.due_date ? (
          <span className={dueOverdue ? 'text-red-300' : 'text-zinc-200'}>
            {parseDateOnly(task.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            {dueOverdue && ' (overdue)'}
          </span>
        ) : (
          <span className="text-zinc-500">Not set</span>
        )}
      </DetailRow>

      <DetailRow icon={Tag} label="Tags">
        <TagsField value={task.tags} onChange={(tags) => updateTask(task.id, { tags })} canEdit={canEdit} />
      </DetailRow>

      <DetailRow icon={Lock} label="Blocked by">
        <PickField
          label="Blocked by"
          multiple
          canEdit={canEdit}
          display={blockers.length > 0 ? (
            <span className={openBlockers.length > 0 ? 'text-amber-300' : 'text-zinc-300'}>
              {blockers.length === 1 ? blockers[0].title : `${blockers.length} tasks`}
              {openBlockers.length > 0 ? ` · ${openBlockers.length} open` : ' · all done'}
            </span>
          ) : null}
          selected={task.blocked_by_ids || []}
          options={blockerChoices.map((t) => ({
            value: t.id,
            label: t.title,
            hint: STATUS_OPTIONS.find((option) => option.value === t.status)?.label,
          }))}
          onChange={(blocked_by_ids) => updateTask(task.id, { blocked_by_ids })}
        />
      </DetailRow>

      {/* Who does it: a person (no readiness, or human_only), or the dev
          agent, specced (ai_ready) or not yet (needs_spec). A task with no
          acceptance criteria cannot be made AI Ready: the dev agent refuses
          spec-less tasks, so it would be claimed and then refused, forever. */}
      {showAgentFields && (
        <>
          <DetailRow icon={Bot} label="Who does it">
            <PickField
              label="Who does it"
              multiple={false}
              canEdit={canEdit}
              display={<span className="text-zinc-200">{WHO_DOES_IT.find((option) => option.value === (task.ai_readiness ?? ''))?.label ?? 'A person'}</span>}
              selected={[task.ai_readiness === 'human_only' ? '' : task.ai_readiness ?? '']}
              options={WHO_DOES_IT.map((option) => ({ value: option.value, label: option.label }))}
              onChange={([next = '']) => {
                const readiness = (next || null) as AiReadiness | null;
                if (readiness === 'ai_ready' && task.acceptance_criteria.length === 0) {
                  toast('error', 'Add acceptance criteria before marking this AI Ready');
                  return;
                }
                // Picking "A person" again keeps a task marked human_only as it is.
                if (!readiness && (task.ai_readiness === null || task.ai_readiness === 'human_only')) return;
                updateTask(task.id, { ai_readiness: readiness });
              }}
            />
          </DetailRow>
          {task.ai_readiness && task.ai_readiness !== 'human_only' && (
            <p className="col-span-2 -mt-1 text-xs text-zinc-400">
              {task.ai_readiness === 'needs_spec'
                ? 'Meant for the dev agent; the spec is not written yet.'
                : project?.autonomous_enabled
                  ? 'The dev agent may pick this task up on its own.'
                  : 'Ready for the dev agent once this project runs on its own.'}
            </p>
          )}
          <DetailRow icon={Briefcase} label="Task type">
            <PickField
              label="Task type"
              multiple={false}
              canEdit={canEdit}
              display={task.task_type ? <span className="text-zinc-200">{taskTypeLabel(task.task_type)}</span> : null}
              selected={task.task_type ? [task.task_type] : []}
              options={TASK_TYPES.map((type) => ({ value: type, label: taskTypeLabel(type) }))}
              onChange={([next]) => updateTask(task.id, { task_type: (next as TaskType | undefined) ?? null })}
            />
          </DetailRow>
        </>
      )}
      <DetailRow icon={Clock} label="Created">
        <time dateTime={task.created_at} className="text-zinc-300">{createdDate}</time>
      </DetailRow>
      <DetailRow icon={History} label="Updated">
        <time dateTime={lastAt} className="text-zinc-300">{timeAgo(lastAt)}</time>
      </DetailRow>

      {source && (
        <DetailRow icon={Route} label="Source">
          <TaskSourceLine source={source} />
        </DetailRow>
      )}

    </dl>
  );

  // ── The work: description, reminders, subtasks, criteria, blockers, emails, files, comments ──
  const sections = (
    <>
      <Section variant={variant} title="Description" icon={AlignLeft}>
        <DescriptionField key={task.id} value={task.description} onChange={(description) => updateTask(task.id, { description })} canEdit={canEdit} />
      </Section>

      <Section variant={variant} title="Reminders" icon={BellRing} count={openReminders > 0 ? `${openReminders} open` : undefined}>
        <TaskReminders task={task} />
      </Section>

      {/* Subtasks are tasks of their own: a row works the basics (done, name,
          order) and opens the subtask for the rest. One level deep, so a
          subtask has no Subtasks section. */}
      {!task.parent_task_id && (
      <Section
        variant={variant}
        title="Subtasks"
        // The same ring as the board card's Subtasks row.
        afterTitle={subtasks.length > 0 ? <SubtaskRing done={subtaskCounts.done} total={subtaskCounts.total} size={16} /> : undefined}
        icon={CheckSquare}
        count={subtasks.length > 0 ? `${subtaskCounts.done} of ${subtaskCounts.total}` : undefined}
      >
        {subtasks.length === 0 && !canEdit && <p className="text-sm text-zinc-500">None yet.</p>}

        <ul className="space-y-0.5">
          {(dragSubtaskOrder
            ? dragSubtaskOrder
                .map((id) => subtasks.find((s) => s.id === id))
                .filter((s): s is Task => !!s)
            : subtasks
          ).map((subtask) => {
            const done = subtask.status === 'done';
            const people = team.filter((member) => subtask.assignee_ids.includes(member.id));
            const late = !!subtask.due_date && !done && isDateOverdue(subtask.due_date);
            const unread = !!taskUnread(subtask);
            return (
            <li
              key={subtask.id}
              draggable={canEdit && editingSubtaskId !== subtask.id}
              onDragStart={() => {
                if (!canEdit) return;
                setDraggedSubtaskId(subtask.id);
                setDragSubtaskOrder(subtasks.map((s) => s.id));
              }}
              onDragEnd={() => {
                // Persist the final order once, writing only the rows that moved
                if (dragSubtaskOrder) {
                  const original = subtasks.map((s) => s.id);
                  if (dragSubtaskOrder.join() !== original.join()) {
                    reorderTasks(dragSubtaskOrder
                      .map((id, index) => ({ id, sort_order: index }))
                      .filter(({ id, sort_order }) => subtasks.find((s) => s.id === id)?.sort_order !== sort_order));
                  }
                }
                setDraggedSubtaskId(null);
                setDragSubtaskOrder(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (draggedSubtaskId && draggedSubtaskId !== subtask.id) {
                  setDragSubtaskOrder((order) => {
                    const ids = [...(order ?? subtasks.map((s) => s.id))];
                    const fromIdx = ids.indexOf(draggedSubtaskId);
                    const toIdx = ids.indexOf(subtask.id);
                    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return order;
                    ids.splice(fromIdx, 1);
                    ids.splice(toIdx, 0, draggedSubtaskId);
                    return ids;
                  });
                }
              }}
              className={`flex items-center gap-2.5 -mx-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] group ${
                draggedSubtaskId === subtask.id ? 'opacity-50' : ''
              }`}
            >
              <button
                type="button"
                onClick={() => updateTask(subtask.id, { status: done ? 'todo' : 'done' })}
                disabled={!canEdit}
                aria-label={done ? `Mark "${subtask.title}" not done` : `Mark "${subtask.title}" done`}
                aria-pressed={done}
                className={`flex-shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised ${
                  done ? 'bg-emerald-500 border-emerald-500' : 'border-white/[0.16] enabled:hover:border-emerald-400'
                }`}
              >
                {done && <Check size={12} strokeWidth={3} className="text-white" aria-hidden="true" />}
              </button>
              {editingSubtaskId === subtask.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editingSubtaskTitle.trim() && editingSubtaskTitle.trim() !== subtask.title) {
                      updateTask(subtask.id, { title: editingSubtaskTitle.trim() });
                    }
                    setEditingSubtaskId(null);
                  }}
                  className="flex-1"
                >
                  <TextInput
                    value={editingSubtaskTitle}
                    onChange={setEditingSubtaskTitle}
                    onBlur={() => {
                      if (editingSubtaskTitle.trim() && editingSubtaskTitle.trim() !== subtask.title) {
                        updateTask(subtask.id, { title: editingSubtaskTitle.trim() });
                      }
                      setEditingSubtaskId(null);
                    }}
                    aria-label="Rename subtask"
                    autoFocus
                    size="sm"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => openTask(subtask)}
                  className={`flex-1 min-w-0 text-left text-sm break-words rounded transition-colors hover:text-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    done ? 'text-zinc-500 line-through' : 'text-zinc-200'
                  }`}
                >
                  {subtask.title}
                  {unread && <span className="sr-only"> (has news since you last looked)</span>}
                </button>
              )}
              {unread && <span className="w-1.5 h-1.5 rounded-full bg-brand-500 flex-shrink-0" aria-hidden="true" />}
              {subtask.due_date && (
                <span className={`flex-shrink-0 text-xs tabular-nums ${late ? 'text-red-300' : 'text-zinc-400'}`}>
                  <span className="sr-only">Due </span>
                  {parseDateOnly(subtask.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  {late && <span className="sr-only"> (overdue)</span>}
                </span>
              )}
              {people.length > 0 && (
                <span className="flex-shrink-0" aria-label={`Assigned to ${people.map((p) => p.name).join(', ')}`} role="img">
                  <AvatarGroup users={people} max={2} size="xs" />
                </span>
              )}
              {canEdit && editingSubtaskId !== subtask.id && (
                <div className={ROW_ACTIONS}>
                  <Tooltip content="Rename">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSubtaskId(subtask.id);
                        setEditingSubtaskTitle(subtask.title);
                      }}
                      aria-label={`Rename "${subtask.title}"`}
                      className={`${ROW_ICON_BUTTON} hover:text-brand-300`}
                    >
                      <Edit size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Move to Trash">
                    <button
                      type="button"
                      onClick={() => setDeleteSubtaskTarget(subtask.id)}
                      aria-label={`Move "${subtask.title}" to Trash`}
                      className={`${ROW_ICON_BUTTON} hover:text-red-400`}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <GripVertical size={14} aria-hidden="true" className="text-zinc-600 flex-shrink-0 cursor-grab active:cursor-grabbing" />
                </div>
              )}
            </li>
            );
          })}
        </ul>
        {canEdit && <InlineAdd label="Add subtask" placeholder="Subtask title" onAdd={(text) => { void addSubtask(task.id, text); }} />}
      </Section>
      )}

      {showCriteria && (
      <FoldingSection
        variant={variant}
        title="Acceptance criteria"
        icon={ListChecks}
        open={criteriaOpen}
        onToggle={() => setCriteriaOpen((open) => !open)}
        badge={task.acceptance_criteria.length > 0 && (
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
            satisfiedCriteria === task.acceptance_criteria.length ? 'bg-emerald-500/15 text-emerald-300' : 'bg-white/[0.06] text-zinc-300'
          }`}>
            {satisfiedCriteria}/{task.acceptance_criteria.length} met
          </span>
        )}
      >
        {task.acceptance_criteria.length === 0 && !canEdit && <p className="text-sm text-zinc-500">None yet.</p>}
        <ul className="space-y-0.5">
          {task.acceptance_criteria.map((criterion) => (
            <li key={criterion.id} className="flex items-center gap-2.5 -mx-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.03] group">
              <button
                type="button"
                onClick={() => canEdit && toggleCriterion(task.id, criterion.id)}
                disabled={!canEdit}
                aria-label={criterion.satisfied ? 'Mark criterion unmet' : 'Mark criterion met'}
                aria-pressed={criterion.satisfied}
                className={`flex-shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised ${
                  criterion.satisfied ? 'bg-brand-500 border-brand-500' : 'border-white/[0.16] enabled:hover:border-brand-400'
                }`}
              >
                {criterion.satisfied && <Check size={12} strokeWidth={3} className="text-white" aria-hidden="true" />}
              </button>
              {editingCriterionId === criterion.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editingCriterionText.trim()) {
                      updateCriterion(task.id, criterion.id, editingCriterionText.trim());
                    }
                    setEditingCriterionId(null);
                  }}
                  className="flex-1"
                >
                  <TextInput
                    value={editingCriterionText}
                    onChange={setEditingCriterionText}
                    onBlur={() => {
                      if (editingCriterionText.trim()) {
                        updateCriterion(task.id, criterion.id, editingCriterionText.trim());
                      }
                      setEditingCriterionId(null);
                    }}
                    aria-label="Edit criterion"
                    autoFocus
                    size="sm"
                  />
                </form>
              ) : (
                <span
                  className={`flex-1 min-w-0 text-sm break-words ${criterion.satisfied ? 'text-zinc-500' : 'text-zinc-200'}`}
                  onDoubleClick={() => {
                    if (!canEdit) return;
                    setEditingCriterionId(criterion.id);
                    setEditingCriterionText(criterion.criterion);
                  }}
                >
                  {criterion.criterion}
                </span>
              )}
              {canEdit && editingCriterionId !== criterion.id && (
                <div className={ROW_ACTIONS}>
                  <Tooltip content="Edit">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCriterionId(criterion.id);
                        setEditingCriterionText(criterion.criterion);
                      }}
                      aria-label="Edit criterion"
                      className={`${ROW_ICON_BUTTON} hover:text-brand-300`}
                    >
                      <Edit size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <button
                      type="button"
                      onClick={() => setDeleteCriterionTarget(criterion.id)}
                      aria-label="Delete criterion"
                      className={`${ROW_ICON_BUTTON} hover:text-red-400`}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </Tooltip>
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <InlineAdd label="Add criterion" placeholder="What has to be true when it is done" onAdd={(text) => addCriterion(task.id, text)} />
        )}
      </FoldingSection>
      )}

      {blockers.length > 0 && (
        <Section variant={variant} title="Blocked by" icon={Lock} count={`${blockers.length - openBlockers.length}/${blockers.length}`}>
          {openBlockers.length > 0 && (
            <p className="text-xs text-amber-400 mb-2">
              Waiting on {openBlockers.length} {openBlockers.length === 1 ? 'task' : 'tasks'} to finish
            </p>
          )}
          <ul className="space-y-1">
            {blockers.map((blocker) => (
              <li key={blocker.id} className="flex items-center justify-between gap-2 -mx-2 px-2 py-1.5 rounded-lg bg-white/[0.03]">
                <span className={`text-sm truncate ${blocker.status === 'done' ? 'text-zinc-500 line-through' : 'text-zinc-300'}`}>
                  {blocker.title}
                </span>
                <StatusBadge status={blocker.status} tooltip={false} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {emailCount > 0 && (
        <Section variant={variant} title="Communication" icon={MessageSquare} count={String(emailCount)}>
          <TaskSourceEmailsSection data={sourceEmails} taskId={task?.id ?? null} projectId={task?.project_id ?? null} heading={false} expected={emailCount}
            isNew={(email) => isNewSince(email.linked_at, email.linked_by)} />
        </Section>
      )}

      <TaskFiles
        task={task}
        isNew={(file) => isNewSince(file.created_at, file.added_by)}
        section={({ count, action, children }) => (
          <Section variant={variant} title="Files" icon={Paperclip} count={count} action={action}>{children}</Section>
        )}
      />

      <Section variant={variant} title="Comments" icon={MessageSquare} count={task.comments.length > 0 ? task.comments.length : undefined}>
        {task.comments.length === 0 ? (
          <p className="text-sm text-zinc-500 mb-3">No comments yet.</p>
        ) : (
          <ul className="space-y-4 mb-4">
            {task.comments.map((comment, index) => {
              const author = getTeamMember(comment.user_id);
              const isOwn = comment.user_id === teamMemberId;
              return (
                <Fragment key={comment.id}>
                {index === firstNewComment && <NewSinceDivider />}
                <li className="flex gap-3 group">
                  <Avatar name={author?.name || '?'} src={author?.avatar || undefined} size="sm" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="flex items-baseline gap-2 min-w-0">
                        <span className="text-sm font-medium text-white truncate">{author?.name || 'Unknown'}</span>
                        <span className="text-xs text-zinc-500 whitespace-nowrap">
                          {new Date(comment.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      </p>
                      {editingCommentId !== comment.id && (
                        <div className={ROW_ACTIONS}>
                          {isOwn && (
                            <Tooltip content="Edit">
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingCommentId(comment.id);
                                  setEditingCommentText(comment.text);
                                }}
                                aria-label="Edit comment"
                                className={`${ROW_ICON_BUTTON} hover:text-brand-300`}
                              >
                                <Edit size={13} aria-hidden="true" />
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip content="Delete">
                            <button
                              type="button"
                              onClick={() => setDeleteCommentTarget(comment.id)}
                              aria-label="Delete comment"
                              className={`${ROW_ICON_BUTTON} hover:text-red-400`}
                            >
                              <X size={14} aria-hidden="true" />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                    {editingCommentId === comment.id ? (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (editingCommentText.trim()) {
                            updateComment(task.id, comment.id, editingCommentText.trim());
                          }
                          setEditingCommentId(null);
                        }}
                        className="mt-1.5 space-y-2"
                      >
                        <Textarea
                          value={editingCommentText}
                          onChange={setEditingCommentText}
                          aria-label="Edit comment"
                          autoFocus
                          rows={2}
                          size="sm"
                        />
                        <div className="flex gap-2">
                          <Button type="submit" size="sm">Save</Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditingCommentId(null)}>Cancel</Button>
                        </div>
                      </form>
                    ) : (
                      <p className="text-sm text-zinc-300 mt-0.5 whitespace-pre-wrap break-words">{comment.text}</p>
                    )}
                  </div>
                </li>
                </Fragment>
              );
            })}
          </ul>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitComment();
          }}
          className="flex items-end gap-2"
        >
          <Textarea
            value={newComment}
            onChange={setNewComment}
            placeholder="Write a comment"
            aria-label="Write a comment"
            size="sm"
            rows={1}
            autoResize
            maxHeight={160}
            className="flex-1"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submitComment();
              }
            }}
          />
          <Button type="submit" size="sm" disabled={!newComment.trim()} title="Ctrl or Cmd + Enter">
            Comment
          </Button>
        </form>
      </Section>

      <Section variant={variant} title="Activity" icon={History} count={activityCount > 0 ? activityCount : undefined}>
        <TaskActivity key={task.id} task={task} />
      </Section>
    </>
  );

  const dialogs = (
    <>
      <ConfirmDialog
        isOpen={!!deleteSubtaskTarget}
        onClose={() => setDeleteSubtaskTarget(null)}
        onConfirm={async () => {
          if (deleteSubtaskTarget && await deleteTask(deleteSubtaskTarget)) toast('success', 'Subtask moved to Trash');
        }}
        title="Move subtask to Trash?"
        message="The subtask goes to Trash with its comments and files."
        variant="danger"
        trash
      />

      <ConfirmDialog
        isOpen={finishSubtasksOf === task.id && openSubtasks.length > 0}
        onClose={() => setFinishSubtasksOf(null)}
        onConfirm={() => {
          openSubtasks.forEach((subtask) => updateTask(subtask.id, { status: 'done' }));
          setFinishSubtasksOf(null);
        }}
        title="Finish its subtasks too?"
        message={`"${task.title}" is done. ${openSubtasks.length === 1 ? '1 subtask is' : `${openSubtasks.length} subtasks are`} still open.`}
        confirmLabel={openSubtasks.length === 1 ? 'Finish it' : `Finish all ${openSubtasks.length}`}
      />

      <ConfirmDialog
        isOpen={!!deleteCriterionTarget}
        onClose={() => setDeleteCriterionTarget(null)}
        onConfirm={() => {
          if (deleteCriterionTarget) deleteCriterion(task.id, deleteCriterionTarget);
        }}
        title="Delete Acceptance Criterion"
        message="Are you sure you want to delete this acceptance criterion?"
        confirmLabel="Delete"
        variant="danger"
      />

      <ConfirmDialog
        isOpen={!!deleteCommentTarget}
        onClose={() => setDeleteCommentTarget(null)}
        onConfirm={async () => {
          if (deleteCommentTarget && await deleteComment(task.id, deleteCommentTarget)) toast('success', 'Comment moved to Trash');
        }}
        title="Move comment to Trash?"
        message="The comment goes to Trash."
        variant="danger"
        trash
      />
    </>
  );

  // The page: the title and menu are in the page header; the work runs down
  // the main column, the details sit in a rail (above the work on phones).
  if (variant === 'page') {
    return (
      <>
        <RailLayout
          stickyRail
          railFirstOnMobile
          rail={
            <RailCard title="Details" icon={<Info size={16} className="text-zinc-400" aria-hidden="true" />}>
              {details}
            </RailCard>
          }
        >
          {sections}
        </RailLayout>
        {dialogs}
      </>
    );
  }

  // The side panel (TaskPanelShell): Escape or the backdrop closes it.
  return (
    <TaskPanelShell
      labelledBy={`task-title-${task.id}`}
      onClose={onClose}
      after={dialogs}
      header={
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
          <TitleField
            key={task.id}
            as="h2"
            id={`task-title-${task.id}`}
            value={task.title}
            onChange={(title) => updateTask(task.id, { title })}
            canEdit={canEdit}
            className="flex-1 min-w-0 pt-0.5 text-base font-semibold text-white leading-snug break-words"
          />
          <div className="flex items-center gap-1 flex-shrink-0">
            <TaskActionsMenu task={task} onDelete={onDelete} showOpenAsPage />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close task"
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        </div>
      }
    >
      <div className="px-5 pb-5">{details}</div>
      {sections}
    </TaskPanelShell>
  );
}
