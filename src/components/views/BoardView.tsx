'use client';

import { Task } from '@/lib/types';
import { useApp } from '@/lib/store';
import { TaskCard } from '@/components/tasks/TaskCard';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/Button';

const COLUMNS = [
  { id: 'todo', title: 'To Do', color: 'bg-zinc-400' },
  { id: 'in_progress', title: 'In Progress', color: 'bg-indigo-500' },
  { id: 'in_review', title: 'In Review', color: 'bg-amber-500' },
  { id: 'done', title: 'Done', color: 'bg-emerald-500' },
];

interface BoardViewProps {
  tasks: Task[];
  onAddTask?: () => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (id: string) => void;
}

export function BoardView({ tasks, onAddTask, onEditTask, onDeleteTask }: BoardViewProps) {
  return (
    <div className="flex gap-3 lg:gap-4 overflow-x-auto pb-4 -mx-4 px-4 lg:mx-0 lg:px-0">
      {COLUMNS.map((column) => {
        const columnTasks = tasks.filter(t => t.status === column.id);
        return (
          <div key={column.id} className="flex-shrink-0 w-72 lg:w-80">
            <div className="flex items-center gap-2 mb-3 px-1">
              <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
              <h3 className="font-semibold text-zinc-800 text-sm lg:text-base">{column.title}</h3>
              <span className="text-xs text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
                {columnTasks.length}
              </span>
            </div>
            
            <div className="space-y-2 lg:space-y-3 min-h-[200px] p-1">
              {columnTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  onEdit={onEditTask}
                  onDelete={onDeleteTask}
                />
              ))}
              
              {column.id === 'todo' && (
                <button
                  onClick={onAddTask}
                  className="w-full p-3 flex items-center justify-center gap-2 text-sm text-zinc-500 border border-dashed border-zinc-300 rounded-lg hover:border-indigo-400 hover:text-indigo-600 hover:bg-indigo-50 transition-all"
                >
                  <Plus size={16} />
                  <span className="hidden sm:inline">Add Task</span>
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
