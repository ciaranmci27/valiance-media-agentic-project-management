'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { StatusBadge, PriorityBadge, TaskTypeBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, CheckSquare, MessageSquare, MoreVertical, Edit, Trash2, Clock, User, Lock, FileQuestion } from 'lucide-react';
import { useState, useRef } from 'react';
import { Popover } from '@/components/ui/Popover';
import { Tooltip } from '@/components/ui/Tooltip';
import { parseDateOnly, isDateOverdue } from '@/lib/date-utils';
import { hasPermission } from '@/lib/access-control';

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

interface TaskRowProps {
  task: Task;
  onView?: (task: Task) => void;
  onEdit?: (task: Task) => void;
  onDelete?: (id: string) => void;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

export function TaskRow({ task, onView, onEdit, onDelete }: TaskRowProps) {
  const { team, tasks, getProject } = useApp();
  const { teamMemberId, access } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const canEdit = hasPermission(access, 'tasks.manage_all') || (hasPermission(access, 'tasks.manage_assigned') && task.assignee_ids.includes(teamMemberId || ''));
  const canDelete = hasPermission(access, 'tasks.manage_all');

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
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;

  // Mobile card view
  return (
    <div
      className="lg:hidden p-3 lg:p-0 border-b border-white/[0.06] hover:bg-white/[0.03] transition-colors cursor-pointer"
      onClick={() => onView?.(task)}
    >
      <div className="flex items-start gap-3">
        {/* Status indicator */}
        <div className="pt-1">
          <div className={`w-2.5 h-2.5 rounded-full ${
            task.status === 'done' ? 'bg-emerald-500' :
            task.status === 'in_progress' ? 'bg-brand-500' :
            task.status === 'in_review' ? 'bg-amber-500' :
            'bg-zinc-300'
          }`} />
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <h3 className="font-medium text-white text-sm leading-tight">{task.title}</h3>
            {(canEdit || canDelete) && <button
              ref={menuBtnRef}
              onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
              className="p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] flex-shrink-0"
            >
              <MoreVertical size={16} />
            </button>}
          </div>

          {task.description && (
            <p className="text-xs text-zinc-400 mt-1 line-clamp-1">{task.description}</p>
          )}

          {/* Tags */}
          {task.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {task.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-[10px] bg-white/[0.06] text-zinc-300 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Meta info row */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <PriorityBadge priority={task.priority} />
            <StatusBadge status={task.status} />
            {isAgentsEnabled && canManageAgents && task.task_type && (
              <TaskTypeBadge taskType={task.task_type} />
            )}
            {isAgentsEnabled && canManageAgents && task.ai_readiness !== 'ai_ready' && getProject(task.project_id)?.autonomous_enabled && (
              task.ai_readiness ? (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
                  <User size={10} aria-hidden="true" />
                  Manual
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-full">
                  <FileQuestion size={10} aria-hidden="true" />
                  Needs spec
                </span>
              )
            )}
            {task.status !== 'done' && (task.blocked_by_ids || []).some(id => tasks.find(t => t.id === id)?.status !== 'done') && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
                <Lock size={10} />
                Blocked
              </span>
            )}

            {dueInfo && (
              <span className={`text-xs ${dueInfo.isOverdue ? 'text-red-400 font-medium' : 'text-zinc-400'}`}>
                {dueInfo.text}
              </span>
            )}

            {task.subtasks.length > 0 && (
              <span className="text-xs text-zinc-400 flex items-center gap-1">
                <CheckSquare size={12} />
                {completedSubtasks}/{task.subtasks.length}
              </span>
            )}

            {task.comments.length > 0 && (
              <span className="text-xs text-zinc-400 flex items-center gap-1">
                <MessageSquare size={12} />
                {task.comments.length}
              </span>
            )}

            <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
              <span className="text-xs text-zinc-500 flex items-center gap-1">
                <Clock size={12} />
                {timeAgo(task.updated_at)}
              </span>
            </Tooltip>
          </div>

          {/* Assignees */}
          {assignees.length > 0 && (
            <div className="mt-2">
              <AvatarGroup users={assignees} max={3} size="xs" />
            </div>
          )}
        </div>
      </div>

      {/* Actions menu */}
      {(canEdit || canDelete) && (
        <Popover
          anchorRef={menuBtnRef}
          open={showMenu}
          onClose={() => setShowMenu(false)}
          align="end"
          width={120}
          className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1"
        >
          {canEdit && <button
            onClick={(e) => { e.stopPropagation(); onEdit?.(task); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06]"
          >
            <Edit size={14} />
            Edit
          </button>}
          {canDelete && <button
            onClick={(e) => { e.stopPropagation(); onDelete?.(task.id); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/15"
          >
            <Trash2 size={14} />
            Delete
          </button>}
        </Popover>
      )}
    </div>
  );
}

/* Desktop table row view */
export function TaskRowDesktop({ task, onView, onEdit, onDelete, selected, onToggleSelect }: TaskRowProps) {
  const { team, tasks, getProject } = useApp();
  const { teamMemberId, access } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const canEdit = hasPermission(access, 'tasks.manage_all') || (hasPermission(access, 'tasks.manage_assigned') && task.assignee_ids.includes(teamMemberId || ''));
  const canDelete = hasPermission(access, 'tasks.manage_all');

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
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;

  return (
    <div
      className="hidden lg:flex items-center gap-4 px-4 py-3 bg-surface-raised border-b border-white/[0.06] hover:bg-white/[0.03] transition-colors group cursor-pointer"
      onClick={() => onView?.(task)}
    >
      {/* Selection checkbox */}
      {onToggleSelect && (
        <div className="w-5 flex items-center">
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(task.id); }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-white/[0.12] text-brand-300 outline-none focus:ring-brand-500 cursor-pointer"
          />
        </div>
      )}

      {/* Status */}
      <div className="w-3">
        <div className={`w-2.5 h-2.5 rounded-full ${
          task.status === 'done' ? 'bg-emerald-500' :
          task.status === 'in_progress' ? 'bg-brand-500' :
          task.status === 'in_review' ? 'bg-amber-500' :
          'bg-zinc-300'
        }`} />
      </div>

      {/* Title */}
      <div className="flex-1 min-w-0">
        <h3 className="font-medium text-white truncate">{task.title}</h3>
        {task.description && (
          <p className="text-sm text-zinc-400 truncate">{task.description}</p>
        )}
      </div>

      {/* Tags */}
      <div className="flex gap-1 w-32">
        {task.tags.slice(0, 2).map((tag) => (
          <span 
            key={tag} 
            className="px-1.5 py-0.5 text-[10px] bg-white/[0.06] text-zinc-300 rounded"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* Priority */}
      <div className="w-20 flex items-center gap-1">
        <PriorityBadge priority={task.priority} />
        {isAgentsEnabled && canManageAgents && task.task_type && (
          <TaskTypeBadge taskType={task.task_type} />
        )}
        {isAgentsEnabled && canManageAgents && task.ai_readiness !== 'ai_ready' && getProject(task.project_id)?.autonomous_enabled && (
          task.ai_readiness ? (
            <Tooltip content="Manual task (not AI Ready)">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
                <User size={10} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : (
            <Tooltip content="Needs a spec before anyone can start it">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-full">
                <FileQuestion size={10} aria-hidden="true" />
              </span>
            </Tooltip>
          )
        )}
        {task.status !== 'done' && (task.blocked_by_ids || []).some(id => tasks.find(t => t.id === id)?.status !== 'done') && (
          <Tooltip content="Blocked by another task">
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
              <Lock size={10} />
            </span>
          </Tooltip>
        )}
      </div>

      {/* Due Date */}
      <div className="w-24">
        {dueInfo && (
          <div className={`flex items-center gap-1 text-xs ${dueInfo.isOverdue ? 'text-red-400 font-medium' : 'text-zinc-400'}`}>
            <Calendar size={12} />
            <span>{dueInfo.text}</span>
          </div>
        )}
      </div>

      {/* Subtasks */}
      <div className="w-20 text-center">
        {task.subtasks.length > 0 && (
          <div className="flex items-center justify-center gap-1 text-xs text-zinc-400">
            <CheckSquare size={12} />
            <span>{completedSubtasks}/{task.subtasks.length}</span>
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="w-16 text-center">
        {task.comments.length > 0 && (
          <div className="flex items-center justify-center gap-1 text-xs text-zinc-400">
            <MessageSquare size={12} />
            <span>{task.comments.length}</span>
          </div>
        )}
      </div>

      {/* Updated */}
      <div className="w-20 text-center">
        <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
          <span className="text-xs text-zinc-500">
            {timeAgo(task.updated_at)}
          </span>
        </Tooltip>
      </div>

      {/* Assignees */}
      <div className="w-24 flex justify-center">
        {assignees.length > 0 && (
          <AvatarGroup users={assignees} max={2} size="xs" />
        )}
      </div>

      {/* Actions */}
      {(canEdit || canDelete) && <div className="relative">
        <button
          ref={menuBtnRef}
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100 transition-all"
        >
          <MoreVertical size={16} />
        </button>

        <Popover
          anchorRef={menuBtnRef}
          open={showMenu}
          onClose={() => setShowMenu(false)}
          align="end"
          width={120}
          className="bg-surface-raised rounded-lg shadow-xl border border-white/[0.08] py-1"
        >
          {canEdit && <button
            onClick={(e) => { e.stopPropagation(); onEdit?.(task); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 hover:bg-white/[0.06]"
          >
            <Edit size={14} />
            Edit
          </button>}
          {canDelete && <button
            onClick={(e) => { e.stopPropagation(); onDelete?.(task.id); setShowMenu(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/15"
          >
            <Trash2 size={14} />
            Delete
          </button>}
        </Popover>
      </div>}
    </div>
  );
}
