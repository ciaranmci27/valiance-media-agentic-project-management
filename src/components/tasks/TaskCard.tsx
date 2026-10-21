'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { PriorityBadge, TaskTypeBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, MessageSquare, CheckSquare, Edit, Trash2, Clock, Lock, FileQuestion, ArrowRight, ClipboardCopy, Link2, Hash, PanelRight } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { RowActionsMenu, type RowAction } from '@/components/ui/RowActionsMenu';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission, canEditTask, canManageAllTasks } from '@/lib/access-control';
import { TASK_STATUS_LABELS, taskAsText, taskUrl, copyText } from '@/lib/task-copy';

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
  onEdit?: (task: Task) => void;
  onDelete?: (id: string) => void;
  /** Move to another column without dragging: the keyboard and touch path. */
  onMove?: (taskId: string, status: Task['status']) => void;
}

const MOVE_ORDER: Task['status'][] = ['todo', 'in_progress', 'in_review', 'done'];

export function TaskCard({ task, onView, onEdit, onDelete, onMove }: TaskCardProps) {
  const { team, tasks, getProject } = useApp();
  const { teamMemberId, access } = useAuth();

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const canEdit = canEditTask(access, task, teamMemberId);
  const canDelete = canManageAllTasks(access);
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;
  const hasComments = task.comments.length > 0;

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

  const actions: RowAction[] = [
    ...(onView ? [{ label: 'Open', icon: <PanelRight size={14} />, onClick: () => onView(task) }] : []),
    ...(canEdit && onEdit ? [{ label: 'Edit', icon: <Edit size={14} />, onClick: () => onEdit(task) }] : []),
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
      ? [{ label: 'Delete', icon: <Trash2 size={14} />, onClick: () => onDelete(task.id), variant: 'danger' as const, divider: true }]
      : []),
  ];

  return (
    // A div with a button role, not a <button>: the card holds its own menu
    // button, and a native button cannot start an HTML5 drag in Firefox.
    <div
      role="button"
      tabIndex={0}
      className="glass-card rounded-lg p-3 lg:p-4 hover:shadow-md hover:border-white/[0.12] transition-[box-shadow,border-color] duration-150 group cursor-pointer focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
      onClick={() => onView?.(task)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        onView?.(task);
      }}
    >
      <div className="flex items-start justify-between mb-2 lg:mb-3">
        <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap">
          <PriorityBadge priority={task.priority} />
          {isAgentsEnabled && canManageAgents && task.task_type && (
            <TaskTypeBadge taskType={task.task_type} />
          )}
          {/* Most tasks are a person's and carry no label. Only a task marked
              for the dev agent whose spec is not written yet is flagged. */}
          {isAgentsEnabled && canManageAgents && task.ai_readiness === 'needs_spec' && getProject(task.project_id)?.autonomous_enabled && (
            <Tooltip content="Meant for the dev agent; needs a spec before it can start">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] lg:text-xs font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-full">
                <FileQuestion size={10} aria-hidden="true" />
                Needs spec
              </span>
            </Tooltip>
          )}
          {task.status !== 'done' && (task.blocked_by_ids || []).some(id => tasks.find(t => t.id === id)?.status !== 'done') && (
            <Tooltip content="Waiting on another task to finish first">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] lg:text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
                <Lock size={10} />
                Blocked
              </span>
            </Tooltip>
          )}
        </div>
        
        {/* Shown on hover, and whenever focus is inside the card, so the
            keyboard reaches it too. */}
        <RowActionsMenu
          actions={actions}
          label={`Actions for ${task.title}`}
          triggerClassName="-mr-1 -mt-1 flex-shrink-0 lg:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100"
        />
      </div>

      <h3 className="font-medium text-white text-sm lg:text-base mb-1 lg:mb-2 line-clamp-2">{task.title}</h3>
      
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
          <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
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
