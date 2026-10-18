'use client';

import { useId, useState } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import type { TimeLine } from '@/lib/agent-telemetry-analytics';

/**
 * Presentation shared by the Agent Analytics cards. Every number comes from
 * the read models (src/lib/agent-analytics.ts, agent-telemetry-analytics.ts);
 * these only format and frame them.
 */

/** Runtime reads in hours and minutes; milliseconds are a storage detail. */
export function fmtDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  if (totalMinutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Token and line counts get compact units; small values stay exact. */
export function fmtCount(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  return Math.round(value).toLocaleString('en-US');
}

export function fmtPct(share: number): string {
  const pct = share * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

export function fmtSeconds(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : fmtDuration(seconds * 1000);
}

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Display order of the runtime lines everywhere they appear together (chart
 * legend, tooltip and stack from the bottom; Time accounting's split bar):
 * work first, then the turns stuck on something (waiting, blocked, failed),
 * then the quiet lines. Display only: the overlap priority in TIME_LINES is
 * unchanged.
 */
export const LINE_ORDER: TimeLine[] = ['work', 'rework', 'waiting', 'blocked', 'failed', 'skipped', 'idle', 'unknown', 'unlabelled'];

// Unlabelled is the one line with no outcome at all, so it wears a stripe
// rather than a third flat gray (idle and unknown are the flat ones).
const UNLABELLED_STRIPE = 'bg-[repeating-linear-gradient(135deg,var(--color-zinc-500)_0_2px,transparent_2px_5px)]';

/**
 * One color and one plain label per runtime line. Color is never the only
 * cue: every place that shows a line also prints its name. The signal lines
 * use the validated runtime tokens in globals.css; the quiet ones are a light
 * gray (unknown), a mid gray (idle) and a gray stripe (unlabelled).
 */
export const LINE_STYLE: Record<TimeLine, { label: string; bar: string; dot: string; hint: string }> = {
  work: {
    label: 'Work', bar: 'bg-runtime-work', dot: 'bg-runtime-work',
    hint: 'Turns that changed something: any tool call beyond reading. Every directed (Telegram) turn is work.',
  },
  rework: {
    label: 'Rework on approved work', bar: 'bg-runtime-rework', dot: 'bg-runtime-rework',
    hint: 'Work on a task whose pull request was already approved when the turn began. Real work, but it should not have been needed.',
  },
  waiting: {
    label: 'Waiting on a person', bar: 'bg-runtime-waiting', dot: 'bg-runtime-waiting',
    hint: 'Turns that found the work parked on a person (a review, an answer, an approval) and replied HEARTBEAT_OK.',
  },
  blocked: {
    label: 'Blocked', bar: 'bg-runtime-blocked', dot: 'bg-runtime-blocked',
    hint: 'Turns that found nothing to do and logged a blocked event or replied BLOCKED.',
  },
  skipped: {
    label: 'Skipped by gate', bar: 'bg-runtime-skipped', dot: 'bg-runtime-skipped',
    hint: 'Fires the cron gate skipped before the model ran.',
  },
  idle: {
    label: 'Idle checks', bar: 'bg-zinc-500', dot: 'bg-zinc-500',
    hint: 'Scheduled checks that found nothing to do (PICKUP_IDLE, REVIEW_IDLE, SWEEP_CLEAN, NO_WORK).',
  },
  unknown: {
    label: 'Unknown', bar: 'bg-zinc-300', dot: 'bg-zinc-300',
    hint: 'The host could not read the session, so the turn is published without a guess.',
  },
  unlabelled: {
    label: 'Unlabelled', bar: UNLABELLED_STRIPE, dot: UNLABELLED_STRIPE,
    hint: 'Scheduled turns published before outcomes existed. Never counted as work or idle; a backfill can label them.',
  },
  failed: {
    label: 'Failed', bar: 'bg-runtime-failed', dot: 'bg-runtime-failed',
    hint: 'Fires that did not end cleanly and have no completed turn (a completed-with-error turn is counted under its outcome).',
  },
};

/** A card in the page's glass language, with its title row. */
export function Card({
  icon: Icon,
  title,
  aside,
  children,
  className = '',
}: {
  icon: LucideIcon;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass-card rounded-xl overflow-hidden flex flex-col ${className}`} aria-label={title}>
      <div className="px-5 py-3.5 border-b border-white/[0.06] flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={16} className="text-zinc-500 flex-shrink-0" aria-hidden="true" />
          {/* h3: cards sit under the page's section headings (h2). */}
          <h3 className="text-sm font-semibold text-white truncate">{title}</h3>
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The card body while figures are measured: held height, no fake numbers. */
export function CardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="p-5 space-y-3" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-5 w-full rounded bg-white/[0.05] motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

/** An empty state that names what is missing, never a zero standing in for it. */
export function Missing({ children }: { children: React.ReactNode }) {
  return <p className="px-5 py-6 text-sm text-zinc-500 text-center">{children}</p>;
}

/** A sub-heading inside a card. */
export function Label({ children }: { children: React.ReactNode }) {
  // A div, not a p: a definition's tooltip trigger is a div.
  return <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500 mb-2">{children}</div>;
}

/** A label with a definition on hover and focus. */
export function Defined({ hint, children, className = '' }: { hint: string; children: React.ReactNode; className?: string }) {
  return (
    <Tooltip content={<span className="block max-w-[260px] whitespace-normal">{hint}</span>}>
      {/* Focusable so keyboard users reach the definition too (the tooltip
          opens on focus). The underline appears on hover and focus only, so a
          card full of defined labels does not read as a page of links. */}
      <span tabIndex={0}
        className={`cursor-help decoration-dotted decoration-zinc-500 underline-offset-4 hover:underline focus-visible:underline rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${className}`}>
        {children}
      </span>
    </Tooltip>
  );
}

/** A label/value row. */
export function Stat({ label, value, sub, valueClass = 'text-white' }: {
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-zinc-400 min-w-0">{label}</span>
      <span className="text-right flex-shrink-0">
        <span className={`text-sm font-semibold ${valueClass}`}>{value}</span>
        {sub && <span className="block text-[11px] text-zinc-500">{sub}</span>}
      </span>
    </div>
  );
}

/**
 * The one way a card states a headline number: small label, large value, one
 * line of context. `hint` defines the label on hover and focus. A value of
 * null renders `empty` muted, so a missing measurement never looks like 0.
 */
export function MiniStat({ label, hint, value, sub, empty = 'Not measured', valueClass = 'text-white' }: {
  label: string;
  hint?: string;
  value: React.ReactNode | null;
  sub?: React.ReactNode;
  empty?: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-zinc-500 truncate">
        {hint ? <Defined hint={hint}>{label}</Defined> : label}
      </div>
      {value === null ? (
        <p className="text-sm font-medium text-zinc-500 mt-1.5">{empty}</p>
      ) : (
        <p className={`text-xl font-semibold tracking-tight mt-1 leading-tight tabular-nums ${valueClass}`}>{value}</p>
      )}
      {sub && <p className="text-[11px] text-zinc-500 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

/** A row of MiniStats with even columns that wrap on phones. */
export function StatRow({ children, columns = 3 }: { children: React.ReactNode; columns?: 2 | 3 | 4 }) {
  const cols = { 2: 'grid-cols-2', 3: 'grid-cols-2 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[columns];
  return <div className={`grid ${cols} gap-x-4 gap-y-4`}>{children}</div>;
}

/**
 * Detail that most visits do not need (error text, every restart, model
 * history) folded behind a labelled toggle, so the card reads as a summary
 * first. The count says how much is behind it.
 */
export function Disclosure({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="border-t border-white/[0.06] pt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 text-left rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <span className="text-xs font-medium text-zinc-400">
          {label}
          {typeof count === 'number' && <span className="ml-1.5 text-zinc-500 tabular-nums">{count}</span>}
        </span>
        <ChevronDown size={14} className={`text-zinc-500 transition-transform duration-150 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && <div id={id} className="mt-3">{children}</div>}
    </div>
  );
}
