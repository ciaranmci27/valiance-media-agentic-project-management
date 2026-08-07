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

/**
 * The ONE column template the list header and every row share. The old
 * layout was two hand-maintained flex stacks whose widths drifted until the
 * row grew an Updated column the header never heard about, shifting every
 * label after Comments onto the wrong data. A shared grid makes that class
 * of bug impossible: hidden-below-xl cells (Tags, Updated) drop out of the
 * grid flow on both sides at once, so alignment holds at every breakpoint.
 *
 * Columns: select | title | assignees | priority | updated(xl) | due |
 * menu. Status is conveyed by the list's group headers. Tags, counts, and
 * state chips render inline after the title only when they exist: a
 * dedicated column for any of them sat empty on most rows and left its
 * header floating over dead space.
 */
export const LIST_GRID_COLS =
  'items-center gap-x-4 px-4 grid-cols-[16px_minmax(0,1fr)_80px_88px_92px_32px] xl:grid-cols-[16px_minmax(0,1fr)_80px_88px_84px_92px_32px]';

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

  // Mobile card view. The list container draws the dividers, so the card
  // itself has no border: a border here doubled up into a heavy double rule.
  return (
    <div
      className="lg:hidden p-3 hover:bg-white/[0.03] transition-colors cursor-pointer"
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
              aria-label="Task actions"
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

          {/* Meta info row; assignees lead it rather than sitting on a
              lonely row of their own below. */}
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {assignees.length > 0 && (
              <AvatarGroup users={assignees} max={3} size="xs" />
            )}
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

/* Desktop table row view. Every cell below maps 1:1, in order, onto
   LIST_GRID_COLS; add or remove a column there and here together. */
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
  const isBlocked = task.status !== 'done' && (task.blocked_by_ids || []).some(id => tasks.find(t => t.id === id)?.status !== 'done');
  const showReadinessChip = isAgentsEnabled && canManageAgents && task.ai_readiness !== 'ai_ready' && getProject(task.project_id)?.autonomous_enabled;

  // The row surface toggles SELECTION (the checkbox is a small target and
  // selection is the bulk-action gesture); the title alone opens the task.
  // Rows without selection keep click-to-open everywhere.
  const handleRowClick = () => {
    if (onToggleSelect) onToggleSelect(task.id);
    else onView?.(task);
  };

  return (
    <div
      className={`hidden lg:grid ${LIST_GRID_COLS} py-2.5 bg-surface-raised hover:bg-white/[0.03] transition-colors group cursor-pointer ${selected ? 'bg-brand-500/[0.06]' : ''}`}
      onClick={handleRowClick}
    >
      {/* Select */}
      <div className="flex items-center">
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={selected || false}
            onChange={(e) => { e.stopPropagation(); onToggleSelect(task.id); }}
            onClick={(e) => e.stopPropagation()}
            className="w-4 h-4 rounded border-white/[0.12] text-brand-300 outline-none focus:ring-brand-500 cursor-pointer"
            aria-label={`Select ${task.title}`}
          />
        )}
      </div>

      {/* Title, one line, with meta that only appears when it exists. The
          description belongs to the detail panel: in a scanning view it was
          a wall of prose that drowned the titles. */}
      <div className="min-w-0 flex items-center gap-2">
        <h3 className="min-w-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onView?.(task); }}
            className="block max-w-full truncate font-medium text-white text-sm text-left hover:text-brand-300 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 rounded"
          >
            {task.title}
          </button>
        </h3>
        {isBlocked && (
          <Tooltip content="Blocked by another task">
            <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full flex-shrink-0">
              <Lock size={10} />
            </span>
          </Tooltip>
        )}
        {showReadinessChip && (
          task.ai_readiness ? (
            <Tooltip content="Manual task (not AI Ready)">
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full flex-shrink-0">
                <User size={10} aria-hidden="true" />
              </span>
            </Tooltip>
          ) : (
            <Tooltip content="Needs a spec before anyone can start it">
              <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30 rounded-full flex-shrink-0">
                <FileQuestion size={10} aria-hidden="true" />
              </span>
            </Tooltip>
          )
        )}
        {task.subtasks.length > 0 && (
          <Tooltip content={`${completedSubtasks} of ${task.subtasks.length} subtasks complete`}>
            <span className="flex items-center gap-1 text-xs text-zinc-500 flex-shrink-0 cursor-default">
              <CheckSquare size={12} />
              {completedSubtasks}/{task.subtasks.length}
            </span>
          </Tooltip>
        )}
        {task.comments.length > 0 && (
          <Tooltip content={`${task.comments.length} comment${task.comments.length === 1 ? '' : 's'}`}>
            <span className="flex items-center gap-1 text-xs text-zinc-500 flex-shrink-0 cursor-default">
              <MessageSquare size={12} />
              {task.comments.length}
            </span>
          </Tooltip>
        )}
        {task.tags.slice(0, 2).map(tag => (
          <span
            key={tag}
            className="px-1.5 py-0.5 text-[10px] bg-white/[0.06] text-zinc-400 rounded flex-shrink-0 truncate max-w-[80px]"
          >
            {tag}
          </span>
        ))}
        {task.tags.length > 2 && (
          <Tooltip content={task.tags.slice(2).join(', ')}>
            <span className="text-[10px] text-zinc-500 flex-shrink-0 cursor-default">+{task.tags.length - 2}</span>
          </Tooltip>
        )}
      </div>

      {/* Assignees */}
      <div className="flex">
        {assignees.length > 0 && (
          <Tooltip content={`Assigned to ${assignees.map(a => a.name).join(', ')}`}>
            <AvatarGroup users={assignees} max={2} size="xs" />
          </Tooltip>
        )}
      </div>

      {/* Priority */}
      <div className="overflow-hidden">
        <PriorityBadge priority={task.priority} />
      </div>

      {/* Updated (xl only) */}
      <div className="hidden xl:block">
        <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
          <span className="text-xs text-zinc-500">
            {timeAgo(task.updated_at)}
          </span>
        </Tooltip>
      </div>

      {/* Due Date */}
      <div>
        {dueInfo && (
          <div className={`flex items-center gap-1 text-xs ${dueInfo.isOverdue ? 'text-red-400 font-medium' : 'text-zinc-400'}`}>
            <Calendar size={12} />
            <span>{dueInfo.text}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="relative">
        {(canEdit || canDelete) && <>
          <button
            ref={menuBtnRef}
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="p-1.5 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all"
            aria-label="Task actions"
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
        </>}
      </div>
    </div>
  );
}
