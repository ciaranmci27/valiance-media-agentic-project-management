import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { Tooltip } from '@/components/ui/Tooltip';
import { Sparkline } from '@/components/ui/Sparkline';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface Stat {
  /** Sentence case, a few words. A string unless it carries a definition tooltip. */
  label: ReactNode;
  /** The figure. null shows `empty` muted, so a missing figure never reads as 0. */
  value: ReactNode | null;
  /** Shown muted in place of a null value. */
  empty?: ReactNode;
  /** One short line: a comparison, a unit, a hint. */
  context?: ReactNode;
  /** Colors the value with the status colors. */
  tone?: StatTone;
  /** A small icon beside the label. */
  icon?: LucideIcon;
  /** Makes the stat a link. */
  href?: string;
  /** Makes the stat a toggle button (aria-pressed), e.g. to pick what a chart shows. */
  onSelect?: () => void;
  selected?: boolean;
  /** A small trend line, shown beside the value once the strip is a row. */
  spark?: number[];
  /** React key when the label is not a plain string. */
  id?: string;
}

interface StatStripProps {
  /** Two to eight stats. Falsy entries are skipped, so a conditional stat is `cond && {...}`. */
  stats: (Stat | false | null | undefined)[];
  /** Inside a card already: no surface of its own, edges aligned to the card's content. */
  bare?: boolean;
  /** Values show as placeholders while the figures load; labels stay. */
  loading?: boolean;
  /** Names the list for screen readers. */
  label?: string;
  className?: string;
}

const TONES: Record<StatTone, string> = {
  default: 'text-white',
  success: 'text-emerald-300',
  warning: 'text-amber-300',
  danger: 'text-red-300',
  info: 'text-sky-300',
};

/** The rem steps the strip's widths snap up to (globals.css, strip-row and strip-line). */
const STEPS = [16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80, 88, 96];
/** Below this a strip stays a list even when a two-row grid would fit, so phones get the list. */
const GRID_MIN = 32;

function snap(rem: number) {
  return STEPS.find(step => step >= rem);
}

function textLength(node: ReactNode) {
  return typeof node === 'string' || typeof node === 'number' ? String(node).length : null;
}

/**
 * The widths (in rem) where the stats fit as columns without cutting off a
 * label or value: `row` for one line, `grid` for two rows when the count is
 * even. A rough measure from the text lengths: 12px labels, 20px values, a
 * sparkline beside the value. Context wraps to two lines, so it never sets
 * the width.
 */
function fitFor(items: Stat[], bare: boolean) {
  const anySpark = items.some(stat => stat.spark);
  const cell = Math.max(
    ...items.map(stat => {
      const labelChars = textLength(stat.label) ?? 14;
      const label = labelChars * 0.42 + (stat.icon ? 1.25 : 0);
      const valueChars = stat.value === null || stat.value === undefined ? 5 : textLength(stat.value) ?? 7;
      const value = valueChars * 0.72 + (anySpark ? 5.25 : 0);
      return Math.max(label, value, 5.5);
    }),
  ) + (bare ? 2 : 2.5);
  const count = items.length;
  const columns = count >= 4 && count % 2 === 0 ? count / 2 : null;
  const grid = columns ? snap(Math.max(GRID_MIN, columns * cell)) : undefined;
  return { row: snap(count * cell), grid, columns: columns ?? count };
}

/**
 * A row of numbers as one surface. Wide enough, the stats sit side by side
 * with hairlines between them: label, value, up to two lines of context, all
 * top aligned so labels and values share a line whatever the context. A
 * little narrower, an even count splits into two rows of columns. Narrower
 * still, the same strip is a list: label on the left, value on the right. It
 * never becomes a grid of separate tiles, so an odd stat is never left alone
 * on a row.
 */
export function StatStrip({ stats, bare = false, loading = false, label, className = '' }: StatStripProps) {
  const items = stats.filter((stat): stat is Stat => !!stat);
  if (items.length === 0) return null;
  const fit = fitFor(items, bare);

  return (
    <div
      data-row={fit.row}
      data-grid={fit.grid}
      style={{ '--strip-n': items.length, '--strip-g': fit.columns } as CSSProperties}
      className={`@container/stat-strip min-w-0 ${bare ? '' : 'glass-card rounded-xl overflow-hidden'} ${className}`}
    >
      <ul
        aria-label={label}
        aria-busy={loading || undefined}
        className={`flex flex-col divide-y divide-white/[0.06] [--strip-cols:var(--strip-g)] strip-row:grid strip-row:grid-cols-[repeat(var(--strip-cols),minmax(0,1fr))] strip-row:divide-y-0 strip-row:overflow-hidden strip-line:[--strip-cols:var(--strip-n)] ${
          // Bare strips line their stats up with the card's content edges.
          bare ? '-my-2.5 strip-row:-mx-4 strip-row:-my-3' : ''
        }`}
      >
        {items.map((stat, index) => {
          const key = stat.id ?? (typeof stat.label === 'string' ? stat.label : String(index));
          const Icon = stat.icon;
          const interactive = !!stat.href || !!stat.onSelect;
          const pad = bare ? 'py-2.5 strip-row:px-4 strip-row:py-3' : 'px-4 py-3 strip-row:px-5 strip-row:py-4';
          const cellClass = `grid h-full w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 text-left [grid-template-areas:'label_value''context_value'] strip-row:content-start strip-row:items-start strip-row:gap-x-3 strip-row:[grid-template-areas:'label_label''value_spark''context_context'] ${pad} ${
            interactive
              ? `transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500 ${
                  stat.selected ? 'bg-brand-500/[0.14]' : 'hover:bg-white/[0.03]'
                }`
              : ''
          }`;

          const body = (
            <>
              <span
                className={`[grid-area:label] flex min-w-0 items-center gap-1.5 text-sm strip-row:text-xs strip-row:font-medium ${
                  stat.selected ? 'text-brand-300' : 'text-zinc-300 strip-row:text-zinc-500'
                }`}
              >
                {Icon && <Icon size={14} className={`flex-shrink-0 ${stat.selected ? 'text-brand-400' : 'text-zinc-500'}`} aria-hidden="true" />}
                {typeof stat.label === 'string' && stat.label.length > 22 ? (
                  // A long label may be cut off: the full text shows below on hover.
                  <Tooltip content={stat.label} position="bottom" offset={12} className="min-w-0"><span className="block min-w-0 truncate">{stat.label}</span></Tooltip>
                ) : (
                  <span className="min-w-0 truncate">{stat.label}</span>
                )}
              </span>
              <span className="[grid-area:value] flex min-w-0 items-center justify-end gap-1.5 strip-row:mt-1 strip-row:justify-start">
                {loading ? (
                  <span className="inline-block h-5 w-14 rounded bg-white/[0.07] motion-safe:animate-pulse strip-row:my-1 strip-row:w-16" aria-hidden="true" />
                ) : stat.value === null || stat.value === undefined ? (
                  <span className="text-sm font-medium text-zinc-500 strip-row:leading-7">{stat.empty ?? 'None'}</span>
                ) : (
                  <span className={`min-w-0 truncate text-base font-semibold tabular-nums strip-row:text-xl strip-row:leading-7 strip-row:tracking-tight ${TONES[stat.tone ?? 'default']}`}>
                    {stat.value}
                  </span>
                )}
                {stat.href && <ChevronRight size={14} className="flex-shrink-0 text-zinc-600 strip-row:hidden" aria-hidden="true" />}
              </span>
              {stat.spark && !loading && (
                <span className="[grid-area:spark] hidden self-center strip-row:block">
                  <Sparkline data={stat.spark} className={stat.selected === false ? 'text-zinc-500' : 'text-brand-400'} />
                </span>
              )}
              {stat.context && !loading && (
                <span className="[grid-area:context] block min-w-0 truncate text-xs text-zinc-500 strip-row:mt-0.5 strip-row:line-clamp-2 strip-row:whitespace-normal">{stat.context}</span>
              )}
            </>
          );

          return (
            // In columns each stat draws a hairline on its left and top edge;
            // the list clips the ones on its outer edges.
            <li
              key={key}
              className="min-w-0 strip-row:[box-shadow:-1px_0_0_0_rgba(var(--ink),0.06),0_-1px_0_0_rgba(var(--ink),0.06)]"
            >
              {stat.href ? (
                <Link href={stat.href} className={cellClass}>{body}</Link>
              ) : stat.onSelect ? (
                <button type="button" onClick={stat.onSelect} aria-pressed={!!stat.selected} className={`${cellClass} cursor-pointer`}>
                  {body}
                </button>
              ) : (
                <div className={cellClass}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
