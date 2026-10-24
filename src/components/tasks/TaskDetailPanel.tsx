'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Task } from '@/lib/types';
import { toast } from '@/components/ui/Toast';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Toggle } from '@/components/ui/inputs/Toggle';
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
  type LucideIcon,
} from 'lucide-react';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { taskAsText, taskUrl, copyText } from '@/lib/task-copy';
import { TaskReminders } from '@/components/reminders/TaskReminders';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission, canEditTask, canManageAllTasks } from '@/lib/access-control';
import { TaskSourceEmailsSection, useTaskSourceEmails } from '@/components/inbox/TaskSourceEmails';
import { CardAction, RailCard, RailLayout } from '@/components/projects/TabLayout';

interface TaskDetailPanelProps {
  task: Task | null;
  onClose: () => void;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  /** 'panel' (default): slides over the page. 'page': the full task page. */
  variant?: 'panel' | 'page';
}

const STATUS_OPTIONS: { value: Task['status']; label: string; color: string }[] = [
  { value: 'todo', label: 'To Do', color: 'bg-zinc-400' },
  { value: 'in_progress', label: 'In Progress', color: 'bg-brand-500' },
  { value: 'in_review', label: 'In Review', color: 'bg-amber-500' },
  { value: 'done', label: 'Done', color: 'bg-emerald-500' },
];

const PRIORITY_OPTIONS: { value: Task['priority']; label: string; color: string }[] = [
  { value: 'low', label: 'Low', color: 'bg-zinc-400' },
  { value: 'medium', label: 'Medium', color: 'bg-blue-500' },
  { value: 'high', label: 'High', color: 'bg-orange-500' },
  { value: 'urgent', label: 'Urgent', color: 'bg-red-500' },
];

// The due date edits in place, so it sheds the input chrome.
const INLINE_DATE_CLASS = '!w-fit !justify-start !gap-1 !border-transparent !bg-transparent !shadow-none hover:!bg-white/[0.06] focus:!ring-0 focus:!border-transparent !px-1.5 !-mx-1.5 !py-0.5 !rounded-md';

// Row actions (edit, delete) that show on hover or focus from sm up.
const ROW_ACTIONS = 'flex items-center gap-0.5 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100 transition-opacity';
const ROW_ICON_BUTTON = 'p-1 rounded text-zinc-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';

/**
 * Everything you can do to a task as a whole, in one "..." menu: the side
 * panel and the task page share it, so neither carries a row of icons.
 */
export function TaskActionsMenu({ task, onEdit, onDelete, showOpenAsPage = false }: {
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (id: string) => void;
  showOpenAsPage?: boolean;
}) {
  const router = useRouter();
  const { team, tasks, getProject } = useApp();
  const { teamMemberId, access } = useAuth();
  const canEdit = canEditTask(access, task, teamMemberId);
  const canDelete = canManageAllTasks(access);

  const actions: RowAction[] = [
    ...(canEdit ? [{ label: 'Edit task', icon: <Edit size={14} />, onClick: () => onEdit(task) }] : []),
    ...(showOpenAsPage
      ? [{ label: 'Open as a page', icon: <Maximize2 size={14} />, onClick: () => router.push(`/projects/${task.project_id}/tasks/${task.id}`) }]
      : []),
    {
      label: 'Copy details',
      icon: <ClipboardCopy size={14} />,
      onClick: () => copyText(taskAsText(task, { projectName: getProject(task.project_id)?.name, team, tasks }), 'Task details'),
      divider: canEdit || showOpenAsPage,
    },
    { label: 'Copy link', icon: <Link2 size={14} />, onClick: () => copyText(taskUrl(task), 'Task link') },
    { label: 'Copy ID', icon: <Hash size={14} />, onClick: () => copyText(task.id, 'Task ID') },
    // The parent owns the delete and its confirmation dialog.
    ...(canDelete
      ? [{ label: 'Move to Trash', icon: <Trash2 size={14} />, onClick: () => onDelete(task.id), variant: 'danger' as const, divider: true }]
      : []),
  ];

  return <RowActionsMenu label="Task actions" actions={actions} />;
}

/**
 * One section of the task. On the page it is its own card, the project tabs'
 * RailCard; in the side panel the sections stack, split by hairlines. Same
 * heading either way: a 16px icon, a sentence-case title, a muted count.
 */
function Section({ variant, title, icon: Icon, count, action, children }: {
  variant: 'panel' | 'page';
  title: string;
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
      <RailCard title={title} icon={<Icon size={16} className="text-zinc-400" aria-hidden="true" />} action={end || undefined}>
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
        </h3>
        {end}
      </div>
      {children}
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
function DetailRow({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <>
      <dt className="flex items-center gap-2 text-xs text-zinc-400 min-h-7">
        <Icon size={14} aria-hidden="true" />
        {label}
      </dt>
      <dd className="min-w-0 flex items-center min-h-7">{children}</dd>
    </>
  );
}

export function TaskDetailPanel({ task, onClose, onEdit, onDelete, variant = 'panel' }: TaskDetailPanelProps) {
  const {
    team,
    tasks,
    reminders,
    getTeamMember,
    getProject,
    updateTask,
    toggleSubtask,
    addSubtask,
    updateSubtask,
    reorderSubtasks,
    deleteSubtask,
    addCriterion,
    toggleCriterion,
    updateCriterion,
    deleteCriterion,
    addComment,
    updateComment,
    deleteComment,
  } = useApp();
  const { teamMemberId, access } = useAuth();
  const backdropRef = useRef<HTMLDivElement>(null);
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
  const [deleteCommentTarget, setDeleteCommentTarget] = useState<string | null>(null);
  const [editingCriterionId, setEditingCriterionId] = useState<string | null>(null);
  const [editingCriterionText, setEditingCriterionText] = useState('');
  const [deleteCriterionTarget, setDeleteCriterionTarget] = useState<string | null>(null);

  const sourceEmails = useTaskSourceEmails(task?.id ?? null);

  // A half-written comment belongs to its task: switching tasks clears it.
  const [commentTaskId, setCommentTaskId] = useState(task?.id);
  if (commentTaskId !== task?.id) {
    setCommentTaskId(task?.id);
    setNewComment('');
  }

  // Escape closes the panel, which also holds the page still behind it. The
  // full page is the page: neither applies there. An Escape a field inside
  // already handled (closing an adder) is marked defaultPrevented: React
  // listens on the document too, so stopPropagation cannot keep it from here.
  useEffect(() => {
    if (variant !== 'panel') return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };

    if (task) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [task, onClose, variant]);

  if (!task) return null;
  const canEdit = canEditTask(access, task, teamMemberId);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const project = getProject(task.project_id);
  const showAiToggle =
    isAgentsEnabled && hasPermission(access, 'agents.manage') && project?.autonomous_enabled;

  const assignees = team.filter((m) => task.assignee_ids.includes(m.id));
  const completedSubtasks = task.subtasks.filter((s) => s.completed).length;
  const satisfiedCriteria = task.acceptance_criteria.filter((c) => c.satisfied).length;
  const openReminders = reminders.filter((r) => r.task_id === task.id && r.status === 'open').length;
  const blockers = (task.blocked_by_ids || [])
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t);
  const openBlockers = blockers.filter((b) => b.status !== 'done');

  const dueOverdue = !!task.due_date && isDateOverdue(task.due_date) && task.status !== 'done';
  const createdDate = new Date(task.created_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const submitComment = () => {
    if (!newComment.trim()) return;
    addComment(task.id, newComment.trim(), teamMemberId || '');
    setNewComment('');
  };

  // ── Details: one list, every row always there ──
  const details = (
    <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
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
                    updateTask(task.id, { status: opt.value });
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
        {assignees.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 py-0.5">
            {assignees.map((member) => (
              <span
                key={member.id}
                className="inline-flex items-center gap-1.5 max-w-full pl-1 pr-2.5 py-0.5 rounded-full bg-white/[0.04] border border-white/[0.06] text-xs text-zinc-200"
              >
                <Avatar name={member.name} src={member.avatar || undefined} size="xs" />
                <span className="truncate">{member.name}</span>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-zinc-500">Unassigned</span>
        )}
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
        {task.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 py-0.5">
            {task.tags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 text-xs bg-white/[0.06] text-zinc-300 rounded-full">
                {tag}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-zinc-500">None</span>
        )}
      </DetailRow>

      <DetailRow icon={Clock} label="Created">
        <span className="text-zinc-300">{createdDate}</span>
      </DetailRow>

      {/* AI ready. On = ai_ready (the dev agent may pick it up), off = no
          readiness, a person's task like most tasks. A task with no
          acceptance criteria cannot be flipped on: the dev agent refuses
          spec-less tasks, so allowing it would create a task that is claimed
          and then refused, forever. */}
      {showAiToggle && (
        <>
          <DetailRow icon={Bot} label="AI ready">
            <Toggle
              checked={task.ai_readiness === 'ai_ready'}
              onChange={() => {
                const turningOn = task.ai_readiness !== 'ai_ready';
                if (turningOn && (task.acceptance_criteria || []).length === 0) {
                  toast('error', 'Add acceptance criteria before marking this AI Ready');
                  return;
                }
                updateTask(task.id, { ai_readiness: turningOn ? 'ai_ready' : null });
              }}
              aria-label="AI ready"
            />
          </DetailRow>
          <p className="col-span-2 -mt-1 text-xs text-zinc-400">
            {task.ai_readiness === 'needs_spec'
              ? 'Needs spec: meant for the dev agent, spec not written yet.'
              : 'When on, the dev agent may pick this task up on its own.'}
          </p>
        </>
      )}
    </dl>
  );

  // ── The work: description, reminders, criteria, subtasks, comments ──
  const sections = (
    <>
      <Section
        variant={variant}
        title="Description"
        icon={AlignLeft}
        action={canEdit && task.description ? <CardAction onClick={() => onEdit(task)}>Edit</CardAction> : undefined}
      >
        {task.description ? (
          <p className="text-sm text-zinc-300 whitespace-pre-wrap break-words leading-relaxed">{task.description}</p>
        ) : canEdit ? (
          <button
            type="button"
            onClick={() => onEdit(task)}
            className="text-sm text-zinc-400 hover:text-brand-300 transition-colors rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Add a description
          </button>
        ) : (
          <p className="text-sm text-zinc-500">No description.</p>
        )}
      </Section>

      {sourceEmails && sourceEmails.link_count > 0 && (
        <Section variant={variant} title="Communication" icon={MessageSquare} count={String(sourceEmails.link_count)}>
          <TaskSourceEmailsSection data={sourceEmails} taskId={task?.id ?? null} heading={false} />
        </Section>
      )}

      <Section variant={variant} title="Reminders" icon={BellRing} count={openReminders > 0 ? `${openReminders} open` : undefined}>
        <TaskReminders task={task} />
      </Section>

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

      <Section
        variant={variant}
        title="Acceptance criteria"
        icon={ListChecks}
        count={task.acceptance_criteria.length > 0 ? `${satisfiedCriteria}/${task.acceptance_criteria.length}` : undefined}
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
      </Section>

      <Section
        variant={variant}
        title="Subtasks"
        icon={CheckSquare}
        count={task.subtasks.length > 0 ? `${completedSubtasks}/${task.subtasks.length}` : undefined}
      >
        {task.subtasks.length > 0 && (
          <div
            className="h-1 mb-2 bg-white/[0.06] rounded-full overflow-hidden"
            role="progressbar"
            aria-label="Subtasks done"
            aria-valuenow={completedSubtasks}
            aria-valuemin={0}
            aria-valuemax={task.subtasks.length}
          >
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: `${(completedSubtasks / task.subtasks.length) * 100}%` }}
            />
          </div>
        )}
        {task.subtasks.length === 0 && !canEdit && <p className="text-sm text-zinc-500">None yet.</p>}

        <ul className="space-y-0.5">
          {(dragSubtaskOrder
            ? dragSubtaskOrder
                .map((id) => task.subtasks.find((s) => s.id === id))
                .filter((s): s is NonNullable<typeof s> => !!s)
            : task.subtasks
          ).map((subtask) => (
            <li
              key={subtask.id}
              draggable={canEdit && editingSubtaskId !== subtask.id}
              onDragStart={() => {
                if (!canEdit) return;
                setDraggedSubtaskId(subtask.id);
                setDragSubtaskOrder(task.subtasks.map((s) => s.id));
              }}
              onDragEnd={() => {
                // Persist the final order once, only if it changed
                if (dragSubtaskOrder) {
                  const original = task.subtasks.map((s) => s.id);
                  if (dragSubtaskOrder.join() !== original.join()) {
                    reorderSubtasks(task.id, dragSubtaskOrder);
                  }
                }
                setDraggedSubtaskId(null);
                setDragSubtaskOrder(null);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                if (draggedSubtaskId && draggedSubtaskId !== subtask.id) {
                  setDragSubtaskOrder((order) => {
                    const ids = [...(order ?? task.subtasks.map((s) => s.id))];
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
                onClick={() => toggleSubtask(task.id, subtask.id)}
                disabled={!canEdit}
                aria-label={subtask.completed ? `Mark "${subtask.title}" not done` : `Mark "${subtask.title}" done`}
                aria-pressed={subtask.completed}
                className={`flex-shrink-0 w-[18px] h-[18px] rounded border-2 flex items-center justify-center transition-colors disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-raised ${
                  subtask.completed ? 'bg-emerald-500 border-emerald-500' : 'border-white/[0.16] enabled:hover:border-emerald-400'
                }`}
              >
                {subtask.completed && <Check size={12} strokeWidth={3} className="text-white" aria-hidden="true" />}
              </button>
              {editingSubtaskId === subtask.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (editingSubtaskTitle.trim()) {
                      updateSubtask(task.id, subtask.id, editingSubtaskTitle.trim());
                    }
                    setEditingSubtaskId(null);
                  }}
                  className="flex-1"
                >
                  <TextInput
                    value={editingSubtaskTitle}
                    onChange={setEditingSubtaskTitle}
                    onBlur={() => {
                      if (editingSubtaskTitle.trim()) {
                        updateSubtask(task.id, subtask.id, editingSubtaskTitle.trim());
                      }
                      setEditingSubtaskId(null);
                    }}
                    aria-label="Edit subtask"
                    autoFocus
                    size="sm"
                  />
                </form>
              ) : (
                <span
                  className={`flex-1 min-w-0 text-sm break-words ${subtask.completed ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}
                  onDoubleClick={() => {
                    if (!canEdit) return;
                    setEditingSubtaskId(subtask.id);
                    setEditingSubtaskTitle(subtask.title);
                  }}
                >
                  {subtask.title}
                </span>
              )}
              {canEdit && editingSubtaskId !== subtask.id && (
                <div className={ROW_ACTIONS}>
                  <Tooltip content="Edit">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSubtaskId(subtask.id);
                        setEditingSubtaskTitle(subtask.title);
                      }}
                      aria-label={`Edit "${subtask.title}"`}
                      className={`${ROW_ICON_BUTTON} hover:text-brand-300`}
                    >
                      <Edit size={13} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Delete">
                    <button
                      type="button"
                      onClick={() => setDeleteSubtaskTarget(subtask.id)}
                      aria-label={`Delete "${subtask.title}"`}
                      className={`${ROW_ICON_BUTTON} hover:text-red-400`}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </Tooltip>
                  <GripVertical size={14} aria-hidden="true" className="text-zinc-600 flex-shrink-0 cursor-grab active:cursor-grabbing" />
                </div>
              )}
            </li>
          ))}
        </ul>
        {canEdit && <InlineAdd label="Add subtask" placeholder="Subtask title" onAdd={(text) => addSubtask(task.id, text)} />}
      </Section>

      <Section variant={variant} title="Comments" icon={MessageSquare} count={task.comments.length > 0 ? task.comments.length : undefined}>
        {task.comments.length === 0 ? (
          <p className="text-sm text-zinc-500 mb-3">No comments yet.</p>
        ) : (
          <ul className="space-y-4 mb-4">
            {task.comments.map((comment) => {
              const author = getTeamMember(comment.user_id);
              const isOwn = comment.user_id === teamMemberId;
              return (
                <li key={comment.id} className="flex gap-3 group">
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
    </>
  );

  const dialogs = (
    <>
      <ConfirmDialog
        isOpen={!!deleteSubtaskTarget}
        onClose={() => setDeleteSubtaskTarget(null)}
        onConfirm={async () => {
          if (deleteSubtaskTarget && await deleteSubtask(task.id, deleteSubtaskTarget)) toast('success', 'Subtask moved to Trash');
        }}
        title="Move subtask to Trash?"
        message="The subtask goes to Trash."
        variant="danger"
        trash
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

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-black/40 animate-fadeIn"
        onClick={(e) => e.target === backdropRef.current && onClose()}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`task-title-${task.id}`}
        className="relative w-full sm:w-[480px] bg-surface-raised shadow-2xl flex flex-col animate-slideIn overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3 flex-shrink-0">
          <h2 id={`task-title-${task.id}`} className="flex-1 min-w-0 pt-0.5 text-base font-semibold text-white leading-snug break-words">
            {task.title}
          </h2>
          <div className="flex items-center gap-1 flex-shrink-0">
            <TaskActionsMenu task={task} onEdit={onEdit} onDelete={onDelete} showOpenAsPage />
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

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 pb-5">{details}</div>
          {sections}
        </div>
      </div>

      {dialogs}

      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        @keyframes slideIn {
          from {
            transform: translateX(100%);
          }
          to {
            transform: translateX(0);
          }
        }
        .animate-fadeIn {
          animation: fadeIn 0.2s ease-out;
        }
        .animate-slideIn {
          animation: slideIn 0.25s ease-out;
        }
      `}</style>
    </div>
  );
}
