'use client';

import { useState } from 'react';
import { Task } from '@/lib/types';
import { TaskCard } from '@/components/tasks/TaskCard';


const COLUMNS = [
  { id: 'todo', title: 'To Do', color: 'bg-zinc-400' },
  { id: 'in_progress', title: 'In Progress', color: 'bg-brand-500' },
  { id: 'in_review', title: 'In Review', color: 'bg-amber-500' },
  { id: 'done', title: 'Done', color: 'bg-emerald-500' },
];

interface BoardViewProps {
  tasks: Task[];
  onViewTask?: (task: Task) => void;
  onEditTask?: (task: Task) => void;
  onDeleteTask?: (id: string) => void;
  onStatusChange?: (taskId: string, newStatus: Task['status']) => void;
}

export function BoardView({ tasks, onViewTask, onEditTask, onDeleteTask, onStatusChange }: BoardViewProps) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
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

  const handleDragLeave = (e: React.DragEvent) => {
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
    <div className="flex flex-col lg:flex-row gap-6 pb-4 lg:pb-0 lg:overflow-x-auto lg:h-[calc(100vh-320px)] lg:min-h-[400px]">
      {COLUMNS.map((column) => {
        const columnTasks = tasks.filter(t => t.status === column.id);
        const isOver = dropTarget === column.id && draggedTaskId !== null;
        const draggedTask = draggedTaskId ? tasks.find(t => t.id === draggedTaskId) : null;
        const isDragSource = draggedTask?.status === column.id;

        return (
          <div
            key={column.id}
            className="w-full lg:flex-1 lg:min-w-[260px] flex flex-col bg-zinc-100/60 rounded-xl p-2 lg:p-3"
            onDragOver={(e) => handleDragOver(e, column.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, column.id)}
          >
            {/* Sticky column header */}
            <div className="flex items-center gap-2 mb-2 lg:mb-3 px-1 flex-shrink-0">
              <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
              <h3 className="font-semibold text-zinc-800 text-sm lg:text-base">{column.title}</h3>
              <span className="text-xs text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
                {columnTasks.length}
              </span>
            </div>

            {/* Scrollable card area */}
            <div className={`flex-1 overflow-y-auto max-h-[50vh] lg:max-h-none lg:min-h-0 space-y-2 lg:space-y-3 rounded-lg transition-colors duration-150 board-column-scroll ${
              isOver && !isDragSource
                ? 'bg-brand-50 ring-2 ring-brand-300 ring-dashed'
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
                <div className="h-20 border-2 border-dashed border-brand-300 rounded-lg flex items-center justify-center">
                  <span className="text-sm text-brand-400">Drop here</span>
                </div>
              )}

              {/* Empty column state */}
              {columnTasks.length === 0 && !isOver && (
                <div className="py-8 text-center">
                  <p className="text-sm text-zinc-400">No tasks</p>
                </div>
              )}

            </div>
          </div>
        );
      })}
    </div>
  );
}
