'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { StatusBadge, PriorityBadge, TaskTypeBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, CheckSquare, MessageSquare, MoreVertical, Edit, Trash2, Clock } from 'lucide-react';
import { useState } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';

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
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const currentMember = team.find(m => m.id === teamMemberId);
  const isAdmin = currentMember?.role === 'admin';

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));

  const formatDate = (date: string | null) => {
    if (!date) return null;
    const d = new Date(date);
    const today = new Date();
    const isOverdue = d < today && task.status !== 'done';
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
      className="lg:hidden p-3 lg:p-0 border-b border-zinc-100 hover:bg-zinc-50 transition-colors cursor-pointer"
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
            <h3 className="font-medium text-zinc-900 text-sm leading-tight">{task.title}</h3>
            <button
              onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
              className="p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 flex-shrink-0"
            >
              <MoreVertical size={16} />
            </button>
          </div>

          {task.description && (
            <p className="text-xs text-zinc-500 mt-1 line-clamp-1">{task.description}</p>
          )}

          {/* Tags */}
          {task.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {task.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="px-1.5 py-0.5 text-[10px] bg-zinc-100 text-zinc-600 rounded"
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
            {isAgentsEnabled && isAdmin && task.task_type && (
              <TaskTypeBadge taskType={task.task_type} />
            )}
            
            {dueInfo && (
              <span className={`text-xs ${dueInfo.isOverdue ? 'text-red-600 font-medium' : 'text-zinc-500'}`}>
                {dueInfo.text}
              </span>
            )}

            {task.subtasks.length > 0 && (
              <span className="text-xs text-zinc-500 flex items-center gap-1">
                <CheckSquare size={12} />
                {completedSubtasks}/{task.subtasks.length}
              </span>
            )}

            {task.comments.length > 0 && (
              <span className="text-xs text-zinc-500 flex items-center gap-1">
                <MessageSquare size={12} />
                {task.comments.length}
              </span>
            )}

            <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
              <span className="text-xs text-zinc-400 flex items-center gap-1">
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
      {showMenu && (
        <>
          <div className="fixed inset-0 z-10 cursor-default" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
          <div className="absolute right-4 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[120px] cursor-pointer">
            <button
              onClick={(e) => { e.stopPropagation(); onEdit?.(task); setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              <Edit size={14} />
              Edit
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete?.(task.id); setShowMenu(false); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* Desktop table row view */
export function TaskRowDesktop({ task, onView, onEdit, onDelete, selected, onToggleSelect }: TaskRowProps) {
  const { team } = useApp();
  const { teamMemberId } = useAuth();
  const [showMenu, setShowMenu] = useState(false);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const currentMember = team.find(m => m.id === teamMemberId);
  const isAdmin = currentMember?.role === 'admin';

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));

  const formatDate = (date: string | null) => {
    if (!date) return null;
    const d = new Date(date);
    const today = new Date();
    const isOverdue = d < today && task.status !== 'done';
    return {
      text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      isOverdue
    };
  };

  const dueInfo = formatDate(task.due_date);
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;

  return (
    <div
      className="hidden lg:flex items-center gap-4 px-4 py-3 bg-white border-b border-zinc-100 hover:bg-zinc-50 transition-colors group cursor-pointer"
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
            className="w-4 h-4 rounded border-zinc-300 text-brand-600 outline-none focus:ring-brand-500 cursor-pointer"
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
        <h3 className="font-medium text-zinc-900 truncate">{task.title}</h3>
        {task.description && (
          <p className="text-sm text-zinc-500 truncate">{task.description}</p>
        )}
      </div>

      {/* Tags */}
      <div className="flex gap-1 w-32">
        {task.tags.slice(0, 2).map((tag) => (
          <span 
            key={tag} 
            className="px-1.5 py-0.5 text-[10px] bg-zinc-100 text-zinc-600 rounded"
          >
            {tag}
          </span>
        ))}
      </div>

      {/* Priority */}
      <div className="w-20 flex items-center gap-1">
        <PriorityBadge priority={task.priority} />
        {isAgentsEnabled && isAdmin && task.task_type && (
          <TaskTypeBadge taskType={task.task_type} />
        )}
      </div>

      {/* Due Date */}
      <div className="w-24">
        {dueInfo && (
          <div className={`flex items-center gap-1 text-xs ${dueInfo.isOverdue ? 'text-red-600 font-medium' : 'text-zinc-500'}`}>
            <Calendar size={12} />
            <span>{dueInfo.text}</span>
          </div>
        )}
      </div>

      {/* Subtasks */}
      <div className="w-20 text-center">
        {task.subtasks.length > 0 && (
          <div className="flex items-center justify-center gap-1 text-xs text-zinc-500">
            <CheckSquare size={12} />
            <span>{completedSubtasks}/{task.subtasks.length}</span>
          </div>
        )}
      </div>

      {/* Comments */}
      <div className="w-16 text-center">
        {task.comments.length > 0 && (
          <div className="flex items-center justify-center gap-1 text-xs text-zinc-500">
            <MessageSquare size={12} />
            <span>{task.comments.length}</span>
          </div>
        )}
      </div>

      {/* Updated */}
      <div className="w-20 text-center">
        <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
          <span className="text-xs text-zinc-400">
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
      <div className="relative">
        <button
          onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 opacity-0 group-hover:opacity-100 transition-all"
        >
          <MoreVertical size={16} />
        </button>
        
        {showMenu && (
          <>
            <div className="fixed inset-0 cursor-default" onClick={(e) => { e.stopPropagation(); setShowMenu(false); }} />
            <div className="absolute right-0 top-8 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-10 min-w-[120px] cursor-pointer">
              <button
                onClick={(e) => { e.stopPropagation(); onEdit?.(task); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <Edit size={14} />
                Edit
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete?.(task.id); setShowMenu(false); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                <Trash2 size={14} />
                Delete
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
