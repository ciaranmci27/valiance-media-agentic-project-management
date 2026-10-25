'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { PriorityBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, Mail, MessageSquare, CheckSquare, Paperclip, Trash2, Clock, Lock, FileQuestion, ArrowRight, ClipboardCopy, Link2, Hash, PanelRight, BellRing } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission, canEditTask, canManageAllTasks } from '@/lib/access-control';
import { TASK_STATUS_LABELS, taskAsText, taskUrl, copyText } from '@/lib/task-copy';
import { nextReminderFor, reminderGroup, whenLabel } from '@/lib/reminders';
import { useTaskEmailCount } from '@/components/inbox/TaskSourceEmails';
import { useTaskFileCount } from './task-file-counts';
import { useTaskWarmer } from '@/lib/reads';
import { UnreadLabel } from './TaskUnread';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMins = Math.floor((now - then) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const hours = Math.floor(diffMins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface TaskCardProps {
  task: Task;
  onView?: (task: Task) => void;
  onDelete?: (id: string) => void;
  /** Move to another column without dragging: the keyboard and touch path. */
  onMove?: (taskId: string, status: Task['status']) => void;
}

const MOVE_ORDER: Task['status'][] = ['todo', 'in_progress', 'in_review', 'done'];

export function TaskCard({ task, onView, onDelete, onMove }: TaskCardProps) {
  const { team, tasks, getProject, reminders } = useApp();
  const { teamMemberId, access } = useAuth();

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const canEdit = canEditTask(access, task, teamMemberId);
  const canDelete = canManageAllTasks(access);
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;
  const hasComments = task.comments.length > 0;
  const { taskUnread } = useApp();
  const loudPriority = task.priority === 'high' || task.priority === 'urgent';
  const needsSpec = isAgentsEnabled && canManageAgents && task.ai_readiness === 'needs_spec' && !!getProject(task.project_id)?.autonomous_enabled;
  const isBlocked = task.status !== 'done' && (task.blocked_by_ids || []).some(id => tasks.find(t => t.id === id)?.status !== 'done');
  const unread = !!taskUnread(task);
  const hasBadges = unread || loudPriority || needsSpec || isBlocked;
  const emailCount = useTaskEmailCount(task.id);
  const fileCount = useTaskFileCount(task.id);
  const warmTask = useTaskWarmer();

  const formatDate = (date: string | null) => {
    if (!date) return null;
    const d = parseDateOnly(date);
    const isOverdue = isDateOverdue(date) && task.status !== 'done';
    return {
      text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      isOverdue
    };
  };

  const dueInfo = formatDate(task.due_date);
  // The step the task is waiting on. A done task's reminders close with it.
  const next = task.status !== 'done' ? nextReminderFor(reminders, task.id) : null;
  const nextGroup = next ? reminderGroup(next.next) : null;
  const nextWhen = next ? whenLabel(next.next) : null;

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

  return (
    // A div with a button role, not a <button>: the card holds its own menu
    // button, and a native button cannot start an HTML5 drag in Firefox.
    <div
      role="button"
      tabIndex={0}
      className={`relative glass-card ${unread ? 'is-unread' : ''} rounded-lg p-3 lg:p-4 hover:shadow-md hover:border-white/[0.12] transition-[box-shadow,border-color] duration-150 group cursor-pointer focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400`}
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
          missing spec, a blocker. Low and medium priority and the task type
          live in the panel. */}
      {hasBadges && (
        <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap mb-2 lg:mb-3 pr-7">
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
          {isBlocked && (
            <Tooltip content="Waiting on another task to finish first">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] lg:text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
                <Lock size={10} />
                Blocked
              </span>
            </Tooltip>
          )}
        </div>
      )}

      <h3 className={`font-medium text-white text-sm lg:text-base mb-1 lg:mb-2 line-clamp-2 ${hasBadges ? '' : 'pr-7'}`}>
        {task.title}
      </h3>
      
      {task.description && (
        <p className="text-xs lg:text-sm text-zinc-400 mb-2 lg:mb-3 line-clamp-2">{task.description}</p>
      )}

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2 lg:mb-3">
          {task.tags.slice(0, 3).map((tag) => (
            <span 
              key={tag} 
              className="px-1.5 py-0.5 text-[10px] lg:text-xs bg-white/[0.06] text-zinc-300 rounded-full"
            >
              {tag}
            </span>
          ))}
          {task.tags.length > 3 && (
            <span className="text-[10px] text-zinc-500">+{task.tags.length - 3}</span>
          )}
        </div>
      )}

      {/* Next step: the reminder this task is waiting on */}
      {next && (
        <div className="flex items-start gap-1.5 mb-2 lg:mb-3 px-2 py-1.5 rounded-md bg-white/[0.04] text-xs">
          <BellRing size={12} className={`mt-0.5 flex-shrink-0 ${nextGroup === 'overdue' ? 'text-red-400' : 'text-brand-300'}`} aria-hidden="true" />
          <p className="min-w-0 flex-1 text-zinc-300">
            <span className="sr-only">Next step: </span>
            <span className="line-clamp-2 break-words">{next.next.title}</span>
            {(nextWhen || next.open > 1) && (
              <span className={`block mt-0.5 ${nextGroup === 'overdue' ? 'text-red-400' : 'text-zinc-500'}`}>
                {nextGroup === 'overdue' && nextWhen ? `Overdue: ${nextWhen}` : nextWhen}
                {next.open > 1 && `${nextWhen ? ' | ' : ''}+${next.open - 1} more`}
              </span>
            )}
          </p>
        </div>
      )}

      {/* Subtasks progress */}
      {task.subtasks.length > 0 && (
        <Tooltip content={`${completedSubtasks} of ${task.subtasks.length} subtasks complete`} className="w-full">
        <div className="flex w-full items-center gap-2 text-xs text-zinc-400 mb-2 lg:mb-3">
          <CheckSquare size={14} />
          <span>{completedSubtasks}/{task.subtasks.length}</span>
          <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
            <div 
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${(completedSubtasks / task.subtasks.length) * 100}%` }}
            />
          </div>
        </div>
        </Tooltip>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 lg:pt-3 border-t border-white/[0.06]">
        <div className="flex items-center gap-2 lg:gap-3">
          {dueInfo && (
            <Tooltip content={dueInfo.isOverdue ? `Overdue: was due ${dueInfo.text}` : `Due ${dueInfo.text}`}>
              <div className={`flex items-center gap-1 text-xs ${dueInfo.isOverdue ? 'text-red-400 font-medium' : 'text-zinc-400'}`}>
                <Calendar size={14} />
                <span>{dueInfo.text}</span>
              </div>
            </Tooltip>
          )}
          {hasComments && (
            <Tooltip content={`${task.comments.length} comment${task.comments.length === 1 ? '' : 's'}`}>
              <div className="flex items-center gap-1 text-xs text-zinc-400">
                <MessageSquare size={14} />
                <span>{task.comments.length}</span>
              </div>
            </Tooltip>
          )}
          {emailCount > 0 && (
            <Tooltip content={`${emailCount} linked email${emailCount === 1 ? '' : 's'}`}>
              <div className="flex items-center gap-1 text-xs text-zinc-400">
                <Mail size={14} aria-hidden="true" />
                <span className="sr-only">{emailCount} linked email{emailCount === 1 ? '' : 's'}</span>
                <span aria-hidden="true">{emailCount}</span>
              </div>
            </Tooltip>
          )}
          {fileCount > 0 && (
            <Tooltip content={`${fileCount} file${fileCount === 1 ? '' : 's'}`}>
              <div className="flex items-center gap-1 text-xs text-zinc-400">
                <Paperclip size={14} aria-hidden="true" />
                <span className="sr-only">{fileCount} file{fileCount === 1 ? '' : 's'}</span>
                <span aria-hidden="true">{fileCount}</span>
              </div>
            </Tooltip>
          )}
          <Tooltip content={`Created ${new Date(task.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} · updated ${new Date(task.updated_at).toLocaleString()}`}>
            <div className="flex items-center gap-1 text-xs text-zinc-500">
              <Clock size={12} />
              <span>{timeAgo(task.updated_at)}</span>
            </div>
          </Tooltip>
        </div>
        
        {assignees.length > 0 && (
          <Tooltip content={`Assigned to ${assignees.map(a => a.name).join(', ')}`}>
            <AvatarGroup users={assignees} max={3} size="xs" />
          </Tooltip>
        )}
      </div>
    </div>
  );
}
