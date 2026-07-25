'use client';

import { useState, useMemo } from 'react';
import { Task } from '@/lib/types';
import { TaskRow, TaskRowDesktop } from '@/components/tasks/TaskRow';
import { LayoutGrid, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { parseDateOnly } from '@/lib/date-utils';

type SortField = 'title' | 'priority' | 'due_date' | 'subtasks' | 'comments' | 'status';
type SortDir = 'asc' | 'desc';

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
const STATUS_ORDER: Record<string, number> = { todo: 0, in_progress: 1, in_review: 2, done: 3 };

interface ListViewProps {
  tasks: Task[];
  onViewTask?: (task: Task) => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (id: string) => void;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}

export function ListView({ tasks, onViewTask, onEditTask, onDeleteTask, selectedIds, onToggleSelect }: ListViewProps) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortedTasks = useMemo(() => {
    if (!sortField) return tasks;

    return [...tasks].sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'priority':
          cmp = (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
          break;
        case 'status':
          cmp = (STATUS_ORDER[a.status] ?? 99) - (STATUS_ORDER[b.status] ?? 99);
          break;
        case 'due_date': {
          if (!a.due_date && !b.due_date) cmp = 0;
          else if (!a.due_date) cmp = 1;
          else if (!b.due_date) cmp = -1;
          else cmp = parseDateOnly(a.due_date).getTime() - parseDateOnly(b.due_date).getTime();
          break;
        }
        case 'subtasks': {
          const aProgress = a.subtasks.length > 0 ? a.subtasks.filter(s => s.completed).length / a.subtasks.length : -1;
          const bProgress = b.subtasks.length > 0 ? b.subtasks.filter(s => s.completed).length / b.subtasks.length : -1;
          cmp = aProgress - bProgress;
          break;
        }
        case 'comments':
          cmp = a.comments.length - b.comments.length;
          break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [tasks, sortField, sortDir]);

  if (tasks.length === 0) {
    return (
      <div className="glass-card rounded-xl flex flex-col items-center justify-center p-8 text-center">
        <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
          <LayoutGrid size={18} className="text-zinc-500" />
        </div>
        <p className="text-sm font-medium text-zinc-400">No tasks found</p>
        <p className="text-xs text-zinc-500 mt-1">Try adjusting your filters</p>
      </div>
    );
  }

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return <ArrowUpDown size={12} className="text-zinc-600" />;
    return sortDir === 'asc'
      ? <ArrowUp size={12} className="text-brand-300" />
      : <ArrowDown size={12} className="text-brand-300" />;
  };

  const headerClass = "flex items-center gap-1 cursor-pointer hover:text-zinc-300 select-none transition-colors";

  return (
    <div className="glass-card rounded-xl overflow-hidden">
      {/* Header - hidden on mobile */}
      <div className="hidden lg:flex items-center gap-4 px-4 py-3 bg-white/[0.03] border-b border-white/[0.08] text-xs font-medium text-zinc-400 uppercase tracking-wider">
        {onToggleSelect && <div className="w-5" />}
        <div
          className={`w-3 ${headerClass}`}
          onClick={() => handleSort('status')}
        >
          <SortIcon field="status" />
        </div>
        <div className={`flex-1 ${headerClass}`} onClick={() => handleSort('title')}>
          Task <SortIcon field="title" />
        </div>
        <div className="w-32">Tags</div>
        <div className={`w-20 ${headerClass}`} onClick={() => handleSort('priority')}>
          Priority <SortIcon field="priority" />
        </div>
        <div className={`w-24 ${headerClass}`} onClick={() => handleSort('due_date')}>
          Due Date <SortIcon field="due_date" />
        </div>
        <div className={`w-20 ${headerClass}`} onClick={() => handleSort('subtasks')}>
          Subtasks <SortIcon field="subtasks" />
        </div>
        <div className={`w-16 ${headerClass}`} onClick={() => handleSort('comments')}>
          <span className="hidden xl:inline">Comments</span>
          <span className="xl:hidden">Cmts</span>
          <SortIcon field="comments" />
        </div>
        <div className="w-24">Assignees</div>
        <div className="w-8" />
      </div>

      {/* Rows */}
      <div className="divide-y divide-white/[0.06]">
        {sortedTasks.map((task) => (
          <div key={task.id}>
            <TaskRow
              task={task}
              onView={onViewTask}
              onEdit={onEditTask}
              onDelete={onDeleteTask}
            />
            <TaskRowDesktop
              task={task}
              onView={onViewTask}
              onEdit={onEditTask}
              onDelete={onDeleteTask}
              selected={selectedIds?.has(task.id)}
              onToggleSelect={onToggleSelect}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
