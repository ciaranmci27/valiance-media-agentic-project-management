'use client';

import { Repeat } from 'lucide-react';
import { repeatsLabel } from '@/lib/schedules';
import { Tooltip } from '@/components/ui/Tooltip';
import { useTaskRepeat } from './schedule-actions';

/** A small repeat mark on a task card or row whose task is the current one of a live repeat; its tooltip says how often. */
export function TaskRepeatIcon({ taskId, size = 14, className = '' }: { taskId: string; size?: number; className?: string }) {
  const repeat = useTaskRepeat(taskId);
  if (!repeat) return null;
  const words = `${repeatsLabel(repeat.recurrence)}${repeat.status === 'paused' ? ' (paused)' : ''}`;
  return (
    <Tooltip content={words} className="flex-shrink-0">
      <span role="img" aria-label={`Repeats: ${words}`} className={`flex items-center ${className}`}>
        <Repeat size={size} aria-hidden="true" />
      </span>
    </Tooltip>
  );
}
