'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Task } from '@/lib/types';
import { TaskCard } from '@/components/tasks/TaskCard';
import { useFillHeight } from '@/lib/use-fill-height';

// Edge auto-scroll: browsers do not reliably scroll styled inner containers
// during a native HTML5 drag, so a card being dragged toward a column edge
// just stops at whatever is visible. Within this band from an edge the drag
// keeps the column (or the board strip) scrolling, faster the deeper into
// the band the pointer sits, so one gesture can travel a whole column.
const SCROLL_EDGE_PX = 72;
const SCROLL_MAX_STEP_PX = 16;


export const BOARD_COLUMNS = [
  { id: 'todo', title: 'To Do', color: 'bg-zinc-400' },
  { id: 'in_progress', title: 'In Progress', color: 'bg-brand-500' },
  { id: 'in_review', title: 'In Review', color: 'bg-amber-500' },
  { id: 'done', title: 'Done', color: 'bg-emerald-500' },
] as const;

interface BoardViewProps {
  tasks: Task[];
  onViewTask?: (task: Task) => void;
  onDeleteTask?: (id: string) => void;
  onStatusChange?: (taskId: string, newStatus: Task['status'], targetIndex?: number) => void;
  onReorder?: (taskId: string, newSortOrder: number) => void;
}

interface DropIndicator {
  columnId: string;
  index: number;
}

/** Where a card will land. Drawn over the gap between cards, never inserted
 *  into the list: an inserted line pushes the cards below it down, which
 *  moves the halfway mark the pointer is measured against, and the line
 *  flickers between two slots. */
function DropLine({ edge }: { edge: 'top' | 'bottom' }) {
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none absolute inset-x-1 z-10 flex items-center gap-1.5 ${edge === 'top' ? '-top-[10px]' : '-bottom-[10px]'}`}
    >
      <div className="w-2 h-2 rounded-full bg-brand-500 flex-shrink-0" />
      <div className="h-0.5 bg-brand-500 flex-1 rounded-full" />
    </div>
  );
}

export function BoardView({ tasks, onViewTask, onDeleteTask, onStatusChange, onReorder }: BoardViewProps) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);
  const draggedTaskIdRef = useRef<string | null>(null);
  const dropIndicatorRef = useRef<DropIndicator | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  // The board fills the rest of the viewport on desktop, so columns scroll
  // inside it and the page does not scroll a second time around them.
  const { style: fillStyle } = useFillHeight({ min: 400 }, boardRef);
  const scrollAreasRef = useRef<Record<string, HTMLDivElement | null>>({});
  const dragPointerRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

  const showIndicator = useCallback((next: DropIndicator | null) => {
    const prev = dropIndicatorRef.current;
    if (prev?.columnId === next?.columnId && prev?.index === next?.index) return;
    dropIndicatorRef.current = next;
    setDropIndicator(next);
  }, []);

  // One rAF loop for the whole drag. dragover events only fire a few times a
  // second when the pointer is stationary, so scrolling from the event alone
  // stutters; the loop reads the last known pointer position every frame.
  const autoScrollStep = useCallback(function step() {
    const pointer = dragPointerRef.current;
    if (!pointer || !draggedTaskIdRef.current) {
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

    autoScrollRafRef.current = requestAnimationFrame(step);
  }, []);

  const trackDragPointer = useCallback((e: React.DragEvent) => {
    if (!draggedTaskIdRef.current) return;
    dragPointerRef.current = { x: e.clientX, y: e.clientY };
    if (autoScrollRafRef.current === null) {
      autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
    }
  }, [autoScrollStep]);

  // Ends a drag, however it ended. A card dropped into another column is
  // unmounted from its old column before the browser sends `dragend`, so
  // that event goes to a detached node and never reaches React: relying on
  // it alone left the edge-scroll loop running after the drop (the column
  // kept scrolling on its own and pushed back against the wheel) and the
  // board stuck in drag mode. The drop handler, the card's own dragend and
  // a window listener all call this; whichever comes first wins.
  const endDrag = useCallback(() => {
    dragPointerRef.current = null;
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    if (draggedTaskIdRef.current === null) return;
    draggedTaskIdRef.current = null;
    setDraggedTaskId(null);
    showIndicator(null);
  }, [showIndicator]);

  useEffect(() => {
    if (draggedTaskId === null) return;
    window.addEventListener('dragend', endDrag);
    window.addEventListener('drop', endDrag);
    return () => {
      window.removeEventListener('dragend', endDrag);
      window.removeEventListener('drop', endDrag);
    };
  }, [draggedTaskId, endDrag]);

  useEffect(() => endDrag, [endDrag]);

  const getColumnTasks = useCallback((columnId: string) => {
    return tasks
      .filter(t => t.status === columnId)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  }, [tasks]);

  const handleDragStart = (e: React.DragEvent, taskId: string) => {
    draggedTaskIdRef.current = taskId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', taskId);
    // Dim the card a frame later: re-rendering the source in the same tick
    // as dragstart makes some browsers snapshot the dimmed card as the drag
    // image, or cancel the drag outright.
    requestAnimationFrame(() => {
      if (draggedTaskIdRef.current === taskId) setDraggedTaskId(taskId);
    });
  };

  const handleCardDragOver = (e: React.DragEvent, columnId: string, cardIndex: number) => {
    if (!draggedTaskIdRef.current) return;
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
    const colTasks = getColumnTasks(columnId);
    const dragIdx = colTasks.findIndex(t => t.id === dragId);
    if (dragIdx !== -1 && (insertIndex === dragIdx || insertIndex === dragIdx + 1)) {
      showIndicator(null);
      return;
    }

    showIndicator({ columnId, index: insertIndex });
  };

  const handleColumnDragOver = (e: React.DragEvent, columnId: string) => {
    if (!draggedTaskIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    trackDragPointer(e);

    // Over the column but not over a card (its header, the gap under the last
    // card): the card would land at the end.
    if (dropIndicatorRef.current?.columnId !== columnId) {
      const columnTasks = getColumnTasks(columnId);
      const dragIdx = columnTasks.findIndex(t => t.id === draggedTaskIdRef.current);
      showIndicator(dragIdx !== -1 && dragIdx === columnTasks.length - 1 ? null : { columnId, index: columnTasks.length });
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      showIndicator(null);
    }
  };

  const handleDrop = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    const taskId = draggedTaskIdRef.current ?? e.dataTransfer.getData('text/plain');
    const indicator = dropIndicatorRef.current;
    endDrag();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    if (task.status === columnId) {
      // Within-column reorder. No indicator means a no-op spot (the card's own).
      if (!onReorder || !indicator || indicator.columnId !== columnId) return;
      const columnTasks = getColumnTasks(columnId);
      const currentIndex = columnTasks.findIndex(t => t.id === taskId);
      let targetIndex = indicator.index;
      // Dragging downward: the card's own slot closes up before it lands.
      if (currentIndex < targetIndex) targetIndex--;
      if (currentIndex !== targetIndex && targetIndex >= 0) {
        onReorder(taskId, targetIndex);
      }
    } else if (onStatusChange) {
      const columnTasks = getColumnTasks(columnId);
      const targetIndex = indicator?.columnId === columnId ? indicator.index : columnTasks.length;
      onStatusChange(taskId, columnId as Task['status'], targetIndex);
    }
  };

  const moveTask = onStatusChange
    ? (taskId: string, status: Task['status']) => onStatusChange(taskId, status, getColumnTasks(status).length)
    : undefined;

  const isDragging = draggedTaskId !== null;
  const draggedTask = isDragging ? tasks.find(t => t.id === draggedTaskId) : null;

  return (
    <div
      ref={boardRef}
      style={fillStyle}
      className="flex flex-col lg:flex-row gap-6 pb-4 lg:pb-0 lg:overflow-x-auto lg:h-[var(--fill-h,calc(100vh-320px))]"
    >
      {BOARD_COLUMNS.map((column) => {
        const columnTasks = getColumnTasks(column.id);
        const isOverDifferentColumn = isDragging && dropIndicator?.columnId === column.id && draggedTask?.status !== column.id;
        const indicatorIndex = isDragging && dropIndicator?.columnId === column.id ? dropIndicator.index : null;

        return (
          <section
            key={column.id}
            aria-label={`${column.title}, ${columnTasks.length} ${columnTasks.length === 1 ? 'task' : 'tasks'}`}
            className="glass-card w-full lg:flex-1 lg:min-w-[260px] flex flex-col bg-white/[0.06] rounded-xl p-2 pb-0 lg:p-3 lg:pb-0"
            onDragOver={(e) => handleColumnDragOver(e, column.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, column.id)}
          >
            {/* Column header */}
            <div className="flex items-center gap-2 mb-2 lg:mb-3 px-1 flex-shrink-0">
              <div className={`w-2.5 h-2.5 rounded-full ${column.color}`} aria-hidden="true" />
              <h3 className="font-semibold text-zinc-100 text-lg">{column.title}</h3>
              <span className="text-xs text-zinc-400 bg-white/[0.06] px-1.5 py-0.5 rounded" aria-hidden="true">
                {columnTasks.length}
              </span>
            </div>

            {/* Scrollable card area. It runs to the column's bottom edge so
                cards flow out of view; its padding leaves room for the drop
                line above the first card and below the last. */}
            <div
              ref={(el) => { scrollAreasRef.current[column.id] = el; }}
              className={`flex-1 overflow-y-auto max-h-[50vh] lg:max-h-none lg:min-h-0 pt-2.5 pb-3 rounded-lg transition-colors duration-150 board-column-scroll ${
                isOverDifferentColumn ? 'bg-brand-500/15 ring-2 ring-brand-300 ring-dashed' : ''
              }`}
            >
              <ul className="space-y-3">
                {columnTasks.map((task, idx) => (
                  <li
                    key={task.id}
                    data-task-id={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    onDragEnd={endDrag}
                    onDragOver={(e) => handleCardDragOver(e, column.id, idx)}
                    className={`relative transition-opacity duration-150 ${draggedTaskId === task.id ? 'opacity-40' : ''}`}
                  >
                    {indicatorIndex === idx && <DropLine edge="top" />}
                    {indicatorIndex === columnTasks.length && idx === columnTasks.length - 1 && <DropLine edge="bottom" />}
                    <TaskCard
                      task={task}
                      onView={onViewTask}
                      onDelete={onDeleteTask}
                      onMove={moveTask}
                    />
                  </li>
                ))}
              </ul>

              {/* Drop target when column is empty and being dragged over */}
              {isOverDifferentColumn && columnTasks.length === 0 && (
                <div className="h-20 border-2 border-dashed border-brand-500/30 rounded-lg flex items-center justify-center">
                  <span className="text-sm text-brand-400">Drop here</span>
                </div>
              )}

              {/* Empty column state */}
              {columnTasks.length === 0 && !isOverDifferentColumn && (
                <div className="py-8 text-center">
                  <p className="text-sm text-zinc-500">No tasks</p>
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
