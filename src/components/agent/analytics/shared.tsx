'use client';

import { useId, useState } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { StatStrip, type Stat as StripStat } from '@/components/ui/StatStrip';
import { formatNumber } from '@/lib/format';
import { appLocale } from '@/lib/region';

/**
 * Presentation shared by the Agent Analytics cards (core's, and an install's
 * own in src/custom). Every number comes from a read model; these only format
 * and frame them.
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
  if (Math.abs(value) >= 1_000_000) return `${scaled(value / 1_000_000, value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(value) >= 10_000) return `${scaled(value / 1000, value % 1000 === 0 ? 0 : 1)}K`;
  return formatNumber(Math.round(value), { maximumFractionDigits: 0 });
}

/** A scaled count with fixed decimals, in the workspace locale ("1.5", "1,5"). */
function scaled(value: number, digits: number): string {
  return formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(share: number): string {
  const pct = share * 100;
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
}

export function fmtSeconds(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)}s` : fmtDuration(seconds * 1000);
}

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(appLocale(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function fmtDay(ms: number): string {
  return new Date(ms).toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
}

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

/** A card's headline number: `hint` defines the label on hover and focus. */
export type CardStat = Omit<StripStat, 'label' | 'id'> & { label: string; hint?: string };

/**
 * The one way a card states its headline numbers: a bare stat strip, so they
 * read as one row on a wide card and a label and value list on a narrow one.
 * A null value shows `empty` (default "Not measured") muted, so a missing
 * measurement never looks like 0.
 */
export function CardStats({ stats }: { stats: (CardStat | false | null | undefined)[] }) {
  return (
    <StatStrip
      bare
      stats={stats.map((stat) => {
        if (!stat) return null;
        const { label, hint, empty, ...rest } = stat;
        return {
          ...rest,
          id: label,
          label: hint ? <Defined hint={hint}>{label}</Defined> : label,
          empty: empty ?? 'Not measured',
        };
      })}
    />
  );
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
