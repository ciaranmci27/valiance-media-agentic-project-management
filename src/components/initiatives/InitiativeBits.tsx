'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { CheckCircle2, Layers } from 'lucide-react';
import type { Initiative, Task } from '@/lib/types';
import {
  INITIATIVE_LABEL, initiativeHealthLabel, initiativeStatusLabel, progressLabel, progressPercent, type InitiativeProgress,
} from '@/lib/initiatives';
import { parseDateOnly } from '@/lib/date-utils';
import { appLocale } from '@/lib/region';
import { Tooltip } from '@/components/ui/Tooltip';

/**
 * Small pieces every initiative screen shares: the status pill, the progress
 * bar, the tag on a task card or row, and the names the tags read from.
 */

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'muted';

const TONE: Record<Tone, string> = {
  neutral: 'bg-white/[0.06] text-zinc-300',
  muted: 'bg-white/[0.04] text-zinc-400',
  brand: 'bg-brand-500/15 text-brand-300',
  success: 'bg-emerald-500/[0.14] text-emerald-300',
  warning: 'bg-amber-500/[0.14] text-amber-300',
  danger: 'bg-red-500/[0.14] text-red-300',
};

function stateTone(initiative: Pick<Initiative, 'status' | 'health'>): Tone {
  if (initiative.status === 'done') return 'success';
  if (initiative.status === 'paused') return 'muted';
  if (initiative.status === 'planned') return 'neutral';
  if (initiative.health === 'blocked') return 'danger';
  if (initiative.health === 'at_risk') return 'warning';
  if (initiative.health === 'on_track') return 'success';
  return 'brand';
}

/** "Active · At risk", "Planned", "Done": status, plus health while active. */
export function InitiativeStatusPill({ initiative, size = 'sm' }: { initiative: Pick<Initiative, 'status' | 'health'>; size?: 'sm' | 'md' }) {
  const health = initiativeHealthLabel(initiative);
  return (
    <span
      className={`inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-medium ${TONE[stateTone(initiative)]} ${
        size === 'md' ? 'px-2.5 py-1 text-xs' : 'px-2 py-0.5 text-[11px]'
      }`}
    >
      {initiative.status === 'done' && <CheckCircle2 size={size === 'md' ? 13 : 11} aria-hidden="true" />}
      {initiativeStatusLabel(initiative.status)}
      {health && (
        <>
          <span aria-hidden="true" className="opacity-60">·</span>
          <span className="sr-only">, </span>
          {health}
        </>
      )}
    </span>
  );
}

/** A bar and "3 of 8 tasks done". */
export function InitiativeProgressBar({ progress, done, className = '' }: { progress: InitiativeProgress; done?: boolean; className?: string }) {
  const percent = progressPercent(progress);
  return (
    <div className={`flex min-w-0 items-center gap-2.5 ${className}`}>
      <span
        className="h-1.5 min-w-[4rem] flex-1 overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Tasks done"
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none ${done || percent === 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="flex-shrink-0 text-xs tabular-nums text-zinc-400">{progressLabel(progress)}</span>
    </div>
  );
}

/** A calendar date as "Mar 14" (this year) or "Mar 14, 2027". */
export function shortDay(date: string): string {
  const day = parseDateOnly(date);
  const sameYear = day.getFullYear() === new Date().getFullYear();
  return day.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "Mar 1 to Apr 30", "Due Apr 30", "Starts Mar 1", or null with neither. */
export function initiativeDatesLabel(initiative: Pick<Initiative, 'start_date' | 'target_date'>): string | null {
  const { start_date: start, target_date: target } = initiative;
  if (start && target) return `${shortDay(start)} to ${shortDay(target)}`;
  if (target) return `Target ${shortDay(target)}`;
  if (start) return `Starts ${shortDay(start)}`;
  return null;
}

// ── Tags on task cards and rows ─────────────────────────────────────────

/** Live initiative names by id. Empty means no tags (an initiative's own board). */
const InitiativeNamesContext = createContext<ReadonlyMap<string, string>>(new Map());

export function InitiativeNamesProvider({ names, children }: { names: ReadonlyMap<string, string>; children: ReactNode }) {
  return <InitiativeNamesContext.Provider value={names}>{children}</InitiativeNamesContext.Provider>;
}

/** The live initiative a task reads as being in, by name; null with none, or one in Trash. */
export function useTaskInitiativeName(task: Pick<Task, 'initiative_id'>): string | null {
  const names = useContext(InitiativeNamesContext);
  return task.initiative_id ? names.get(task.initiative_id) ?? null : null;
}

/** The small tag: the initiative's name, quiet, truncating. */
export function InitiativeTag({ name, className = '' }: { name: string; className?: string }) {
  return (
    <Tooltip content={`${INITIATIVE_LABEL.singular}: ${name}`} className={`min-w-0 max-w-full ${className}`}>
      <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-white/[0.05] px-1.5 py-0.5 text-[11px] leading-tight text-zinc-300">
        <Layers size={10} className="flex-shrink-0 text-zinc-400" aria-hidden="true" />
        <span className="sr-only">{INITIATIVE_LABEL.singular}: </span>
        <span className="truncate">{name}</span>
      </span>
    </Tooltip>
  );
}
