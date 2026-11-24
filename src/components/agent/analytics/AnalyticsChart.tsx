'use client';

import { useMemo, useRef } from 'react';
import { TrendingUp } from 'lucide-react';
import { formatMoney, formatMoneyCompact, formatNumber } from '@/lib/format';
import type { MetricFormat } from '@/lib/agent-analytics-model';
import { fmtCount, fmtDuration } from '@/components/agent/analytics/shared';

/**
 * The Analytics tab's main chart: one metric per day (or week, or month),
 * stacked by series. Signed values (profit) draw below a zero line. Pure
 * presentation; the numbers come from agent-analytics-model.
 */

export interface ChartSeries {
  id: string;
  name: string;
  bar: string;
  dot: string;
}

export interface ChartBar {
  startKey: string;
  label: string;
  /** Long form for the tooltip ("Mon, Nov 3"). */
  title: string;
  values: Map<string, number>;
}

/** ~4 rounded axis ticks from 0 to just past maxVal. Whole steps for counts, minutes or hours for durations. */
export function axisTicks(maxVal: number, format: MetricFormat): number[] {
  if (maxVal <= 0) return [0];
  if (format === 'duration') {
    const unit = maxVal >= 4 * 3_600_000 ? 3_600_000 : 60_000;
    const step = Math.max(1, Math.ceil(maxVal / unit / 4)) * unit;
    const ticks: number[] = [0];
    let v = step;
    while (v < maxVal * 1.05) { ticks.push(v); v += step; }
    ticks.push(v);
    return ticks;
  }
  const whole = format === 'count' || format === 'tokens';
  if (whole && maxVal <= 4) return Array.from({ length: Math.ceil(maxVal) + 1 }, (_, i) => i);
  const rawStep = maxVal / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const residual = rawStep / mag;
  let step = residual <= 1.5 ? mag : residual <= 3.5 ? 2 * mag : residual <= 7.5 ? 5 * mag : 10 * mag;
  if (whole) step = Math.max(1, Math.round(step));
  const ticks: number[] = [0];
  let v = step;
  while (v <= maxVal * 1.05) { ticks.push(v); v += step; }
  if (ticks[ticks.length - 1] < maxVal) ticks.push(v);
  return ticks;
}

export function formatMetric(value: number, format: MetricFormat): string {
  switch (format) {
    case 'currency': return formatMoney(value);
    case 'duration': return fmtDuration(value);
    case 'tokens': return fmtCount(value);
    case 'count': return formatNumber(value, { maximumFractionDigits: 0 });
  }
}

function fmtAxis(value: number, format: MetricFormat): string {
  if (format === 'duration') return value === 0 ? '0' : fmtDuration(value);
  if (format === 'currency') return Math.abs(value) >= 1000 ? formatMoneyCompact(value) : formatMoney(value);
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${value < 0 ? '-' : ''}${formatNumber(abs / 1_000_000, { maximumFractionDigits: 1 })}M`;
  if (abs >= 1000) return `${value < 0 ? '-' : ''}${formatNumber(abs / 1000, { maximumFractionDigits: abs % 1000 === 0 ? 0 : 1 })}K`;
  return formatNumber(value, { maximumFractionDigits: 2 });
}

export function AnalyticsChart({
  title,
  aside,
  note,
  bars,
  series,
  format,
  loading,
  empty,
}: {
  title: string;
  aside?: string;
  /** One quiet line under the header: what the figures leave out. */
  note?: string | null;
  bars: ChartBar[];
  series: ChartSeries[];
  format: MetricFormat;
  loading: boolean;
  empty: { title: string; detail: string };
}) {
  // The labels row mirrors the bars' horizontal scroll on phones.
  const labelsScrollRef = useRef<HTMLDivElement>(null);

  const totals = useMemo(() => bars.map((bar) => {
    let pos = 0;
    let neg = 0;
    for (const v of bar.values.values()) { if (v > 0) pos += v; else neg += v; }
    return { pos, neg };
  }), [bars]);
  const posMax = Math.max(0, ...totals.map((t) => t.pos));
  const negMin = Math.min(0, ...totals.map((t) => t.neg));
  const hasData = totals.some((t) => t.pos > 0 || t.neg < 0);

  const ticks = useMemo(() => {
    const positive = axisTicks(Math.max(posMax, 1), format);
    if (negMin >= 0) return positive;
    return [...axisTicks(Math.abs(negMin), format).slice(1).map((v) => -v).reverse(), ...positive];
  }, [posMax, negMin, format]);
  const axisMin = Math.min(0, ticks[0] ?? 0);
  const axisMax = Math.max(ticks[ticks.length - 1] ?? 1, 1);
  const axisRange = axisMax - axisMin;
  const zeroPct = (Math.abs(axisMin) / axisRange) * 100;
  const posArea = (axisMax / axisRange) * 100;
  const negArea = (Math.abs(axisMin) / axisRange) * 100;

  return (
    <div className="glass-card rounded-xl overflow-hidden flex flex-col min-h-[360px]">
      <div className="px-5 py-4 flex items-center justify-between gap-3 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <TrendingUp size={18} className="text-zinc-400 flex-shrink-0" aria-hidden="true" />
          <h2 className="font-semibold text-white truncate">{title}</h2>
        </div>
        {aside && <span className="text-xs text-zinc-500 font-medium hidden sm:inline flex-shrink-0">{aside}</span>}
      </div>
      {note && !loading && <p className="px-5 pt-3 text-[11px] text-zinc-500">{note}</p>}

      <div className="chart-vivid px-5 pt-5 pb-4 flex-1 flex flex-col">
        {loading ? (
          <div className="flex-1 min-h-[160px] flex items-end gap-[3px]" aria-hidden="true">
            {Array.from({ length: 24 }).map((_, i) => (
              <div key={i} className="flex-1 rounded-t bg-white/[0.05] motion-safe:animate-pulse"
                style={{ height: `${18 + ((i * 37) % 55)}%`, animationDelay: `${(i % 6) * 90}ms` }} />
            ))}
          </div>
        ) : !hasData ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-10">
            <div className="w-10 h-10 rounded-full bg-white/[0.06] flex items-center justify-center mb-3">
              <TrendingUp size={18} className="text-zinc-500" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-zinc-400">{empty.title}</p>
            <p className="text-xs text-zinc-500 mt-1 max-w-[360px]">{empty.detail}</p>
          </div>
        ) : (
          <>
            <div className="flex flex-1 min-h-[160px]">
              <div className="flex flex-col justify-between flex-shrink-0 pr-2" aria-hidden="true">
                {[...ticks].reverse().map((tick) => (
                  <span key={tick} className="text-[10px] text-zinc-500 font-medium leading-none text-right" style={{ minWidth: 36 }}>
                    {fmtAxis(tick, format)}
                  </span>
                ))}
              </div>
              <div className="flex-1 relative min-w-0">
                {ticks.map((tick) => (
                  <div key={`grid-${tick}`} aria-hidden="true"
                    className={`absolute left-0 right-0 border-t ${tick === 0 && axisMin < 0 ? 'border-white/[0.15]' : 'border-white/[0.06]'}`}
                    style={{ top: `${((axisMax - tick) / axisRange) * 100}%` }} />
                ))}
                <div
                  onScroll={(e) => { if (labelsScrollRef.current) labelsScrollRef.current.scrollLeft = e.currentTarget.scrollLeft; }}
                  className="absolute inset-0 overflow-x-auto sm:overflow-visible no-scrollbar"
                >
                  <div className="chart-scroll-content flex items-end gap-[3px] relative z-[1] h-full"
                    style={{ '--bar-count': bars.length } as React.CSSProperties}>
                    {bars.map((bar, i) => {
                      const segments = series
                        .map((s) => ({ s, value: bar.values.get(s.id) ?? 0 }))
                        .filter((x) => x.value !== 0);
                      const pos = segments.filter((x) => x.value > 0);
                      const neg = segments.filter((x) => x.value < 0);
                      const { pos: posTotal, neg: negTotal } = totals[i];
                      const posPct = axisMax > 0 ? (posTotal / axisMax) * posArea : 0;
                      const negPct = axisMin < 0 ? (Math.abs(negTotal) / Math.abs(axisMin)) * negArea : 0;
                      const edge = Math.max(4, Math.floor(bars.length / 3));
                      const align = i < edge ? 'left-0' : i >= bars.length - edge ? 'right-0' : 'left-1/2 -translate-x-1/2';
                      const anchor = zeroPct + posPct;
                      const flip = anchor > 65;
                      const label = segments.length
                        ? `${bar.title}: ${segments.map((x) => `${x.s.name} ${formatMetric(x.value, format)}`).join(', ')}`
                        : `${bar.title}: none`;
                      return (
                        <div key={bar.startKey} role="img" aria-label={label} className="flex-1 flex flex-col justify-end group relative h-full">
                          {pos.length > 0 && (
                            <>
                              <div className="absolute inset-x-0 flex flex-col-reverse"
                                style={{ bottom: `${zeroPct}%`, height: `${Math.max(posPct, pos.length * 1.5)}%` }}>
                                {pos.map((x, k) => (
                                  <div key={x.s.id}
                                    className={`w-full ${x.s.bar} transition-opacity duration-150 group-hover:opacity-90 ${k === pos.length - 1 ? 'rounded-t' : ''}`}
                                    style={{ height: `${Math.max((x.value / Math.max(posTotal, 0.0001)) * 100, 3)}%` }} />
                                ))}
                              </div>
                              <div aria-hidden="true" className="chart-bar pointer-events-none absolute inset-x-0 rounded-t overflow-hidden"
                                style={{ bottom: `${zeroPct}%`, height: `${Math.max(posPct, pos.length * 1.5)}%` }} />
                            </>
                          )}
                          {neg.length > 0 && (
                            <div className="absolute inset-x-0 flex flex-col"
                              style={{ top: `${100 - zeroPct}%`, height: `${Math.max(negPct, neg.length * 1.5)}%` }}>
                              {neg.map((x, k) => (
                                <div key={x.s.id} className={`w-full opacity-60 ${x.s.bar} ${k === neg.length - 1 ? 'rounded-b' : ''}`}
                                  style={{ height: `${Math.max((Math.abs(x.value) / Math.max(Math.abs(negTotal), 0.0001)) * 100, 3)}%` }} />
                              ))}
                            </div>
                          )}
                          {segments.length === 0 && (
                            <div aria-hidden="true" className="absolute inset-x-0 bg-white/[0.06]" style={{ bottom: `${zeroPct}%`, height: 2 }} />
                          )}
                          {segments.length > 0 && (
                            <div className={`absolute z-10 pointer-events-none hidden group-hover:block ${align} ${flip ? 'mt-1' : 'mb-1'}`}
                              style={flip ? { top: 0 } : { bottom: `${Math.min(anchor, 95)}%` }}>
                              <div className="bg-surface-overlay border border-white/[0.08] text-white text-[10px] leading-relaxed px-2.5 py-1.5 rounded-md whitespace-nowrap shadow-lg">
                                <p className="font-semibold text-zinc-200 mb-1">{bar.title}</p>
                                <div className="space-y-0.5">
                                  {segments.slice().reverse().map((x) => (
                                    <div key={x.s.id} className="flex items-center gap-1.5">
                                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${x.s.dot}`} aria-hidden="true" />
                                      <span className="text-zinc-400 flex-1 min-w-0 pr-3">{x.s.name}</span>
                                      <span className={`font-semibold tabular-nums ${x.value < 0 ? 'text-red-400' : ''}`}>{formatMetric(x.value, format)}</span>
                                    </div>
                                  ))}
                                </div>
                                {segments.length > 1 && (
                                  <div className="mt-1 pt-1 border-t border-white/10 flex items-center justify-between gap-3">
                                    <span className="uppercase tracking-wider text-[9px] text-zinc-500">Total</span>
                                    <span className="font-semibold tabular-nums">{formatMetric(posTotal + negTotal, format)}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-2" style={{ marginLeft: 44 }} aria-hidden="true">
              <div ref={labelsScrollRef} className="overflow-x-hidden sm:overflow-visible no-scrollbar">
                <div className="chart-scroll-content flex gap-[3px]" style={{ '--bar-count': bars.length } as React.CSSProperties}>
                  {bars.map((bar, i) => {
                    const step = Math.max(1, Math.floor(bars.length / 6));
                    const show = i === 0 || i === bars.length - 1 || i % step === 0;
                    return (
                      <div key={`lbl-${bar.startKey}`} className="flex-1 text-center">
                        <span className="text-[9px] lg:text-[10px] text-zinc-500 font-medium truncate block">{show ? bar.label : ''}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}

        {!loading && hasData && series.length > 0 && (
          <ul className="flex items-center gap-3 mt-3 pt-3 border-t border-white/[0.06] flex-wrap" aria-label="Legend">
            {series.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5 px-2 py-1">
                <span className={`w-2.5 h-2.5 rounded-sm ${s.dot}`} aria-hidden="true" />
                <span className="text-[11px] text-zinc-300 font-medium">{s.name}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
