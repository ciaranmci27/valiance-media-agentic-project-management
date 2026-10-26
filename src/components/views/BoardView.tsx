'use client';

import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import { ChevronUp } from 'lucide-react';
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

// Two columns end in a footer that folds a second list away. Backlog, under
// To Do, holds tasks kept for later that nobody has committed to; holding a
// dragged card over its folded bar opens it, so a card can be dropped at an
// exact spot instead of only at the top. Archive, under Done, holds what was
// finished more than a week ago: it fills itself, so cards leave it but are
// never dropped into it. Each remembers whether it was left open.
const BACKLOG_OPEN_KEY = 'board.backlog-open';
const ARCHIVE_OPEN_KEY = 'board.archive-open';
const BACKLOG_SPRING_MS = 650;
const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function savedOpen(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(key) === '1'; } catch { return false; }
}

function rememberOpen(key: string, open: boolean) {
  try { window.localStorage.setItem(key, open ? '1' : '0'); } catch { /* not remembered */ }
}

/** When a done task was finished; older rows without a stamp use their last edit. */
function finishedAt(task: Task): number {
  return new Date(task.completed_at ?? task.updated_at).getTime();
}

const bySortOrder = (a: Task, b: Task) => (a.sort_order ?? 0) - (b.sort_order ?? 0);

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

interface ColumnFooterProps {
  /** id of the list it opens, for aria-controls. */
  listId: string;
  label: string;
  /** The status dot, built like a column header's one step down. */
  dot: string;
  count: number;
  open: boolean;
  animates: boolean;
  onToggle: () => void;
  /** Open height on desktop (a flex-basis class). */
  openBasis: string;
  /** A held card is over it and will land in it. */
  dropping?: boolean;
  /** A card is in hand that it would take. */
  inviting?: boolean;
  /** Replaces the label while dropping onto the folded bar. */
  dropLabel?: string;
  dragHandlers?: Pick<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>;
  scrollRef?: (el: HTMLDivElement | null) => void;
  children: ReactNode;
}

/** A footer flush with the bottom of a column that opens upward into a
 *  second, separately scrolled list of cards. */
function ColumnFooter({
  listId, label, dot, count, open, animates, onToggle, openBasis,
  dropping = false, inviting = false, dropLabel, dragHandlers, scrollRef, children,
}: ColumnFooterProps) {
  const showDropLabel = dropping && !open && !!dropLabel;
  return (
    <div
      {...dragHandlers}
      // The negative margins undo the column's side padding so it runs edge
      // to edge.
      className={`flex flex-col min-h-0 overflow-hidden -mx-2 lg:-mx-3 rounded-b-xl border-t ${
        animates ? 'transition-[flex-basis,background-color,border-color] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none' : ''
      } ${
        open ? `lg:shrink ${openBasis}` : 'shrink-0 lg:basis-11'
      } ${
        dropping
          ? 'bg-brand-500/15 border-brand-300/60'
          : inviting
            ? 'bg-white/[0.03] border-brand-500/40'
            : open
              ? 'bg-black/15 border-white/[0.08]'
              : 'bg-white/[0.02] border-white/[0.06] hover:bg-white/[0.04]'
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={listId}
        className="group flex h-11 flex-shrink-0 items-center gap-2 px-3 lg:px-4 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500"
      >
        <span className={`w-2.5 h-2.5 rounded-full transition-colors ${dot}`} aria-hidden="true" />
        <span className={`text-sm font-semibold ${dropping ? 'text-brand-200' : 'text-zinc-200 group-hover:text-zinc-100 transition-colors'}`}>
          {showDropLabel ? dropLabel : label}
        </span>
        {!showDropLabel && (
          <span className="text-xs text-zinc-400 bg-white/[0.06] px-1.5 py-0.5 rounded tabular-nums">
            {count}
            <span className="sr-only"> {count === 1 ? 'task' : 'tasks'}</span>
          </span>
        )}
        <ChevronUp
          size={14}
          className={`ml-auto text-zinc-500 group-hover:text-zinc-300 transition-transform duration-300 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        // Same side padding as the column, so these cards line up with the
        // column's cards above them.
        <div id={listId} className="flex-1 min-h-0 flex flex-col px-2 lg:px-3 animate-fadeIn">
          <div
            ref={scrollRef}
            className="flex-1 min-h-0 overflow-y-auto max-h-[50vh] lg:max-h-none pt-2.5 pb-6 [mask-image:linear-gradient(to_bottom,#000_calc(100%-1.5rem),transparent)] board-column-scroll"
          >
            {children}
          </div>
        </div>
      )}
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
  const [backlogOpen, setBacklogOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  // Off for the first frame, so a footer left open does not slide open again
  // on every page load.
  const [trayAnimates, setTrayAnimates] = useState(false);
  const springTimerRef = useRef<number | null>(null);
  // Where Done ends and Archive begins, fixed for the life of the board so a
  // card does not jump between them while it is on screen.
  const [archiveBefore] = useState(() => Date.now() - ARCHIVE_AFTER_MS);

  // Read after mount: the server render has no storage, and reading it during
  // the first render would not match the HTML it sent.
  useEffect(() => {
    setBacklogOpen(savedOpen(BACKLOG_OPEN_KEY));
    setArchiveOpen(savedOpen(ARCHIVE_OPEN_KEY));
    const frame = requestAnimationFrame(() => setTrayAnimates(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggleBacklog = useCallback((open?: boolean) => {
    setBacklogOpen(prev => {
      const next = open ?? !prev;
      rememberOpen(BACKLOG_OPEN_KEY, next);
      return next;
    });
  }, []);

  const toggleArchive = useCallback(() => {
    setArchiveOpen(prev => {
      rememberOpen(ARCHIVE_OPEN_KEY, !prev);
      return !prev;
    });
  }, []);

  const cancelSpring = useCallback(() => {
    if (springTimerRef.current !== null) {
      window.clearTimeout(springTimerRef.current);
      springTimerRef.current = null;
    }
  }, []);

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
    cancelSpring();
    dragPointerRef.current = null;
    if (autoScrollRafRef.current !== null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    if (draggedTaskIdRef.current === null) return;
    draggedTaskIdRef.current = null;
    setDraggedTaskId(null);
    showIndicator(null);
  }, [showIndicator, cancelSpring]);

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

  // The cards a column shows: for Done, only what was finished this week.
  const getColumnTasks = useCallback((columnId: string) => {
    return tasks
      .filter(t => t.status === columnId && (columnId !== 'done' || finishedAt(t) >= archiveBefore))
      .sort(bySortOrder);
  }, [tasks, archiveBefore]);

  // A drop position counts the cards Done shows, but the move places the task
  // among every done task: land before the same neighbour there, or at the end.
  const toColumnIndex = (columnId: string, taskId: string, visibleIndex: number) => {
    if (columnId !== 'done') return visibleIndex;
    const anchor = getColumnTasks('done').filter(t => t.id !== taskId)[visibleIndex];
    const all = tasks.filter(t => t.status === 'done' && t.id !== taskId).sort(bySortOrder);
    return anchor ? all.findIndex(t => t.id === anchor.id) : all.length;
  };

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

  // The tray sits inside To Do, so its drag events stop here and never reach
  // the column around it. Folded, a drop shelves the card at the top of the
  // backlog, where it is first in line when the tray opens.
  const handleBacklogDragOver = (e: React.DragEvent) => {
    e.stopPropagation();
    if (backlogOpen) {
      handleColumnDragOver(e, 'backlog');
      return;
    }
    if (!draggedTaskIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    trackDragPointer(e);
    const fromBacklog = tasks.find(t => t.id === draggedTaskIdRef.current)?.status === 'backlog';
    showIndicator(fromBacklog ? null : { columnId: 'backlog', index: 0 });
    if (springTimerRef.current === null) {
      springTimerRef.current = window.setTimeout(() => {
        springTimerRef.current = null;
        if (draggedTaskIdRef.current) toggleBacklog(true);
      }, BACKLOG_SPRING_MS);
    }
  };

  const handleBacklogDragLeave = (e: React.DragEvent) => {
    const relatedTarget = e.relatedTarget as Node | null;
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) cancelSpring();
    handleDragLeave(e);
  };

  const handleBacklogDrop = (e: React.DragEvent) => {
    e.stopPropagation();
    handleDrop(e, 'backlog');
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
      // A card from Archive dropped back on Done: it stays where it is.
      if (currentIndex === -1) return;
      let targetIndex = indicator.index;
      // Dragging downward: the card's own slot closes up before it lands.
      if (currentIndex < targetIndex) targetIndex--;
      if (currentIndex !== targetIndex && targetIndex >= 0) {
        onReorder(taskId, toColumnIndex(columnId, taskId, targetIndex));
      }
    } else if (onStatusChange) {
      const columnTasks = getColumnTasks(columnId);
      const targetIndex = indicator?.columnId === columnId ? indicator.index : columnTasks.length;
      onStatusChange(taskId, columnId as Task['status'], toColumnIndex(columnId, taskId, targetIndex));
    }
  };

  const moveTask = onStatusChange
    ? (taskId: string, status: Task['status']) => onStatusChange(taskId, status, tasks.filter(t => t.status === status).length)
    : undefined;

  const isDragging = draggedTaskId !== null;
  const draggedTask = isDragging ? tasks.find(t => t.id === draggedTaskId) : null;

  // listId null: the cards can be dragged out but nothing lands between them.
  const renderCards = (listId: Task['status'] | null, listTasks: Task[], indicatorIndex: number | null) => (
    <ul className="space-y-3">
      {listTasks.map((task, idx) => (
        <li
          key={task.id}
          data-task-id={task.id}
          draggable
          onDragStart={(e) => handleDragStart(e, task.id)}
          onDragEnd={endDrag}
          onDragOver={listId ? (e) => handleCardDragOver(e, listId, idx) : undefined}
          className={`relative transition-opacity duration-150 ${draggedTaskId === task.id ? 'opacity-40' : ''}`}
        >
          {indicatorIndex === idx && <DropLine edge="top" />}
          {indicatorIndex === listTasks.length && idx === listTasks.length - 1 && <DropLine edge="bottom" />}
          <TaskCard
            task={task}
            onView={onViewTask}
            onDelete={onDeleteTask}
            onMove={moveTask}
          />
        </li>
      ))}
    </ul>
  );

  const backlogTasks = getColumnTasks('backlog');
  const backlogIndicator = isDragging && dropIndicator?.columnId === 'backlog' ? dropIndicator.index : null;
  const shelving = isDragging && dropIndicator?.columnId === 'backlog' && draggedTask?.status !== 'backlog';
  // While a committed card is in hand, the folded bar hints that it takes drops.
  const backlogInvites = isDragging && !backlogOpen && draggedTask?.status !== 'backlog';
  // Most recently finished first: the order anyone looks for something by.
  const archiveTasks = tasks
    .filter(t => t.status === 'done' && finishedAt(t) < archiveBefore)
    .sort((a, b) => finishedAt(b) - finishedAt(a));

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

            {/* Scrollable card area. It runs to the column's bottom edge (or
                To Do's backlog footer) and fades out there, so cards flow out
                of view instead of being cut off. The bottom padding keeps a
                list that fits clear of the fade; the top leaves room for the
                drop line above the first card. */}
            <div
              ref={(el) => { scrollAreasRef.current[column.id] = el; }}
              className={`flex-1 overflow-y-auto max-h-[50vh] lg:max-h-none lg:min-h-0 pt-2.5 pb-6 [mask-image:linear-gradient(to_bottom,#000_calc(100%-1.5rem),transparent)] rounded-lg transition-colors duration-150 board-column-scroll ${
                isOverDifferentColumn ? 'bg-brand-500/15 ring-2 ring-brand-300 ring-dashed' : ''
              }`}
            >
              {renderCards(column.id, columnTasks, indicatorIndex)}

              {/* Drop target when column is empty and being dragged over */}
              {isOverDifferentColumn && columnTasks.length === 0 && (
                <div className="h-20 border-2 border-dashed border-brand-500/30 rounded-lg flex items-center justify-center">
                  <span className="text-sm text-brand-400">Drop here</span>
                </div>
              )}

              {/* Empty column state. An empty To Do with a backlog waiting
                  points at it: that is usually the moment to pull one up. */}
              {columnTasks.length === 0 && !isOverDifferentColumn && (
                column.id === 'todo' && backlogTasks.length > 0 ? (
                  <div className="py-8 text-center">
                    <p className="text-sm text-zinc-400">Nothing to do</p>
                    {backlogOpen ? (
                      <p className="mt-1.5 text-sm text-zinc-500">Drag one up from the backlog</p>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleBacklog(true)}
                        className="mt-1.5 text-sm text-brand-300 hover:text-brand-200 transition-colors rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500"
                      >
                        Pull one up from the backlog
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="py-8 text-center">
                    <p className="text-sm text-zinc-500">
                      {column.id === 'done' && archiveTasks.length > 0 ? 'Nothing finished this week' : 'No tasks'}
                    </p>
                  </div>
                )
              )}
            </div>

            {column.id === 'todo' && (
              <ColumnFooter
                listId="board-backlog"
                label="Backlog"
                dropLabel="Drop to move to backlog"
                // The backlog status dot: dashed, as in List and the status pickers.
                dot={`border border-dashed ${shelving ? 'border-brand-300' : 'border-zinc-400'}`}
                count={backlogTasks.length}
                open={backlogOpen}
                animates={trayAnimates}
                onToggle={() => toggleBacklog()}
                // With To Do empty the backlog takes most of the column, leaving
                // To Do just enough room to drop a card into. An empty backlog
                // only needs room for its hint.
                openBasis={backlogTasks.length === 0 ? 'lg:basis-44' : columnTasks.length === 0 ? 'lg:basis-[72%]' : 'lg:basis-[58%]'}
                dropping={shelving}
                inviting={backlogInvites}
                dragHandlers={{ onDragOver: handleBacklogDragOver, onDragLeave: handleBacklogDragLeave, onDrop: handleBacklogDrop }}
                scrollRef={(el) => { scrollAreasRef.current.backlog = el; }}
              >
                {backlogTasks.length > 0
                  ? renderCards('backlog', backlogTasks, backlogIndicator)
                  : (
                    <div className="py-4 px-4 text-center">
                      <p className="text-sm text-zinc-400">Nothing saved for later</p>
                      <p className="mt-1 text-xs text-zinc-500">Drag a task here to keep it without committing to it.</p>
                    </div>
                  )}
              </ColumnFooter>
            )}

            {/* Nothing old enough yet, no footer: it takes no drops, so an
                empty one would only be noise. */}
            {column.id === 'done' && archiveTasks.length > 0 && (
              <ColumnFooter
                listId="board-archive"
                label="Archive"
                // Done's dot, quieter: still done, just not this week.
                dot="bg-emerald-500/40"
                count={archiveTasks.length}
                open={archiveOpen}
                animates={trayAnimates}
                onToggle={toggleArchive}
                openBasis={columnTasks.length === 0 ? 'lg:basis-[72%]' : 'lg:basis-[58%]'}
                scrollRef={(el) => { scrollAreasRef.current.archive = el; }}
              >
                {renderCards(null, archiveTasks, null)}
              </ColumnFooter>
            )}
          </section>
        );
      })}
    </div>
  );
}
