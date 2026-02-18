'use client';

import { Task } from '@/lib/types';
import { TaskRow } from '@/components/tasks/TaskRow';
import { LayoutGrid } from 'lucide-react';

interface ListViewProps {
  tasks: Task[];
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (id: string) => void;
}

export function ListView({ tasks, onEditTask, onDeleteTask }: ListViewProps) {
  if (tasks.length === 0) {
    return (
      <div className="text-center py-12 bg-white rounded-xl border border-zinc-200">
        <LayoutGrid className="mx-auto mb-3 text-zinc-400" size={32} />
        <p className="text-zinc-500">No tasks found</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
      {/* Header - hidden on mobile */}
      <div className="hidden lg:flex items-center gap-4 px-4 py-3 bg-zinc-50 border-b border-zinc-200 text-xs font-medium text-zinc-500 uppercase tracking-wider">
        <div className="w-3" />
        <div className="flex-1">Task</div>
        <div className="w-32">Tags</div>
        <div className="w-20">Priority</div>
        <div className="w-24">Due Date</div>
        <div className="w-20">Subtasks</div>
        <div className="w-16">Comments</div>
        <div className="w-24">Assignees</div>
        <div className="w-8" />
      </div>

      {/* Rows */}
      <div className="divide-y divide-zinc-100">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onEdit={onEditTask}
            onDelete={onDeleteTask}
          />
        ))}
      </div>
    </div>
  );
}
