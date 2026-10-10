'use client';

import { useState } from 'react';
import { Timer } from 'lucide-react';
import type { BreakdownRow, TimeAccounting, TimeLine } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, LINE_STYLE, Missing, fmtDuration, fmtPct } from './shared';

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
  const lines: { line: TimeLine; value: number; extra?: string }[] = [
    { line: 'work', value: a.lines.work + a.lines.rework },
    { line: 'idle', value: a.lines.idle },
    { line: 'waiting', value: a.lines.waiting },
    { line: 'blocked', value: a.lines.blocked },
    { line: 'skipped', value: a.lines.skipped },
  ];
  const unknownOrUnlabelled = a.lines.unknown + a.lines.unlabelled;
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
          <div className="space-y-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <Defined hint="Every turn that ran, including idle checks, waiting, failures and turns not yet labelled. Overlapping turns of one agent count once.">
                <span className="text-sm text-zinc-300">Active runtime</span>
              </Defined>
              <span className="text-lg font-bold text-sky-300">{fmtDuration(a.activeMs)}</span>
            </div>

            {/* One bar, proportional, so idle reads as idle at a glance. */}
            <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.04]" role="img"
              aria-label={`Active runtime split: ${[...lines.map((l) => `${LINE_STYLE[l.line].label} ${fmtDuration(l.value)}`),
                `Unknown or unlabelled ${fmtDuration(unknownOrUnlabelled)}`, `Failed ${fmtDuration(a.lines.failed)}`].join(', ')}`}>
              {(['work', 'rework', 'blocked', 'waiting', 'idle', 'skipped', 'unknown', 'unlabelled', 'failed'] as TimeLine[]).map((line) =>
                a.lines[line] > 0 ? (
                  <div key={line} className={LINE_STYLE[line].bar} style={{ width: `${(a.lines[line] / a.activeMs) * 100}%` }} />
                ) : null)}
            </div>

            <ul className="space-y-1.5 pt-1">
              {lines.map(({ line, value }) => (
                <li key={line} className="flex items-baseline justify-between gap-3">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${LINE_STYLE[line].dot}`} aria-hidden="true" />
                    <Defined hint={LINE_STYLE[line].hint}><span className="text-sm text-zinc-400">{LINE_STYLE[line].label}</span></Defined>
                  </span>
                  <span className="text-sm font-semibold text-zinc-200">
                    {fmtDuration(value)}
                    <span className="text-zinc-500 font-normal"> · {fmtPct(value / a.activeMs)}</span>
                  </span>
                </li>
              ))}
              <li className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${LINE_STYLE.unlabelled.dot}`} aria-hidden="true" />
                  <Defined hint={`${LINE_STYLE.unknown.hint} ${LINE_STYLE.unlabelled.hint}`}>
                    <span className="text-sm text-zinc-400">Unknown or unlabelled</span>
                  </Defined>
                </span>
                <span className="text-sm font-semibold text-zinc-200 text-right">
                  {fmtDuration(unknownOrUnlabelled)}
                  <span className="text-zinc-500 font-normal"> · {fmtPct(unknownOrUnlabelled / a.activeMs)}</span>
                  {unknownOrUnlabelled > 0 && (
                    <span className="block text-[11px] text-zinc-500 font-normal">
                      {a.unknownTurns} unknown · {a.unlabelledTurns} unlabelled turn{a.unlabelledTurns === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
              </li>
              <li className="flex items-baseline justify-between gap-3">
                <span className="flex items-center gap-2 min-w-0">
                  <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${LINE_STYLE.failed.dot}`} aria-hidden="true" />
                  <Defined hint={LINE_STYLE.failed.hint}><span className="text-sm text-zinc-400">Failed</span></Defined>
                </span>
                <span className="text-sm font-semibold text-zinc-200 text-right">
                  {fmtDuration(a.lines.failed)}
                  <span className="text-zinc-500 font-normal"> · {a.failedWithoutTurn} fire{a.failedWithoutTurn === 1 ? '' : 's'}</span>
                  {a.failedRuns > a.failedWithoutTurn && (
                    <span className="block text-[11px] text-zinc-500 font-normal">
                      plus {a.failedRuns - a.failedWithoutTurn} completed with an error, counted under their outcome
                    </span>
                  )}
                </span>
              </li>
            </ul>
          </div>

          <div className="space-y-1.5 pt-3 border-t border-white/[0.08]">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-zinc-400">Work</span>
              <span className="text-sm font-semibold text-zinc-200">{fmtDuration(a.lines.work + a.lines.rework)}</span>
            </div>
            {a.lines.rework > 0 && (
              <div className="flex items-baseline justify-between gap-3">
                <Defined hint={LINE_STYLE.rework.hint}><span className="text-sm text-zinc-500">− Rework on approved work</span></Defined>
                <span className="text-sm font-semibold text-amber-400">{fmtDuration(a.lines.rework)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-3">
              <Defined hint="Outcome work only, minus rework on approved work. Idle checks, waiting, blocked, skipped, unknown, unlabelled and failed time are never in it.">
                <span className="text-sm font-medium text-zinc-200">Effective runtime</span>
              </Defined>
              <span className="text-lg font-bold text-emerald-400">{fmtDuration(a.effectiveMs)}</span>
            </div>
            <p className="text-[11px] text-zinc-500">
              Productive share {a.productiveShare === null ? 'not measurable' : fmtPct(a.productiveShare)}: work over active runtime.
              {!outcomesReported && ' No scheduled turn carries an outcome yet, so scheduled time reads as unlabelled until outcomes arrive.'}
            </p>
          </div>

          <div className="pt-3 border-t border-white/[0.08]">
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
