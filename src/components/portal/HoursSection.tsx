'use client';

import { Fragment, useMemo, useState } from 'react';
import { ChevronDown, CircleDollarSign } from 'lucide-react';
import type { PortalData } from '@/lib/types';
import { Tooltip } from '@/components/ui/Tooltip';
import { SectionCard, SectionCount, SectionHeader } from './SectionHeader';
import {
  formatBreakDuration, formatDate, formatHoursMinutes, formatMonthDay, formatTime, rise,
} from './format';

const HOURS_INITIAL = 5;
const WEEKS = 12;

/* The chart's drawing space. Only the bars and the baseline are SVG; the
   labels are real text in a 12-column grid that shares the bars' columns,
   so they keep their size while the drawing scales with the card. */
const CHART_W = 600;
const CHART_H = 170;
const BAR_SHARE = 0.56;
const CHART_HEADROOM = 8;

/** Brand tints only, in the order members appear. */
const MEMBER_TINTS = [
  'var(--vm-teal-300)',
  'var(--vm-copper)',
  'var(--vm-teal-200)',
  'var(--vm-copper-300)',
  'rgba(245, 243, 239, 0.55)',
  'var(--vm-teal)',
];

const PAYMENT: Record<'paid' | 'partial' | 'unpaid', { tip: string; className: string }> = {
  paid: { tip: 'Paid', className: 'text-(--vm-teal-200)' },
  partial: { tip: 'Partially paid', className: 'text-(--vm-copper-300)' },
  unpaid: { tip: 'Unpaid', className: 'vm-faint' },
};

type Entry = PortalData['hours']['entries'][number];

interface WeekBucket {
  start: Date;
  hours: number;
  current: boolean;
}

/** Monday 00:00 local of the ISO week holding `date`. */
function isoWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/**
 * Hours summed per ISO week over twelve weeks, oldest first. The window ends
 * on the current week; when nothing has been logged inside it (an older
 * project) it ends on the last week that has hours instead.
 */
function weeklyHours(entries: Entry[]): { weeks: WeekBucket[]; toToday: boolean } {
  const byWeek = new Map<number, number>();
  let latest = 0;
  for (const entry of entries) {
    const key = isoWeekStart(new Date(entry.start_time)).getTime();
    byWeek.set(key, (byWeek.get(key) ?? 0) + entry.hours);
    if (key > latest) latest = key;
  }

  const thisWeek = isoWeekStart(new Date());
  const windowStart = new Date(thisWeek);
  windowStart.setDate(windowStart.getDate() - (WEEKS - 1) * 7);
  const toToday = latest === 0 || latest >= windowStart.getTime();
  const anchor = toToday ? thisWeek : new Date(latest);

  const weeks: WeekBucket[] = [];
  for (let back = WEEKS - 1; back >= 0; back--) {
    const start = new Date(anchor);
    start.setDate(start.getDate() - back * 7);
    weeks.push({ start, hours: byWeek.get(start.getTime()) ?? 0, current: toToday && back === 0 });
  }
  return { weeks, toToday };
}

/** Hours per week as bars, the current week at full strength, the tallest bar labelled. */
function WeeklyChart({ entries }: { entries: Entry[] }) {
  const { weeks, toToday } = useMemo(() => weeklyHours(entries), [entries]);
  const max = Math.max(...weeks.map(w => w.hours));
  const peakIndex = weeks.findIndex(w => w.hours === max);
  const colW = CHART_W / WEEKS;
  const barW = colW * BAR_SHARE;
  const baseline = CHART_H - 1;
  const plotH = baseline - CHART_HEADROOM;

  const range = toToday ? 'Last 12 weeks' : `12 weeks to ${formatMonthDay(weeks[weeks.length - 1].start)}`;
  const summary = max > 0
    ? `Hours per week, ${range.toLowerCase()}. Most in the week of ${formatMonthDay(weeks[peakIndex].start)}: ${formatHoursMinutes(max)}.`
    : `Hours per week, ${range.toLowerCase()}. Nothing logged in this window.`;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className="vm-label">Hours per week</span>
        <span className="vm-faint text-[13px]">{range}</span>
      </div>

      <div role="img" aria-label={summary} className="mt-4">
        {/* The tallest bar's figure sits in its own column above the drawing. */}
        <div className="grid h-5 grid-cols-12 items-end" aria-hidden="true">
          {max > 0 && (
            <span className="flex justify-center" style={{ gridColumnStart: peakIndex + 1 }}>
              <span className="vm-mono whitespace-nowrap text-[11px] text-(--vm-teal-200)">{formatHoursMinutes(max)}</span>
            </span>
          )}
        </div>

        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="mt-1 block h-auto w-full" aria-hidden="true">
          {weeks.map((week, i) => {
            const x = i * colW + (colW - barW) / 2;
            if (week.hours <= 0 || max <= 0) {
              return (
                <rect key={week.start.getTime()} x={x} y={baseline - 2} width={barW} height={2} rx={1} fill="rgba(255,255,255,0.08)" />
              );
            }
            const h = Math.max(2, (week.hours / max) * plotH);
            return (
              <rect
                key={week.start.getTime()}
                x={x}
                y={baseline - h}
                width={barW}
                height={h}
                rx={2}
                fill="var(--vm-teal-300)"
                fillOpacity={week.current ? 1 : 0.7}
                className="vm-bar"
                style={rise(0.35 + i * 0.03)}
              />
            );
          })}
          <line
            x1={0}
            x2={CHART_W}
            y1={baseline}
            y2={baseline}
            stroke="var(--vm-line-strong)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* A week label on every other column; the current week always gets one. */}
        <div className="mt-2 grid grid-cols-12" aria-hidden="true">
          {weeks.map((week, i) => (
            <span key={week.start.getTime()} className={`flex justify-center ${i % 2 === 0 ? 'invisible' : ''}`}>
              <span className="vm-mono vm-faint whitespace-nowrap text-[10px]">{formatMonthDay(week.start)}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function Sep() {
  return <span className="opacity-50" aria-hidden="true">/</span>;
}

function EntryRow({ entry, showMember }: { entry: Entry; showMember: boolean }) {
  const multiSegment = entry.segments && entry.segments.length > 1;
  const payment = entry.payment_status ? PAYMENT[entry.payment_status] : null;

  return (
    <li className="vm-row py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{entry.description || 'Work logged'}</p>
          <div className="vm-faint mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            {showMember && (
              <>
                <span>{entry.member_name}</span>
                <Sep />
              </>
            )}
            <span>{formatDate(entry.start_time)}</span>
            <Sep />
            <span>{formatTime(entry.start_time)} – {formatTime(entry.end_time)}</span>
            {/* Single-segment entries never pause, so the summary only appears
                on rows that don't get the expanded session breakdown below. */}
            {!multiSegment && entry.paused_seconds > 0 && (
              <>
                <Sep />
                <span>paused {formatBreakDuration(entry.paused_seconds)}</span>
              </>
            )}
            {payment && (
              <Tooltip content={payment.tip}>
                <CircleDollarSign size={13} role="img" aria-label={payment.tip} className={`shrink-0 ${payment.className}`} />
              </Tooltip>
            )}
          </div>
        </div>
        <span className="vm-mono shrink-0 text-[15px]">{formatHoursMinutes(entry.hours)}</span>
      </div>

      {multiSegment && (
        <ul className="vm-tile mt-3 space-y-1.5 px-4 py-3">
          {entry.segments.map((seg, i) => {
            const segStart = new Date(seg.start);
            const segEnd = new Date(seg.end);
            const segDurationSec = Math.round((segEnd.getTime() - segStart.getTime()) / 1000);
            const nextSeg = entry.segments[i + 1];
            const gapSec = nextSeg
              ? Math.round((new Date(nextSeg.start).getTime() - segEnd.getTime()) / 1000)
              : 0;
            return (
              <Fragment key={i}>
                <li className="vm-mono flex items-center gap-2.5 text-[13px]">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-(--vm-teal-200)" aria-hidden="true" />
                  <span>{formatTime(seg.start)} – {formatTime(seg.end)}</span>
                  <span className="vm-faint">{formatBreakDuration(segDurationSec)}</span>
                </li>
                {gapSec > 0 && (
                  <li className="vm-faint flex items-center gap-2.5 text-[13px]">
                    <span className="ml-[2.5px] h-2.5 w-px bg-(--vm-line-strong)" aria-hidden="true" />
                    <span>paused for {formatBreakDuration(gapSec)}</span>
                  </li>
                )}
              </Fragment>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function HoursSection({
  entries,
  totalHours,
}: {
  entries: PortalData['hours']['entries'];
  totalHours: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? entries : entries.slice(0, HOURS_INITIAL);
  const hiddenCount = entries.length - HOURS_INITIAL;

  const memberHours = useMemo(() => {
    const byMember: Record<string, number> = {};
    for (const entry of entries) {
      byMember[entry.member_name] = (byMember[entry.member_name] || 0) + entry.hours;
    }
    return Object.entries(byMember).map(([name, hours], i) => ({
      name,
      hours,
      tint: MEMBER_TINTS[i % MEMBER_TINTS.length],
    }));
  }, [entries]);

  const showMember = memberHours.length > 1;
  const splitSummary = memberHours.map(m => `${m.name} ${formatHoursMinutes(m.hours)}`).join(', ');

  return (
    <SectionCard sectionKey="show_hours">
      <SectionHeader
        title="Hours"
        serif="logged."
        right={<SectionCount>{entries.length} {entries.length === 1 ? 'session' : 'sessions'}</SectionCount>}
      />

      <WeeklyChart entries={entries} />

      {showMember && (
        <div className="mt-8">
          <div className="vm-track flex" role="img" aria-label={`Hours by team member: ${splitSummary}`}>
            {memberHours.map((m) => (
              <div
                key={m.name}
                className="h-full"
                style={{ width: `${totalHours > 0 ? (m.hours / totalHours) * 100 : 0}%`, background: m.tint }}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
            {memberHours.map((m) => (
              <li key={m.name} className="flex items-center gap-2 text-[13px]">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: m.tint }} aria-hidden="true" />
                <span>{m.name}</span>
                <span className="vm-mono vm-faint">{formatHoursMinutes(m.hours)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="mt-8">
        {visible.map((entry) => (
          <EntryRow key={entry.id} entry={entry} showMember={showMember} />
        ))}
      </ul>

      {entries.length > HOURS_INITIAL && (
        <button
          type="button"
          onClick={() => setShowAll(!showAll)}
          aria-expanded={showAll}
          className="vm-btn vm-btn-ghost vm-btn-sm mt-6 w-full sm:w-auto"
        >
          <ChevronDown size={15} aria-hidden="true" className={`transition-transform ${showAll ? 'rotate-180' : ''}`} />
          {showAll ? 'Show less' : `Show ${hiddenCount} more entr${hiddenCount === 1 ? 'y' : 'ies'}`}
        </button>
      )}
    </SectionCard>
  );
}
