'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { useAuth } from '@/lib/auth-context';
import { StatusBadge, PriorityBadge, TaskTypeBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, MessageSquare, CheckSquare, MoreVertical, Edit, Trash2, Clock, User, Lock } from 'lucide-react';
import { useState, useRef } from 'react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Popover } from '@/components/ui/Popover';
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

interface TaskCardProps {
  task: Task;
  onView?: (task: Task) => void;
  onEdit?: (task: Task) => void;
  onDelete?: (id: string) => void;
}

export function TaskCard({ task, onView, onEdit, onDelete }: TaskCardProps) {
  const { team, tasks, getProject } = useApp();
  const { teamMemberId, access } = useAuth();
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isAgentsEnabled = process.env.NEXT_PUBLIC_ENABLE_AGENTS === 'true';
  const canManageAgents = hasPermission(access, 'agents.manage');

  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const canEdit = hasPermission(access, 'tasks.manage_all') || (hasPermission(access, 'tasks.manage_assigned') && task.assignee_ids.includes(teamMemberId || ''));
  const canDelete = hasPermission(access, 'tasks.manage_all');
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

  return (
    <div
      className="glass-card rounded-lg p-3 lg:p-4 hover:shadow-md hover:border-white/[0.12] transition-all duration-150 group cursor-pointer"
      onClick={() => onView?.(task)}
    >
      <div className="flex items-start justify-between mb-2 lg:mb-3">
        <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
          {isAgentsEnabled && canManageAgents && task.task_type && (
            <TaskTypeBadge taskType={task.task_type} />
          )}
          {isAgentsEnabled && canManageAgents && task.ai_readiness !== 'ai_ready' && getProject(task.project_id)?.autonomous_enabled && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] lg:text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
              <User size={10} />
              Manual
            </span>
          )}
          {task.status !== 'done' && (task.blocked_by_ids || []).some(id => tasks.find(t => t.id === id)?.status !== 'done') && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] lg:text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/30 rounded-full">
              <Lock size={10} />
              Blocked
            </span>
          )}
        </div>
        
        {(canEdit || canDelete) && <div ref={menuRef} className="relative">
          <button
            onClick={(e) => { e.stopPropagation(); setShowMenu(!showMenu); }}
            className="lg:opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.06] transition-all"
          >
            <MoreVertical size={16} />
          </button>

          <Popover
            anchorRef={menuRef}
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
        <div className="flex items-center gap-2 text-xs text-zinc-400 mb-2 lg:mb-3">
          <CheckSquare size={14} />
          <span>{completedSubtasks}/{task.subtasks.length}</span>
          <div className="flex-1 h-1 bg-white/[0.06] rounded-full overflow-hidden">
            <div 
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${(completedSubtasks / task.subtasks.length) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 lg:pt-3 border-t border-white/[0.06]">
        <div className="flex items-center gap-2 lg:gap-3">
          {dueInfo && (
            <div className={`flex items-center gap-1 text-xs ${dueInfo.isOverdue ? 'text-red-400 font-medium' : 'text-zinc-400'}`}>
              <Calendar size={14} />
              <span>{dueInfo.text}</span>
            </div>
          )}
          {hasComments && (
            <div className="flex items-center gap-1 text-xs text-zinc-400">
              <MessageSquare size={14} />
              <span>{task.comments.length}</span>
            </div>
          )}
          <Tooltip content={`Updated ${new Date(task.updated_at).toLocaleString()}`}>
            <div className="flex items-center gap-1 text-xs text-zinc-500">
              <Clock size={12} />
              <span>{timeAgo(task.updated_at)}</span>
            </div>
          </Tooltip>
        </div>
        
        {assignees.length > 0 && (
          <AvatarGroup users={assignees} max={3} size="xs" />
        )}
      </div>
    </div>
  );
}
