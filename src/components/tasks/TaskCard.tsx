'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { StatusBadge, PriorityBadge } from '@/components/ui/Badge';
import { AvatarGroup } from '@/components/ui/Avatar';
import { Calendar, MessageSquare, CheckSquare, MoreVertical, Edit, Trash2 } from 'lucide-react';
import { useState } from 'react';

interface TaskCardProps {
  task: Task;
  onEdit?: (task: Task) => void;
  onDelete?: (id: string) => void;
}

export function TaskCard({ task, onEdit, onDelete }: TaskCardProps) {
  const { team } = useApp();
  const [showMenu, setShowMenu] = useState(false);
  
  const assignees = team.filter(m => task.assignee_ids.includes(m.id));
  const completedSubtasks = task.subtasks.filter(s => s.completed).length;
  const hasComments = task.comments.length > 0;

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

  return (
    <div className="bg-white rounded-lg border border-zinc-200 p-3 lg:p-4 hover:shadow-md hover:border-zinc-300 transition-all duration-150 group">
      <div className="flex items-start justify-between mb-2 lg:mb-3">
        <div className="flex items-center gap-1.5 lg:gap-2 flex-wrap">
          <StatusBadge status={task.status} />
          <PriorityBadge priority={task.priority} />
        </div>
        
        <div className="relative">
          <button 
            onClick={() => setShowMenu(!showMenu)}
            className="lg:opacity-0 group-hover:opacity-100 p-1 rounded text-zinc-400 hover:text-zinc-600 hover:bg-zinc-100 transition-all"
          >
            <MoreVertical size={16} />
          </button>
          
          {showMenu && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
              <div className="absolute right-0 top-8 bg-white rounded-lg shadow-xl border border-zinc-200 py-1 z-20 min-w-[120px]">
                <button
                  onClick={() => { onEdit?.(task); setShowMenu(false); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-100"
                >
                  <Edit size={14} />
                  Edit
                </button>
                <button
                  onClick={() => { onDelete?.(task.id); setShowMenu(false); }}
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

      <h3 className="font-medium text-zinc-900 text-sm lg:text-base mb-1 lg:mb-2 line-clamp-2">{task.title}</h3>
      
      {task.description && (
        <p className="text-xs lg:text-sm text-zinc-500 mb-2 lg:mb-3 line-clamp-2">{task.description}</p>
      )}

      {/* Tags */}
      {task.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2 lg:mb-3">
          {task.tags.slice(0, 3).map((tag) => (
            <span 
              key={tag} 
              className="px-1.5 py-0.5 text-[10px] lg:text-xs bg-zinc-100 text-zinc-600 rounded-full"
            >
              {tag}
            </span>
          ))}
          {task.tags.length > 3 && (
            <span className="text-[10px] text-zinc-400">+{task.tags.length - 3}</span>
          )}
        </div>
      )}

      {/* Subtasks progress */}
      {task.subtasks.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2 lg:mb-3">
          <CheckSquare size={14} />
          <span>{completedSubtasks}/{task.subtasks.length}</span>
          <div className="flex-1 h-1 bg-zinc-100 rounded-full overflow-hidden">
            <div 
              className="h-full bg-emerald-500 rounded-full transition-all"
              style={{ width: `${(completedSubtasks / task.subtasks.length) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 lg:pt-3 border-t border-zinc-100">
        <div className="flex items-center gap-2 lg:gap-3">
          {dueInfo && (
            <div className={`flex items-center gap-1 text-xs ${dueInfo.isOverdue ? 'text-red-600 font-medium' : 'text-zinc-500'}`}>
              <Calendar size={14} />
              <span>{dueInfo.text}</span>
            </div>
          )}
          {hasComments && (
            <div className="flex items-center gap-1 text-xs text-zinc-500">
              <MessageSquare size={14} />
              <span>{task.comments.length}</span>
            </div>
          )}
        </div>
        
        {assignees.length > 0 && (
          <AvatarGroup users={assignees} max={3} size="xs" />
        )}
      </div>
    </div>
  );
}
