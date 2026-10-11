'use client';

import { ShieldAlert } from 'lucide-react';
import type { Reliability } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Disclosure, MiniStat, Missing, StatRow, fmtDuration, fmtPct, fmtSeconds, fmtWhen } from './shared';

const FAILURE_LABELS: Record<string, string> = {
  failed: 'Failed',
  unknown: 'Lost to a restart',
  completed_with_error: 'Completed with an error',
  dead: 'Died mid-run',
};

/**
 * Failures, restarts, overlapping turns and hand-off latency. Four headline
 * numbers first; the lists behind each (error text, every pair, every
 * restart) fold away until asked for.
 */
export function ReliabilityCard({ reliability, measuring, withheldReason }: {
  reliability: Reliability;
  measuring: boolean;
  withheldReason: string | null;
}) {
  const r = reliability;
  const runs = r.failureRates.reduce((sum, row) => sum + row.runs, 0);
  const failed = r.failures.length;
  const pairs = r.overlaps.reduce((sum, row) => sum + row.pairs, 0);
  const wakes = r.wakes.stateChange + r.wakes.continuation + r.wakes.yielded;

  return (
    <Card icon={ShieldAlert} title="Reliability">
      {measuring ? (
        <CardSkeleton rows={4} />
      ) : withheldReason ? (
        <Missing>{withheldReason}</Missing>
      ) : (
        <div className="p-5 space-y-4">
          <StatRow columns={4}>
            <MiniStat
              label="Failed turns"
              hint="Scheduled fires that did not end cleanly, over the runs of the jobs they belong to."
              value={r.tracked.failures ? String(failed) : null}
              empty="Not reported"
              valueClass={failed > 0 ? 'text-rose-400' : 'text-white'}
              sub={failed > 0 && runs > 0 ? `${fmtPct(failed / runs)} of affected jobs' runs` : 'none in range'}
            />
            <MiniStat
              label="Restarts"
              hint="Container and gateway starts, with the deploy that caused them when there was one."
              value={r.tracked.restarts ? String(r.restarts.length) : null}
              empty="Not reported"
              sub={r.restarts.length > 0 ? `latest ${fmtWhen(r.restarts[0].at)}` : 'none in range'}
            />
            <MiniStat
              label="Overlapping turns"
              hint="Two turns of the same agent running at once, scheduled or directed. Overlap double-billed real work on Oct 4."
              value={String(pairs)}
              valueClass={pairs > 0 ? 'text-amber-400' : 'text-white'}
              sub={pairs > 0 ? `${r.overlaps.length} agent${r.overlaps.length === 1 ? '' : 's'}` : 'none in range'}
            />
            <MiniStat
              label="Hand-off latency"
              hint="Seconds from the dispatcher seeing a new task or PR state to waking the agent: median, with the 95th percentile below."
              value={r.handoff.p50Seconds === null ? null : fmtSeconds(r.handoff.p50Seconds)}
              empty={r.tracked.wakes ? 'No hand-offs' : 'Not reported'}
              sub={r.handoff.p95Seconds !== null ? `p95 ${fmtSeconds(r.handoff.p95Seconds)} · ${r.handoff.samples} wakes` : wakes > 0 ? `${wakes} wakes, none a hand-off` : undefined}
            />
          </StatRow>

          {failed > 0 && (
            <Disclosure label="Failed turns" count={failed}>
              <ul className="space-y-1 mb-3">
                {r.failureRates.map((row) => (
                  <li key={`${row.agentId}:${row.jobName}`} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-zinc-400 truncate">{row.agentName} · {row.jobName}</span>
                    <span className="text-zinc-300 flex-shrink-0 tabular-nums">{row.failures} of {row.runs} · {fmtPct(row.rate)}</span>
                  </li>
                ))}
              </ul>
              <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06] max-h-72 overflow-y-auto">
                {r.failures.map((f) => (
                  <li key={f.id} className="px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-xs font-medium text-zinc-300">{FAILURE_LABELS[f.failure] ?? f.failure}{f.jobName ? ` · ${f.jobName}` : ''}</span>
                      <span className="text-[11px] text-zinc-500 flex-shrink-0">{fmtWhen(f.at)}</span>
                    </div>
                    <p className="text-[11px] text-zinc-500 break-words">{f.error ?? 'No error text recorded.'}</p>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          {pairs > 0 && (
            <Disclosure label="Overlapping turns" count={pairs}>
              <ul className="space-y-2.5">
                {r.overlaps.map((row) => (
                  <li key={row.agentId}>
                    <p className="text-xs text-zinc-300">
                      {row.agentName}: {row.pairs} pair{row.pairs === 1 ? '' : 's'}
                      <span className="text-zinc-500"> · {fmtDuration(row.overlapMs)} concurrent</span>
                    </p>
                    <ul className="mt-0.5 space-y-0.5">
                      {row.examples.slice(0, 5).map((pair) => (
                        <li key={`${pair.first.id}:${pair.second.id}`} className="text-[11px] text-zinc-500">
                          {fmtWhen(pair.second.start)}: {pair.first.origin} {pair.first.jobName ?? ''} and {pair.second.origin} {pair.second.jobName ?? ''}, {fmtDuration(pair.overlapMs)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          {r.restarts.length > 0 && (
            <Disclosure label="Restarts" count={r.restarts.length}>
              <ul className="space-y-1 max-h-72 overflow-y-auto">
                {r.restarts.map((row) => (
                  <li key={row.id} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-zinc-400 truncate">
                      {row.agentName} {row.kind}
                      {row.deployCommit && <span className="text-zinc-500"> · deploy <code className="text-[11px]">{row.deployCommit.slice(0, 7)}</code></span>}
                    </span>
                    <span className="text-[11px] text-zinc-500 flex-shrink-0">{fmtWhen(row.at)}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}

          {wakes > 0 && (
            <p className="text-[11px] text-zinc-500">
              Dispatcher wakes: {r.wakes.stateChange} on a state change, {r.wakes.continuation} to continue claimed work, {r.wakes.yielded} yielded to the schedule.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
