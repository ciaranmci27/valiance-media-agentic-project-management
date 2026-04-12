'use client';

import { useState, useRef, useCallback } from 'react';
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
  onStatusChange?: (taskId: string, newStatus: Task['status'], targetIndex?: number) => void;
  onReorder?: (taskId: string, newSortOrder: number) => void;
}

interface DropIndicator {
  columnId: string;
  index: number;
}

export function BoardView({ tasks, onViewTask, onEditTask, onDeleteTask, onStatusChange, onReorder }: BoardViewProps) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const draggedTaskIdRef = useRef<string | null>(null);

  const getColumnTasks = useCallback((columnId: string) => {
    return tasks
      .filter(t => t.status === columnId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }, [tasks]);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    draggedTaskIdRef.current = taskId;
    setDraggedTaskId(taskId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
    // Use a class instead of inline style to avoid rAF race condition
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement;
      if (el && draggedTaskIdRef.current === taskId) {
        el.classList.add('board-dragging');
      }
    });
  };

  const handleDragEnd = () => {
    const id = draggedTaskIdRef.current;
    if (id) {
      const el = document.querySelector(`[data-task-id="${id}"]`) as HTMLElement;
      if (el) el.classList.remove('board-dragging');
    }
    draggedTaskIdRef.current = null;
    setDraggedTaskId(null);
    setDropIndicator(null);
  };

  const handleCardDragOver = (e: React.DragEvent, columnId: string, cardIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    // Determine if cursor is in the top or bottom half of the card
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const insertIndex = e.clientY < midY ? cardIndex : cardIndex + 1;

    // Suppress indicator for no-op positions (directly above or below the dragged card)
    const dragId = draggedTaskIdRef.current;
    if (dragId) {
      const colTasks = getColumnTasks(columnId);
      const dragIdx = colTasks.findIndex(t => t.id === dragId);
      if (dragIdx !== -1 && (insertIndex === dragIdx || insertIndex === dragIdx + 1)) {
        setDropIndicator(null);
        return;
      }
    }

    setDropIndicator({ columnId, index: insertIndex });
  };

  const handleColumnDragOver = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Only set indicator to end of column if not already over a card
    const columnTasks = getColumnTasks(columnId);
    if (!dropIndicator || dropIndicator.columnId !== columnId) {
      setDropIndicator({ columnId, index: columnTasks.length });
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as HTMLElement;
    const currentTarget = e.currentTarget as HTMLElement;
    if (!currentTarget.contains(relatedTarget)) {
      setDropIndicator(null);
    }
  };

  const handleDrop = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const isSameColumn = task.status === columnId;

    if (isSameColumn && onReorder && dropIndicator) {
      // Within-column reorder
      const columnTasks = getColumnTasks(columnId);
      const currentIndex = columnTasks.findIndex(t => t.id === taskId);
      let targetIndex = dropIndicator.index;

      // Adjust target: if dragging downward, account for the removal of the dragged card
      if (currentIndex < targetIndex) targetIndex--;

      if (currentIndex !== targetIndex && targetIndex >= 0) {
        onReorder(taskId, targetIndex);
      }
    } else if (!isSameColumn && onStatusChange) {
      // Cross-column status change with drop position
      const columnTasks = getColumnTasks(columnId);
      const targetIndex = dropIndicator ? dropIndicator.index : columnTasks.length;
      onStatusChange(taskId, columnId as Task['status'], targetIndex);
    }

    // Don't clear draggedTaskIdRef here. handleDragEnd always fires after
    // handleDrop and owns the cleanup (removing the board-dragging class).
    // Clearing the ref here would prevent handleDragEnd from finding the element.
    setDropIndicator(null);
  };

  const isDragging = draggedTaskId !== null;
  const draggedTask = isDragging ? tasks.find(t => t.id === draggedTaskId) : null;

  return (
    <>
      <style jsx>{`
        .board-dragging {
          opacity: 0.4;
        }
      `}</style>
      <div className="flex flex-col lg:flex-row gap-6 pb-4 lg:pb-0 lg:overflow-x-auto lg:h-[calc(100vh-320px)] lg:min-h-[400px]">
        {COLUMNS.map((column) => {
          const columnTasks = getColumnTasks(column.id);
          const isOverDifferentColumn = isDragging && dropIndicator?.columnId === column.id && draggedTask?.status !== column.id;

          return (
            <div
              key={column.id}
              className="w-full lg:flex-1 lg:min-w-[260px] flex flex-col bg-zinc-100/60 rounded-xl p-2 lg:p-3"
              onDragOver={(e) => handleColumnDragOver(e, column.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column.id)}
            >
              {/* Column header */}
              <div className="flex items-center gap-2 mb-2 lg:mb-3 px-1 flex-shrink-0">
                <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
                <h3 className="font-semibold text-zinc-800 text-lg">{column.title}</h3>
                <span className="text-xs text-zinc-500 bg-zinc-100 px-1.5 py-0.5 rounded">
                  {columnTasks.length}
                </span>
              </div>

              {/* Scrollable card area */}
              <div className={`flex-1 overflow-y-auto max-h-[50vh] lg:max-h-none lg:min-h-0 pr-1.5 rounded-lg transition-colors duration-150 board-column-scroll ${
                isOverDifferentColumn
                  ? 'bg-brand-50 ring-2 ring-brand-300 ring-dashed'
                  : ''
              }`}>
                {columnTasks.map((task, idx) => {
                  const showIndicatorBefore = isDragging
                    && dropIndicator?.columnId === column.id
                    && dropIndicator.index === idx
                    && draggedTaskId !== task.id;

                  return (
                    <div key={task.id}>
                      {/* Drop indicator line */}
                      {showIndicatorBefore && (
                        <div className="flex items-center gap-1.5 py-0.5 px-1">
                          <div className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0" />
                          <div className="h-0.5 bg-brand-500 flex-1 rounded-full" />
                        </div>
                      )}

                      <div
                        data-task-id={task.id}
                        draggable
                        onDragStart={(e) => handleDragStart(e, task.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={(e) => handleCardDragOver(e, column.id, idx)}
                        className={`transition-opacity duration-150 ${idx > 0 ? 'mt-2 lg:mt-3' : ''}`}
                      >
                        <TaskCard
                          task={task}
                          onView={onViewTask}
                          onEdit={onEditTask}
                          onDelete={onDeleteTask}
                        />
                      </div>
                    </div>
                  );
                })}

                {/* Drop indicator at end of column */}
                {isDragging
                  && dropIndicator?.columnId === column.id
                  && dropIndicator.index >= columnTasks.length
                  && !(columnTasks.length === 0) && (
                  <div className="flex items-center gap-1.5 py-0.5 px-1 mt-2">
                    <div className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0" />
                    <div className="h-0.5 bg-brand-500 flex-1 rounded-full" />
                  </div>
                )}

                {/* Drop indicator when column is empty and being dragged over */}
                {isDragging && isOverDifferentColumn && columnTasks.length === 0 && (
                  <div className="h-20 border-2 border-dashed border-brand-300 rounded-lg flex items-center justify-center">
                    <span className="text-sm text-brand-400">Drop here</span>
                  </div>
                )}

                {/* Empty column state */}
                {columnTasks.length === 0 && !isDragging && (
                  <div className="py-8 text-center">
                    <p className="text-sm text-zinc-400">No tasks</p>
                  </div>
                )}

              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
