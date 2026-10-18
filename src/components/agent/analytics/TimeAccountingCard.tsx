'use client';

import { useState } from 'react';
import { Timer } from 'lucide-react';
import type { BreakdownRow, TimeAccounting, TimeLine } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, LINE_ORDER, LINE_STYLE, MiniStat, Missing, StatRow, fmtDuration, fmtPct } from './shared';

/**
 * Where every minute of runtime went. Active runtime is the measured total;
 * each line under it is a kind of time with its own name, and the lines sum
 * to the total. Effective runtime is outcome work alone, minus rework.
 */
export function TimeAccountingCard({
  accounting,
  byJob,
  byTrigger,
  byAgent,
  measuring,
  withheldReason,
  outcomesReported,
}: {
  accounting: TimeAccounting;
  byJob: BreakdownRow[];
  byTrigger: BreakdownRow[];
  byAgent: BreakdownRow[];
  measuring: boolean;
  /** Set when runtime cannot be shown for this selection (a project filter). */
  withheldReason: string | null;
  outcomesReported: boolean;
}) {
  const [view, setView] = useState<'agent' | 'job' | 'trigger'>('agent');
  const a = accounting;
  const unknownOrUnlabelled = a.lines.unknown + a.lines.unlabelled;
  // The list follows LINE_ORDER: rework sits inside work, unknown and
  // unlabelled share a row, failed carries its fire counts.
  const items: { line: TimeLine; value: number; label?: string; hint?: string; note?: string }[] = [
    { line: 'work', value: a.lines.work + a.lines.rework },
    { line: 'waiting', value: a.lines.waiting },
    { line: 'blocked', value: a.lines.blocked },
    { line: 'failed', value: a.lines.failed,
      note: a.failedRuns > 0
        ? `${a.failedWithoutTurn} fire${a.failedWithoutTurn === 1 ? '' : 's'}${a.failedRuns > a.failedWithoutTurn ? `, plus ${a.failedRuns - a.failedWithoutTurn} counted under their outcome` : ''}`
        : undefined },
    { line: 'skipped', value: a.lines.skipped },
    { line: 'idle', value: a.lines.idle },
    { line: 'unlabelled', value: unknownOrUnlabelled, label: 'Unknown or unlabelled',
      hint: `${LINE_STYLE.unknown.hint} ${LINE_STYLE.unlabelled.hint}`,
      note: unknownOrUnlabelled > 0 ? `${a.unknownTurns} unknown, ${a.unlabelledTurns} unlabelled turns` : undefined },
  ];
  const breakdown = view === 'agent' ? byAgent : view === 'job' ? byJob : byTrigger;

  return (
    <Card icon={Timer} title="Time accounting">
      {measuring ? (
        <CardSkeleton rows={6} />
      ) : withheldReason ? (
        <Missing>{withheldReason}</Missing>
      ) : a.activeMs === 0 ? (
        <Missing>No turns in this range. Runtime appears once completed turns are recorded.</Missing>
      ) : (
        <div className="p-5 space-y-5">
          <StatRow columns={3}>
            <MiniStat
              label="Active runtime"
              hint="Every turn that ran, including idle checks, waiting, failures and turns not yet labelled. Overlapping turns of one agent count once."
              value={fmtDuration(a.activeMs)}
              valueClass="text-sky-300"
              sub={`${a.turns.toLocaleString('en-US')} turns`}
            />
            <MiniStat
              label="Effective runtime"
              hint="Outcome work only, minus rework on approved work. Idle checks, waiting, blocked, skipped, unknown, unlabelled and failed time are never in it."
              value={fmtDuration(a.effectiveMs)}
              valueClass="text-emerald-400"
              sub={a.lines.rework > 0 ? `after ${fmtDuration(a.lines.rework)} of rework` : 'outcome work only'}
            />
            <MiniStat
              label="Productive share"
              hint="All work, rework included, over active runtime."
              value={a.productiveShare === null ? null : fmtPct(a.productiveShare)}
              sub="work over active"
            />
          </StatRow>

          <div>
            {/* One bar, proportional, so idle reads as idle at a glance. */}
            <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.04]" role="img"
              aria-label={`Active runtime split: ${items.map((i) => `${i.label ?? LINE_STYLE[i.line].label} ${fmtDuration(i.value)}`).join(', ')}`}>
              {LINE_ORDER.map((line) =>
                a.lines[line] > 0 ? (
                  <div key={line} className={LINE_STYLE[line].bar} style={{ width: `${(a.lines[line] / a.activeMs) * 100}%` }} />
                ) : null)}
            </div>

            <ul className="mt-3 grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {items.map((item) => {
                const label = item.label ?? LINE_STYLE[item.line].label;
                const hint = item.hint ?? LINE_STYLE[item.line].hint;
                const note = item.note;
                return (
                  <li key={label} className="flex items-baseline justify-between gap-3 min-w-0">
                    <span className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${LINE_STYLE[item.line].dot}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <Defined hint={hint}><span className="text-xs text-zinc-400">{label}</span></Defined>
                        {note && <span className="block text-[10px] text-zinc-500 truncate">{note}</span>}
                      </span>
                    </span>
                    <span className="text-xs font-medium text-zinc-200 tabular-nums flex-shrink-0">
                      {fmtDuration(item.value)}
                      <span className="text-zinc-500 font-normal"> {fmtPct(item.value / a.activeMs)}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
            {!outcomesReported && (
              <p className="text-[11px] text-zinc-500 mt-3">No scheduled turn carries an outcome yet, so scheduled time reads as unlabelled until outcomes arrive.</p>
            )}
          </div>

          <div className="pt-4 border-t border-white/[0.06]">
            <div className="flex items-center justify-between gap-3 mb-2.5">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">Breakdown</p>
              <div className="seg-track seg-sm" role="group" aria-label="Break runtime down by">
                {(['agent', 'job', 'trigger'] as const).map((key) => (
                  <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}
                    className={`seg-item ${view === key ? 'is-active' : ''}`}>
                    {key === 'agent' ? 'Agent' : key === 'job' ? 'Job' : 'Trigger'}
                  </button>
                ))}
              </div>
            </div>
            {breakdown.length === 0 ? (
              <p className="text-xs text-zinc-500">No turns to break down.</p>
            ) : (
              <ul className="space-y-2">
                {breakdown.map((row) => (
                  <li key={row.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-zinc-300 truncate">{row.label}</span>
                      <span className="text-xs text-zinc-400 flex-shrink-0">
                        {fmtDuration(row.activeMs)} · {row.turns} turn{row.turns === 1 ? '' : 's'}
                        <span className="text-emerald-400 font-medium"> · {row.productiveShare === null ? '-' : fmtPct(row.productiveShare)} work</span>
                      </span>
                    </div>
                    <div className="flex h-1.5 mt-1 rounded-full overflow-hidden bg-white/[0.04]" aria-hidden="true">
                      {([['workMs', 'work'], ['blockedMs', 'blocked'], ['waitingMs', 'waiting'], ['idleMs', 'idle'], ['skippedMs', 'skipped'], ['otherMs', 'unlabelled']] as const).map(([field, line]) =>
                        row[field] > 0 ? <div key={field} className={LINE_STYLE[line].bar} style={{ width: `${(row[field] / row.activeMs) * 100}%` }} /> : null)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-zinc-500 mt-2.5">
              Summed turn time in range per {view}, so turns that ran at once each count. {view === 'trigger'
                ? 'Scheduled ticks are the safety net; dispatcher wakes are hand-offs; directed turns came from Telegram.'
                : 'Directed (Telegram) turns are always work.'}
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
