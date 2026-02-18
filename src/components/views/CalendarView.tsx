'use client';

import { useState, useMemo } from 'react';
import { Task } from '@/lib/types';
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react';

interface CalendarViewProps {
  tasks: Task[];
  onEditTask?: (task: Task) => void;
}

export function CalendarView({ tasks, onEditTask }: CalendarViewProps) {
  const [currentDate, setCurrentDate] = useState(new Date());

  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();

  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  const startingDay = firstDayOfMonth.getDay();
  const daysInMonth = lastDayOfMonth.getDate();

  const prevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const nextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  const goToToday = () => {
    setCurrentDate(new Date());
  };

  const monthName = currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const getTasksForDay = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return tasks.filter(t => t.due_date === dateStr);
  };

  const isToday = (day: number) => {
    const today = new Date();
    return today.getFullYear() === year && 
           today.getMonth() === month && 
           today.getDate() === day;
  };

  const isCurrentMonth = () => {
    const today = new Date();
    return today.getFullYear() === year && today.getMonth() === month;
  };

  const days = [];
  // Empty cells for days before the 1st of the month
  for (let i = 0; i < startingDay; i++) {
    days.push(<div key={`empty-${i}`} className="h-20 lg:h-24 bg-zinc-50/50" />);
  }
  
  // Days of the month
  for (let day = 1; day <= daysInMonth; day++) {
    const dayTasks = getTasksForDay(day);
    days.push(
      <div 
        key={day}
        className={`h-20 lg:h-24 p-1 border border-zinc-100 overflow-y-auto ${
          isToday(day) ? 'bg-indigo-50' : 'bg-white'
        }`}
      >
        <div className={`text-xs font-medium mb-1 ${
          isToday(day) ? 'text-indigo-600' : 'text-zinc-500'
        }`}>
          {day}
        </div>
        <div className="space-y-0.5">
          {dayTasks.slice(0, 3).map((task) => (
            <div
              key={task.id}
              onClick={() => onEditTask?.(task)}
              className={`text-[10px] px-1 py-0.5 rounded truncate cursor-pointer hover:opacity-80 ${
                task.status === 'done' ? 'bg-emerald-100 text-emerald-700' :
                task.status === 'in_progress' ? 'bg-indigo-100 text-indigo-700' :
                task.status === 'in_review' ? 'bg-amber-100 text-amber-700' :
                'bg-zinc-100 text-zinc-600'
              }`}
            >
              {task.title}
            </div>
          ))}
          {dayTasks.length > 3 && (
            <div className="text-[10px] text-zinc-400 pl-1">
              +{dayTasks.length - 3} more
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-zinc-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 lg:p-4 border-b border-zinc-200 bg-zinc-50">
        <h3 className="text-base lg:text-lg font-semibold text-zinc-900">{monthName}</h3>
        <div className="flex items-center gap-1 lg:gap-2">
          {!isCurrentMonth() && (
            <button
              onClick={goToToday}
              className="px-2 lg:px-3 py-1 text-xs lg:text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              Today
            </button>
          )}
          <button
            onClick={prevMonth}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-colors"
          >
            <ChevronLeft size={20} />
          </button>
          <button
            onClick={nextMonth}
            className="p-2 rounded-lg text-zinc-500 hover:bg-zinc-100 transition-colors"
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 border-b border-zinc-200">
        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
          <div key={day} className="p-2 text-center text-xs font-medium text-zinc-500 bg-zinc-50">
            <span className="hidden lg:inline">{day}</span>
            <span className="lg:hidden">{day.charAt(0)}</span>
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7">
        {days}
      </div>
    </div>
  );
}
