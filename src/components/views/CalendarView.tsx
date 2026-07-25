'use client';

import { useState, useMemo } from 'react';
import { Task } from '@/lib/types';
import { ChevronLeft, ChevronRight, AlertCircle } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { parseDateOnly } from '@/lib/date-utils';

interface CalendarViewProps {
  tasks: Task[];
  onViewTask?: (task: Task) => void;
  onEditTask?: (task: Task) => void;
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-500',
  low: 'bg-zinc-400',
};

const STATUS_STYLE: Record<string, { bg: string; text: string; border: string }> = {
  done: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', border: 'border-l-emerald-500' },
  in_progress: { bg: 'bg-brand-500/15', text: 'text-brand-300', border: 'border-l-brand-500' },
  in_review: { bg: 'bg-amber-500/15', text: 'text-amber-300', border: 'border-l-amber-500' },
  todo: { bg: 'bg-white/[0.03]', text: 'text-zinc-300', border: 'border-l-zinc-400' },
};

export function CalendarView({ tasks, onViewTask }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [expandedDay, setExpandedDay] = useState<number | null>(null);

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startingDay = firstDayOfMonth.getDay();
  const daysInMonth = lastDayOfMonth.getDate();

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
    setExpandedDay(null);
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
    setExpandedDay(null);
  };

  const goToToday = () => {
    setCurrentDate(new Date());
    setExpandedDay(null);
  };

  const monthName = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Normalize due_date to YYYY-MM-DD for robust matching. Date-only strings
  // must be parsed as local time or the calendar shifts a day west of UTC.
  const normalizeDate = (dateStr: string | null): string | null => {
    if (!dateStr) return null;
    const d = parseDateOnly(dateStr);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // Pre-compute a map of day → tasks for the current month
  const tasksByDay = useMemo(() => {
    const map: Record<number, Task[]> = {};
    for (const task of tasks) {
      const norm = normalizeDate(task.due_date);
      if (!norm) continue;
      const [y, m, d] = norm.split('-').map(Number);
      if (y === year && m === month + 1) {
        if (!map[d]) map[d] = [];
        map[d].push(task);
      }
    }
    // Sort each day's tasks: overdue first, then by priority
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
    for (const d of Object.keys(map)) {
      map[Number(d)].sort((a, b) => {
        const pa = priorityOrder[a.priority as keyof typeof priorityOrder] ?? 2;
        const pb = priorityOrder[b.priority as keyof typeof priorityOrder] ?? 2;
        return pa - pb;
      });
    }
    return map;
  }, [tasks, year, month]);

  // Tasks without a due date
  const unscheduledTasks = useMemo(() => tasks.filter(t => !t.due_date), [tasks]);

  // Count scheduled tasks this month
  const scheduledCount = useMemo(
    () => Object.values(tasksByDay).reduce((sum, arr) => sum + arr.length, 0),
    [tasksByDay],
  );

  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const todayDate = today.getDate();

  const isToday = (day: number) => todayYear === year && todayMonth === month && todayDate === day;
  const isPast = (day: number) => {
    if (year < todayYear) return true;
    if (year === todayYear && month < todayMonth) return true;
    if (year === todayYear && month === todayMonth && day < todayDate) return true;
    return false;
  };
  const isCurrentMonth = todayYear === year && todayMonth === month;
  const isWeekend = (dayOfWeek: number) => dayOfWeek === 0 || dayOfWeek === 6;

  const hasOverdueTasks = (day: number, dayTasks: Task[]) => {
    if (!isPast(day)) return false;
    return dayTasks.some(t => t.status !== 'done');
  };

  const isDueToday = (day: number) => isToday(day);
  const isDueTomorrow = (day: number) => {
    const tomorrow = new Date(todayYear, todayMonth, todayDate + 1);
    return year === tomorrow.getFullYear() && month === tomorrow.getMonth() && day === tomorrow.getDate();
  };

  const MAX_VISIBLE = 3;

  // Build day cells
  const days = [];
  // Empty cells for days before the 1st
  for (let i = 0; i < startingDay; i++) {
    days.push(
      <div key={`empty-${i}`} className={`min-h-[5rem] lg:min-h-[7rem] ${isWeekend(i) ? 'bg-white/[0.03]' : 'bg-white/[0.03]'} border-b border-r border-white/[0.06]`} />,
    );
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dayTasks = tasksByDay[day] || [];
    const dayOfWeek = (startingDay + day - 1) % 7;
    const todayHighlight = isToday(day);
    const past = isPast(day);
    const overdue = hasOverdueTasks(day, dayTasks);
    const dueToday = isDueToday(day) && dayTasks.some(t => t.status !== 'done');
    const dueTomorrow = isDueTomorrow(day) && dayTasks.some(t => t.status !== 'done');
    const isExpanded = expandedDay === day;
    const visibleTasks = isExpanded ? dayTasks : dayTasks.slice(0, MAX_VISIBLE);
    const hiddenCount = dayTasks.length - MAX_VISIBLE;

    days.push(
      <div
        key={day}
        className={`min-h-[5rem] lg:min-h-[7rem] p-1 lg:p-1.5 border-b border-r border-white/[0.06] transition-colors relative ${
          todayHighlight ? 'bg-brand-500/15' :
          isWeekend(dayOfWeek) ? 'bg-white/[0.03]' :
          past ? 'bg-white/[0.03]' :
          'bg-surface-raised'
        }`}
      >
        {/* Day number */}
        <div className="flex items-center justify-between mb-0.5 lg:mb-1">
          <div className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-semibold ${
            todayHighlight
              ? 'bg-brand-600 text-white'
              : past
                ? 'text-zinc-500'
                : 'text-zinc-300'
          }`}>
            {day}
          </div>
          {overdue && (
            <AlertCircle size={12} className="text-red-500 flex-shrink-0" />
          )}
          {dueToday && !overdue && (
            <span className="text-[10px] font-semibold text-amber-400 bg-amber-500/15 px-1 rounded">
              Due today
            </span>
          )}
          {dueTomorrow && !overdue && !dueToday && dayTasks.length > 0 && (
            <span className={`text-[10px] font-medium text-zinc-400`}>
              {dayTasks.length}
            </span>
          )}
          {dayTasks.length > 0 && !overdue && !dueToday && !dueTomorrow && (
            <span className={`text-[10px] font-medium ${past ? 'text-zinc-500' : 'text-zinc-400'}`}>
              {dayTasks.length}
            </span>
          )}
        </div>

        {/* Task items */}
        <div className="space-y-0.5">
          {visibleTasks.map((task) => {
            const style = STATUS_STYLE[task.status] || STATUS_STYLE.todo;
            const isDone = task.status === 'done';
            const taskOverdue = past && !isDone;
            const taskDueToday = dueToday && !isDone;

            return (
              <Tooltip key={task.id} content={`${task.title} - ${task.priority} priority`} position="bottom">
                <div
                  onClick={(e) => { e.stopPropagation(); onViewTask?.(task); }}
                  className={`flex items-center gap-1 text-[10px] lg:text-[11px] px-1.5 py-0.5 rounded border-l-2 truncate cursor-pointer hover:shadow-sm transition-shadow ${
                    taskOverdue
                      ? 'bg-red-500/15 text-red-300 border-l-red-500'
                      : taskDueToday
                      ? 'bg-amber-500/15 text-amber-300 border-l-amber-500 font-medium'
                      : `${style.bg} ${style.text} ${style.border}`
                  } ${isDone ? 'line-through opacity-60' : ''}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] || PRIORITY_DOT.medium}`} />
                  <span className="truncate">{task.title}</span>
                </div>
              </Tooltip>
            );
          })}
          {!isExpanded && hiddenCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpandedDay(day); }}
              className="text-[10px] text-brand-300 hover:text-brand-300 font-medium pl-1 hover:underline"
            >
              +{hiddenCount} more
            </button>
          )}
          {isExpanded && hiddenCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); setExpandedDay(null); }}
              className="text-[10px] text-zinc-400 hover:text-zinc-300 font-medium pl-1 hover:underline"
            >
              show less
            </button>
          )}
        </div>
      </div>,
    );
  }

  // Fill remaining cells to complete the last row
  const totalCells = startingDay + daysInMonth;
  const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
  for (let i = 0; i < remainingCells; i++) {
    const dayOfWeek = (totalCells + i) % 7;
    days.push(
      <div key={`trail-${i}`} className={`min-h-[5rem] lg:min-h-[7rem] ${isWeekend(dayOfWeek) ? 'bg-white/[0.03]' : 'bg-white/[0.03]'} border-b border-r border-white/[0.06]`} />,
    );
  }

  return (
    <div className="space-y-4">
      <div className="glass-card rounded-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-3 lg:p-4 border-b border-white/[0.08] bg-white/[0.03]">
          <div>
            <h3 className="text-base lg:text-lg font-semibold text-white">{monthName}</h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              {scheduledCount} task{scheduledCount !== 1 ? 's' : ''} scheduled
              {unscheduledTasks.length > 0 && (
                <span className="text-zinc-500"> &middot; {unscheduledTasks.length} unscheduled</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-1 lg:gap-2">
            {!isCurrentMonth && (
              <button
                onClick={goToToday}
                className="px-2 lg:px-3 py-1 text-xs lg:text-sm font-medium text-brand-300 hover:bg-brand-500/15 rounded-lg transition-colors"
              >
                Today
              </button>
            )}
            <button
              onClick={prevMonth}
              className="p-2 rounded-lg text-zinc-400 hover:bg-white/[0.06] transition-colors"
            >
              <ChevronLeft size={20} />
            </button>
            <button
              onClick={nextMonth}
              className="p-2 rounded-lg text-zinc-400 hover:bg-white/[0.06] transition-colors"
            >
              <ChevronRight size={20} />
            </button>
          </div>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 border-b border-white/[0.08]">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, i) => (
            <div
              key={day}
              className={`p-2 text-center text-xs font-medium bg-white/[0.03] ${
                isWeekend(i) ? 'text-zinc-500' : 'text-zinc-400'
              }`}
            >
              <span className="hidden lg:inline">{day}</span>
              <span className="lg:hidden">{day.charAt(0)}</span>
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="grid grid-cols-7">
          {days}
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 px-3 lg:px-4 py-2 border-t border-white/[0.06] bg-white/[0.03] flex-wrap">
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-red-500" /> Urgent
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-orange-500" /> High
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-blue-500" /> Medium
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
            <span className="w-2 h-2 rounded-full bg-zinc-400" /> Low
          </div>
          <div className="hidden lg:flex items-center gap-3 text-[10px] text-zinc-400 ml-auto">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" /> Due today
            </span>
            <span className="flex items-center gap-1.5">
              <AlertCircle size={10} className="text-red-500" /> Overdue
            </span>
          </div>
        </div>
      </div>

      {/* Unscheduled tasks */}
      {unscheduledTasks.length > 0 && (
        <div className="glass-card rounded-xl overflow-hidden">
          <div className="px-3 lg:px-4 py-2.5 bg-white/[0.03] border-b border-white/[0.08]">
            <h4 className="text-sm font-semibold text-zinc-300">
              No Due Date ({unscheduledTasks.length})
            </h4>
          </div>
          <div className="p-2 lg:p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {unscheduledTasks.map((task) => {
              const style = STATUS_STYLE[task.status] || STATUS_STYLE.todo;
              return (
                <div
                  key={task.id}
                  onClick={() => onViewTask?.(task)}
                  className={`flex items-center gap-2 text-xs px-2.5 py-2 rounded-lg border-l-2 cursor-pointer hover:shadow-sm transition-shadow ${style.bg} ${style.text} ${style.border}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${PRIORITY_DOT[task.priority] || PRIORITY_DOT.medium}`} />
                  <span className="truncate">{task.title}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
