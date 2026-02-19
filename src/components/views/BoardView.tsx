'use client';

import { useState, useRef } from 'react';
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
  onViewTask?: (task: Task) => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (id: string) => void;
  onStatusChange?: (taskId: string, newStatus: Task['status']) => void;
}

export function BoardView({ tasks, onAddTask, onViewTask, onEditTask, onDeleteTask, onStatusChange }: BoardViewProps) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
    // Add a slight delay so the drag ghost renders before we style the card
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement;
      if (el) el.style.opacity = '0.4';
    });
  };

  const handleDragEnd = () => {
    if (draggedTaskId) {
      const el = document.querySelector(`[data-task-id="${draggedTaskId}"]`) as HTMLElement;
      if (el) el.style.opacity = '1';
    }
    setDraggedTaskId(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(columnId);
  };

  const handleDragLeave = (e: React.DragEvent, columnId: string) => {
    // Only clear if we're actually leaving the column (not entering a child)
    const relatedTarget = e.relatedTarget as HTMLElement;
    const currentTarget = e.currentTarget as HTMLElement;
    if (!currentTarget.contains(relatedTarget)) {
      setDropTarget(null);
    }
  };

  const handleDrop = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    const task = tasks.find(t => t.id === taskId);

    if (task && task.status !== columnId && onStatusChange) {
      onStatusChange(taskId, columnId as Task['status']);
    }

    setDraggedTaskId(null);
    setDropTarget(null);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-3 lg:gap-4 pb-4 lg:overflow-x-auto">
      {COLUMNS.map((column) => {
        const columnTasks = tasks.filter(t => t.status === column.id);
        const isOver = dropTarget === column.id && draggedTaskId !== null;
        const draggedTask = draggedTaskId ? tasks.find(t => t.id === draggedTaskId) : null;
        const isDragSource = draggedTask?.status === column.id;

        return (
          <div
            key={column.id}
            className="w-full lg:w-80 lg:flex-shrink-0"
            onDragOver={(e) => handleDragOver(e, column.id)}
            onDragLeave={(e) => handleDragLeave(e, column.id)}
            onDrop={(e) => handleDrop(e, column.id)}
          >
            <div className="flex items-center gap-2 mb-3 px-1">
              <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
              <h3 className="font-semibold text-zinc-800 text-sm lg:text-base">{column.title}</h3>
              <span className="text-xs text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
                {columnTasks.length}
              </span>
            </div>

            <div className={`space-y-2 lg:space-y-3 min-h-[200px] p-1 rounded-lg transition-colors duration-150 ${
              isOver && !isDragSource
                ? 'bg-indigo-50 ring-2 ring-indigo-300 ring-dashed'
                : ''
            }`}>
              {columnTasks.map((task) => (
                <div
                  key={task.id}
                  data-task-id={task.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, task.id)}
                  onDragEnd={handleDragEnd}
                  className="transition-opacity duration-150"
                >
                  <TaskCard
                    task={task}
                    onView={onViewTask}
                    onEdit={onEditTask}
                    onDelete={onDeleteTask}
                  />
                </div>
              ))}

              {/* Drop indicator when column is empty and being dragged over */}
              {isOver && !isDragSource && columnTasks.length === 0 && (
                <div className="h-20 border-2 border-dashed border-indigo-300 rounded-lg flex items-center justify-center">
                  <span className="text-sm text-indigo-400">Drop here</span>
                </div>
              )}

              {/* Empty column state */}
              {columnTasks.length === 0 && !isOver && (
                <div className="py-8 text-center">
                  <p className="text-sm text-zinc-400">No tasks</p>
                </div>
              )}

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
