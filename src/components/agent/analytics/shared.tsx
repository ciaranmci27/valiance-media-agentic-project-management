'use client';

import type { LucideIcon } from 'lucide-react';
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
 * One color and one plain label per runtime line. Color is never the only
 * cue: every place that shows a line also prints its name.
 */
export const LINE_STYLE: Record<TimeLine, { label: string; bar: string; dot: string; text: string; hint: string }> = {
  work: {
    label: 'Work', bar: 'bg-emerald-500', dot: 'bg-emerald-500', text: 'text-emerald-400',
    hint: 'Turns that changed something: any tool call beyond reading. Every directed (Telegram) turn is work.',
  },
  rework: {
    label: 'Rework on approved work', bar: 'bg-amber-400', dot: 'bg-amber-400', text: 'text-amber-400',
    hint: 'Work on a task whose pull request was already approved when the turn began. Real work, but it should not have been needed.',
  },
  blocked: {
    label: 'Blocked', bar: 'bg-red-400', dot: 'bg-red-400', text: 'text-red-400',
    hint: 'Turns that found nothing to do and logged a blocked event or replied BLOCKED.',
  },
  waiting: {
    label: 'Waiting on Ciaran', bar: 'bg-violet-400', dot: 'bg-violet-400', text: 'text-violet-300',
    hint: 'Turns that found the work parked on Ciaran and replied HEARTBEAT_OK.',
  },
  idle: {
    label: 'Idle checks', bar: 'bg-zinc-400', dot: 'bg-zinc-400', text: 'text-zinc-300',
    hint: 'Scheduled checks that found nothing to do (PICKUP_IDLE, REVIEW_IDLE, SWEEP_CLEAN, NO_WORK).',
  },
  skipped: {
    label: 'Skipped by gate', bar: 'bg-slate-500', dot: 'bg-slate-500', text: 'text-slate-300',
    hint: 'Fires the cron gate skipped before the model ran.',
  },
  unknown: {
    label: 'Unknown', bar: 'bg-zinc-600', dot: 'bg-zinc-600', text: 'text-zinc-400',
    hint: 'The host could not read the session, so the turn is published without a guess.',
  },
  unlabelled: {
    label: 'Unlabelled', bar: 'bg-zinc-700', dot: 'bg-zinc-700', text: 'text-zinc-400',
    hint: 'Scheduled turns published before outcomes existed. Never counted as work or idle; a backfill can label them.',
  },
  failed: {
    label: 'Failed', bar: 'bg-rose-600', dot: 'bg-rose-600', text: 'text-rose-400',
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
      <div className="px-5 py-4 border-b border-white/[0.06] flex items-center justify-between gap-3 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h2 className="font-semibold text-white truncate">{title}</h2>
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
      {/* Focusable so keyboard users reach the definition too (the tooltip opens on focus). */}
      <span tabIndex={0}
        className={`cursor-help underline decoration-dotted decoration-zinc-600 underline-offset-4 rounded focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 ${className}`}>
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
