'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Task } from '@/lib/types';
import { TaskCard } from '@/components/tasks/TaskCard';

// Edge auto-scroll: browsers do not reliably scroll styled inner containers
// during a native HTML5 drag, so a card being dragged toward a column edge
// just stops at whatever is visible. Within this band from an edge the drag
// keeps the column (or the board strip) scrolling, faster the deeper into
// the band the pointer sits, so one gesture can travel a whole column.
const SCROLL_EDGE_PX = 72;
const SCROLL_MAX_STEP_PX = 16;


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
  const boardRef = useRef<HTMLDivElement | null>(null);
  const scrollAreasRef = useRef<Record<string, HTMLDivElement | null>>({});
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  // One rAF loop for the whole drag. dragover events only fire a few times a
  // second when the pointer is stationary, so scrolling from the event alone
  // stutters; the loop reads the last known pointer position every frame.
  const autoScrollStep = useCallback(() => {
    const pointer = dragPointerRef.current;
    if (!pointer) {
      autoScrollRafRef.current = null;
      return;
    }

    // Vertical: the column scroll area the pointer is over (or just past the
    // top/bottom lip of; a drag hovering the column header should still pull
    // the list upward).
    for (const el of Object.values(scrollAreasRef.current)) {
      if (!el || el.scrollHeight <= el.clientHeight) continue;
      const rect = el.getBoundingClientRect();
      if (pointer.x < rect.left || pointer.x > rect.right) continue;
      if (pointer.y < rect.top - SCROLL_EDGE_PX || pointer.y > rect.bottom + SCROLL_EDGE_PX) continue;
      const fromTop = pointer.y - rect.top;
      const fromBottom = rect.bottom - pointer.y;
      if (fromTop < SCROLL_EDGE_PX) {
        el.scrollTop -= SCROLL_MAX_STEP_PX * Math.min(1, 1 - fromTop / SCROLL_EDGE_PX);
      } else if (fromBottom < SCROLL_EDGE_PX) {
        el.scrollTop += SCROLL_MAX_STEP_PX * Math.min(1, 1 - fromBottom / SCROLL_EDGE_PX);
      }
      break;
    }

    // Horizontal: the board strip itself, for carrying a card to an
    // off-screen column on narrower desktop widths.
    const board = boardRef.current;
    if (board && board.scrollWidth > board.clientWidth) {
      const rect = board.getBoundingClientRect();
      if (pointer.y >= rect.top && pointer.y <= rect.bottom) {
        const fromLeft = pointer.x - rect.left;
        const fromRight = rect.right - pointer.x;
        if (fromLeft < SCROLL_EDGE_PX) {
          board.scrollLeft -= SCROLL_MAX_STEP_PX * Math.min(1, 1 - fromLeft / SCROLL_EDGE_PX);
        } else if (fromRight < SCROLL_EDGE_PX) {
          board.scrollLeft += SCROLL_MAX_STEP_PX * Math.min(1, 1 - fromRight / SCROLL_EDGE_PX);
        }
      }
    }

    autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
  }, []);

  const trackDragPointer = useCallback((e: React.DragEvent) => {
    dragPointerRef.current = { x: e.clientX, y: e.clientY };
    if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
    }
  }, [autoScrollStep]);

  const stopAutoScroll = useCallback(() => {
    dragPointerRef.current = null;
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
  }, []);

  useEffect(() => stopAutoScroll, [stopAutoScroll]);

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
    stopAutoScroll();
  };

  const handleCardDragOver = (e: React.DragEvent, columnId: string, cardIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    trackDragPointer(e);

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
    trackDragPointer(e);

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
      <div ref={boardRef} className="flex flex-col lg:flex-row gap-6 pb-4 lg:pb-0 lg:overflow-x-auto lg:h-[calc(100vh-320px)] lg:min-h-[400px]">
        {COLUMNS.map((column) => {
          const columnTasks = getColumnTasks(column.id);
          const isOverDifferentColumn = isDragging && dropIndicator?.columnId === column.id && draggedTask?.status !== column.id;

          return (
            <div
              key={column.id}
              className="glass-card w-full lg:flex-1 lg:min-w-[260px] flex flex-col bg-white/[0.06] rounded-xl p-2 lg:p-3"
              onDragOver={(e) => handleColumnDragOver(e, column.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, column.id)}
            >
              {/* Column header */}
              <div className="flex items-center gap-2 mb-2 lg:mb-3 px-1 flex-shrink-0">
                <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} />
                <h3 className="font-semibold text-zinc-100 text-lg">{column.title}</h3>
                <span className="text-xs text-zinc-400 bg-white/[0.06] px-1.5 py-0.5 rounded">
                  {columnTasks.length}
                </span>
              </div>

              {/* Scrollable card area */}
              <div ref={(el) => { scrollAreasRef.current[column.id] = el; }} className={`flex-1 overflow-y-auto max-h-[50vh] lg:max-h-none lg:min-h-0 pr-1.5 rounded-lg transition-colors duration-150 board-column-scroll ${
                isOverDifferentColumn
                  ? 'bg-brand-500/15 ring-2 ring-brand-300 ring-dashed'
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
                  <div className="h-20 border-2 border-dashed border-brand-500/30 rounded-lg flex items-center justify-center">
                    <span className="text-sm text-brand-400">Drop here</span>
                  </div>
                )}

                {/* Empty column state */}
                {columnTasks.length === 0 && !isDragging && (
                  <div className="py-8 text-center">
                    <p className="text-sm text-zinc-500">No tasks</p>
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
