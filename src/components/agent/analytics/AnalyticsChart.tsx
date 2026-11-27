'use client';

import { LineChart, type LinePoint } from '@/components/ui/LineChart';
import { formatMoney, formatMoneyCompact, formatNumber } from '@/lib/format';
import type { MetricFormat } from '@/lib/agent-analytics-model';
import { fmtCount, fmtDuration } from '@/components/agent/analytics/shared';

/**
 * The Analytics report's chart: the stat picked above it, as one brand line
 * over time (the shared LineChart, DESIGN.md Rule 16). A series that dips
 * below zero (profit with a loss) draws as bars on a zero line instead, in the
 * same brand color, since a line chart's axis starts at zero. Pure
 * presentation; the numbers come from agent-analytics-model.
 */

export interface ChartPoint {
  /** Short label for the axis ("Nov 3"). */
  label: string;
  /** Long label for the tooltip ("Mon, Nov 3"). */
  title: string;
  value: number;
}

export function formatMetric(value: number, format: MetricFormat): string {
  switch (format) {
    case 'currency': return formatMoney(value);
    case 'duration': return fmtDuration(value);
    case 'tokens': return fmtCount(value);
    case 'count': return formatNumber(value, { maximumFractionDigits: 0 });
  }
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * The axis unit for a series, and the factor its values are divided by so
 * the axis shows round numbers in that unit (hours, thousands of tokens).
 */
export function axisScale(format: MetricFormat, max: number, unit: string): { divide: number; unit: string } {
  if (format === 'duration') return max >= 2 * HOUR ? { divide: HOUR, unit: 'hours' } : { divide: MINUTE, unit: 'minutes' };
  if (format === 'tokens') {
    if (max >= 10_000_000) return { divide: 1_000_000, unit: 'million tokens' };
    if (max >= 10_000) return { divide: 1000, unit: 'thousand tokens' };
    return { divide: 1, unit: 'tokens' };
  }
  if (format === 'currency') {
    const symbol = formatMoney(0).replace(/[\d.,\s]/g, '') || '$';
    return { divide: 1, unit: symbol };
  }
  return { divide: 1, unit };
}

function SignedBars({ points, format, label }: { points: ChartPoint[]; format: MetricFormat; label: string }) {
  const max = Math.max(0, ...points.map((p) => p.value));
  const min = Math.min(0, ...points.map((p) => p.value));
  const span = Math.max(max - min, 0.0001);
  const zero = (max / span) * 100;
  const axis = (v: number) => (format === 'currency' && Math.abs(v) >= 1000 ? formatMoneyCompact(v) : formatMetric(v, format));
  return (
    <div role="img" aria-label={`${label}. Highest ${axis(max)}, lowest ${axis(min)}.`} className="flex h-[220px] flex-col">
      <p className="text-[11px] text-zinc-500 tabular-nums" aria-hidden="true">{axis(max)}</p>
      <div className="relative mt-1 flex-1">
        <div aria-hidden="true" className="absolute inset-x-0 border-t border-white/[0.15]" style={{ top: `${zero}%` }} />
        <div className="absolute inset-0 flex items-stretch gap-[3px]">
          {points.map((p) => {
            const h = (Math.abs(p.value) / span) * 100;
            return (
              <div key={p.title} className="group relative flex-1" title={`${p.title}: ${formatMetric(p.value, format)}`}>
                {p.value !== 0 && (
                  <div
                    className={`absolute inset-x-0 bg-brand-400 ${p.value > 0 ? 'rounded-t' : 'rounded-b opacity-60'}`}
                    style={p.value > 0 ? { bottom: `${100 - zero}%`, height: `${h}%` } : { top: `${zero}%`, height: `${h}%` }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <span aria-hidden="true" className="absolute bottom-0 left-0 text-[11px] text-zinc-500 tabular-nums">{axis(min)}</span>
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-zinc-500 tabular-nums" aria-hidden="true">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export function AnalyticsChart({ title, note, points, format, unit, loading, empty }: {
  /** The question the chart answers, in plain words ("Runs per day, last 30 days"). */
  title: string;
  /** One quiet line beside the title: what the figures leave out. */
  note?: string | null;
  points: ChartPoint[];
  format: MetricFormat;
  /** The count's unit ("runs"); durations, tokens and money pick their own. */
  unit: string;
  loading: boolean;
  /** What will appear here, when the range holds nothing for this stat. */
  empty: string;
}) {
  const hasData = points.some((p) => p.value !== 0);
  const signed = points.some((p) => p.value < 0);
  const scale = axisScale(format, Math.max(0, ...points.map((p) => Math.abs(p.value))), unit);
  const linePoints: LinePoint[] = points.map((p) => ({ label: p.label, title: p.title, value: p.value / scale.divide }));
  return (
    <div className="min-w-0 border-t border-white/[0.06] pt-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        {note && !loading && <p className="text-[11px] text-zinc-500">{note}</p>}
      </div>
      {signed && !loading ? (
        <SignedBars points={points} format={format} label={title} />
      ) : (
        <LineChart
          points={hasData ? linePoints : []}
          format={(v) => formatMetric(v * scale.divide, format)}
          unit={scale.unit}
          label={title}
          empty={empty}
          loading={loading}
        />
      )}
    </div>
  );
}
