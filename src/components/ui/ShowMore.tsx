'use client';

import { ChevronDown } from 'lucide-react';

/**
 * The end of every long list (DESIGN.md Rule 4): "Show 24 more of 76".
 * Never "Load more", "Show all" or page numbers. Renders nothing once
 * everything shows. `step` is how many the next click adds.
 */
export function ShowMore({ shown, total, step = 24, onMore, noun, className = '' }: {
  /** How many rows show now. */
  shown: number;
  /** How many there are in all. */
  total: number;
  /** How many one click adds (capped at what is left). */
  step?: number;
  onMore: () => void;
  /** Optional noun for screen readers ("tasks"). */
  noun?: string;
  className?: string;
}) {
  const left = total - shown;
  if (left <= 0) return null;
  const next = Math.min(step, left);
  return (
    <div className={`flex justify-center px-5 py-3 ${className}`}>
      <button
        type="button"
        onClick={onMore}
        aria-label={noun ? `Show ${next} more ${noun}, ${shown} of ${total} showing` : undefined}
        className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <ChevronDown size={13} aria-hidden="true" />
        <span className="tabular-nums">Show {next} more of {total}</span>
      </button>
    </div>
  );
}

/** How many to show at first, and the step after: the window ShowMore pages through. */
export const SHOW_MORE_STEP = 24;
