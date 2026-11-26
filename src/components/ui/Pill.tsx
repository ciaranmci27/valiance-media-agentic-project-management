'use client';

import type { ReactNode } from 'react';

/**
 * The one status label (DESIGN.md Rule 7): 11px, fully rounded, sentence
 * case, a soft fill, and an optional dot or small icon. Five tones only, each
 * read through the status ink tokens both themes define, so it reads in
 * light and dark without per-screen work. Money and counts are never pills.
 */

export type PillTone = 'neutral' | 'good' | 'waiting' | 'problem' | 'info';

export const PILL_TONES: readonly PillTone[] = ['neutral', 'good', 'waiting', 'problem', 'info'];

const TONE: Record<PillTone, string> = {
  neutral: 'bg-white/[0.06] text-zinc-300',
  good: 'bg-emerald-500/[0.14] text-emerald-300',
  waiting: 'bg-amber-500/[0.14] text-amber-300',
  problem: 'bg-red-500/[0.14] text-red-300',
  info: 'bg-brand-500/[0.14] text-brand-300',
};

/** The dot's own fill, a step stronger than the ink so it reads at 6px. */
const DOT: Record<PillTone, string> = {
  neutral: 'bg-zinc-400',
  good: 'bg-emerald-400',
  waiting: 'bg-amber-400',
  problem: 'bg-red-400',
  info: 'bg-brand-400',
};

export interface PillProps {
  children: ReactNode;
  tone?: PillTone;
  /** A 6px dot in the tone before the label. */
  dot?: boolean;
  /** A small lucide icon element (11px), shown before the label instead of a dot. */
  icon?: ReactNode;
  /** Extra classes for layout only (margins, truncation); never colors or sizes. */
  className?: string;
  /** Legacy: a raw color for a pill that names a record's own color (a project). */
  color?: string;
}

export function Pill({ children, tone = 'neutral', dot = false, icon, className = '', color }: PillProps) {
  return (
    <span
      className={`inline-flex max-w-full flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium leading-4 ${color ? '' : TONE[tone]} ${className}`}
      style={color ? { backgroundColor: `${color}20`, color } : undefined}
    >
      {icon ? (
        <span className="inline-flex flex-shrink-0 [&>svg]:h-[11px] [&>svg]:w-[11px]" aria-hidden="true">{icon}</span>
      ) : dot ? (
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${color ? 'bg-current' : DOT[tone]}`} aria-hidden="true" />
      ) : null}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

/** "in_progress" or "In Progress" as sentence case: "In progress". */
export function sentenceCase(value: string): string {
  const words = value.replace(/_/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
