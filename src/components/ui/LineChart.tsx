'use client';

import { useCallback, useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * One question, one line (DESIGN.md Rule 16): a single brand series over
 * time, light gridlines, a few axis labels with the unit, and a plain
 * tooltip with the exact value and date. Pointer or arrow keys move the
 * marker. Empty or loading, it says what will appear. It measures its own
 * width, so text stays its real size on a phone.
 */

export interface LinePoint {
  /** Short label for the x axis ("Nov 3"). */
  label: string;
  /** Long label for the tooltip ("Mon, Nov 3"). */
  title: string;
  value: number;
}

const HEIGHT = 220;
const PAD = { top: 24, right: 12, bottom: 26, left: 40 };

/** About four round ticks from 0 to just past max. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const step = Math.max(1, (r <= 1.5 ? 1 : r <= 3.5 ? 2 : r <= 7.5 ? 5 : 10) * mag);
  const ticks = [0];
  while (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

export function LineChart({ points, format, unit, label, empty = 'Data shows here once there is some', loading = false }: {
  points: LinePoint[];
  /** Formats a value with its unit for the tooltip and axis ("42 runs"). */
  format: (value: number) => string;
  /** The unit on its own, shown on the axis ("runs"). */
  unit: string;
  /** Names the chart for screen readers; the visible title sits above it in its card. */
  label: string;
  /** What will appear here, when there is nothing yet. */
  empty?: string;
  loading?: boolean;
}) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const descId = useId();

  // A callback ref, not an effect: the measured box only exists once there is
  // data, so a chart that mounts loading or empty starts measuring when the
  // box appears and stops when it goes.
  const measure = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ticks = useMemo(() => niceTicks(Math.max(0, ...points.map((p) => p.value))), [points]);
  const top = ticks[ticks.length - 1];
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length < 2 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = points.length > 1 ? `${path} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z` : '';
  const xLabels = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    if (points.length === 0 || innerW <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - box.left - PAD.left) / innerW;
    setActive(Math.min(points.length - 1, Math.max(0, Math.round(ratio * (points.length - 1)))));
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const at = active ?? points.length - 1;
    if (e.key === 'ArrowRight') setActive(Math.min(points.length - 1, at + 1));
    else if (e.key === 'ArrowLeft') setActive(Math.max(0, at - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(points.length - 1);
    else return;
    e.preventDefault();
  };

  if (loading) {
    return <div role="status" aria-label={`${label}: loading`} className="h-[220px] rounded-lg bg-white/[0.03] motion-safe:animate-pulse" />;
  }
  if (points.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg bg-white/[0.02] px-6 text-center text-sm text-zinc-400">{empty}</div>
    );
  }

  const shown = active === null ? null : points[active];
  const latest = points[points.length - 1];

  return (
    <div ref={measure} className="relative w-full">
      <p id={descId} className="sr-only">
        {label}. Latest {latest.title}: {format(latest.value)}. Use the arrow keys to read each day.
      </p>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          role="img"
          tabIndex={0}
          aria-label={shown ? `${shown.title}: ${format(shown.value)}` : label}
          aria-describedby={descId}
          onPointerMove={pick}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          className="block rounded-lg text-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="rgba(var(--ink),0.06)" />
              <text x={PAD.left - 8} y={y(t)} dy="0.35em" textAnchor="end" className="fill-zinc-500 text-[11px] tabular-nums">{t}</text>
            </g>
          ))}
          {area && <path d={area} fill="currentColor" opacity={0.08} />}
          <path d={path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {xLabels.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={HEIGHT - 6}
              textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
              className="fill-zinc-500 text-[11px]"
            >
              {points[i].label}
            </text>
          ))}
          {shown && active !== null && (
            <g aria-hidden="true">
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + innerH} stroke="rgba(var(--ink),0.18)" />
              <circle cx={x(active)} cy={y(shown.value)} r={4} fill="currentColor" stroke="var(--color-surface-raised)" strokeWidth={2} />
            </g>
          )}
        </svg>
      )}
      <span className="pointer-events-none absolute left-0 top-0 text-[11px] text-zinc-500" aria-hidden="true">{unit}</span>
      {shown && active !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/10 bg-surface-overlay px-2.5 py-1.5 text-xs shadow-overlay"
          style={{ left: Math.min(Math.max(x(active), 70), width - 70), top: Math.max(0, y(shown.value) - 52) }}
        >
          <span className="block text-zinc-400">{shown.title}</span>
          <span className="block font-semibold tabular-nums text-white">{format(shown.value)}</span>
        </div>
      )}
    </div>
  );
}
