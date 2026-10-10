'use client';

import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { Reliability } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, Label, Missing, fmtDuration, fmtPct, fmtSeconds, fmtWhen } from './shared';

const FAILURE_LABELS: Record<string, string> = {
  failed: 'Failed',
  unknown: 'Lost to a restart',
  completed_with_error: 'Completed with an error',
  dead: 'Died mid-run',
};

/** Failures, restarts, overlapping turns and hand-off latency. */
export function ReliabilityCard({ reliability, measuring, withheldReason }: {
  reliability: Reliability;
  measuring: boolean;
  withheldReason: string | null;
}) {
  const r = reliability;
  const [showAllErrors, setShowAllErrors] = useState(false);
  const errors = showAllErrors ? r.failures : r.failures.slice(0, 5);
  return (
    <Card icon={ShieldAlert} title="Reliability">
      {measuring ? (
        <CardSkeleton rows={6} />
      ) : withheldReason ? (
        <Missing>{withheldReason}</Missing>
      ) : (
        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Defined hint="Seconds from the dispatcher first seeing a new task or PR state to waking the agent. Zero unless the agent was busy, in a conversation, or inside the minimum-wake throttle.">
                <span className="text-xs text-zinc-500">Hand-off latency</span>
              </Defined>
              {r.handoff.samples === 0 ? (
                <p className="text-sm text-zinc-500 mt-1">{r.tracked.wakes ? 'No wakes in range' : 'Wake telemetry not reported yet'}</p>
              ) : (
                <>
                  <p className="text-xl font-bold text-white mt-1">
                    {fmtSeconds(r.handoff.p50Seconds ?? 0)} <span className="text-sm font-medium text-zinc-500">p50</span>
                  </p>
                  <p className="text-[11px] text-zinc-500">p95 {fmtSeconds(r.handoff.p95Seconds ?? 0)} · {r.handoff.samples} wakes</p>
                </>
              )}
            </div>
            <div>
              <span className="text-xs text-zinc-500">Dispatcher wakes</span>
              {r.wakes.stateChange + r.wakes.continuation + r.wakes.yielded === 0 ? (
                <p className="text-sm text-zinc-500 mt-1">{r.tracked.wakes ? 'None in range' : 'Not reported yet'}</p>
              ) : (
                <p className="text-sm text-zinc-300 mt-1 leading-relaxed">
                  {r.wakes.stateChange} on state change<br />
                  {r.wakes.continuation} to continue<br />
                  {r.wakes.yielded} yielded to the schedule
                </p>
              )}
            </div>
          </div>

          <div className="pt-3 border-t border-white/[0.08]">
            <Label>Failed turns</Label>
            {r.failures.length === 0 ? (
              <p className="text-xs text-zinc-500">{r.tracked.failures ? 'No failures in range.' : 'Failure telemetry has not reported yet.'}</p>
            ) : (
              <>
                <ul className="space-y-1 mb-3">
                  {r.failureRates.map((row) => (
                    <li key={`${row.agentId}:${row.jobName}`} className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-zinc-400 truncate">{row.agentName} · {row.jobName}</span>
                      <span className="text-sm font-semibold text-rose-400 flex-shrink-0">
                        {fmtPct(row.rate)} <span className="text-zinc-500 font-normal">{row.failures} of {row.runs} runs</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <ul className="divide-y divide-white/[0.06] rounded-lg border border-white/[0.06]">
                  {errors.map((f) => (
                    <li key={f.id} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-xs font-medium text-zinc-300">{FAILURE_LABELS[f.failure] ?? f.failure}{f.jobName ? ` · ${f.jobName}` : ''}</span>
                        <span className="text-[11px] text-zinc-500 flex-shrink-0">{fmtWhen(f.at)}</span>
                      </div>
                      <p className="text-[11px] text-zinc-500 break-words">{f.error ?? 'No error text recorded.'}</p>
                    </li>
                  ))}
                </ul>
                {r.failures.length > 5 && (
                  <button type="button" onClick={() => setShowAllErrors((v) => !v)}
                    className="mt-2 text-xs font-medium text-zinc-400 hover:text-white rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
                    {showAllErrors ? 'Show fewer' : `Show all ${r.failures.length}`}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="pt-3 border-t border-white/[0.08]">
            <Label>
              <Defined hint="Two turns of the same agent whose time ranges overlap, scheduled or directed. Overlap double-billed real work on Oct 4, so every pair is counted.">
                Overlapping turns
              </Defined>
            </Label>
            {r.overlaps.length === 0 ? (
              <p className="text-xs text-zinc-500">No overlapping turns in range.</p>
            ) : (
              <ul className="space-y-2">
                {r.overlaps.map((row) => (
                  <li key={row.agentId}>
                    <p className="text-sm text-zinc-300">
                      {row.agentName}: <span className="font-semibold text-amber-400">{row.pairs} pair{row.pairs === 1 ? '' : 's'}</span>
                      <span className="text-zinc-500"> · {fmtDuration(row.overlapMs)} run concurrently</span>
                    </p>
                    <ul className="mt-0.5">
                      {row.examples.slice(0, 3).map((pair) => (
                        <li key={`${pair.first.id}:${pair.second.id}`} className="text-[11px] text-zinc-500">
                          {fmtWhen(pair.second.start)}: {pair.first.origin} {pair.first.jobName ?? ''} and {pair.second.origin} {pair.second.jobName ?? ''} overlapped {fmtDuration(pair.overlapMs)}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="pt-3 border-t border-white/[0.08]">
            <Label>Restarts</Label>
            {r.restarts.length === 0 ? (
              <p className="text-xs text-zinc-500">{r.tracked.restarts ? 'No restarts in range.' : 'Restart telemetry has not reported yet.'}</p>
            ) : (
              <ul className="space-y-1">
                {r.restarts.slice(0, 8).map((row) => (
                  <li key={row.id} className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-zinc-400 truncate">
                      {row.agentName} {row.kind}
                      {row.deployCommit && <span className="text-zinc-500"> · deploy <code className="text-[11px]">{row.deployCommit.slice(0, 7)}</code></span>}
                    </span>
                    <span className="text-[11px] text-zinc-500 flex-shrink-0">{fmtWhen(row.at)}</span>
                  </li>
                ))}
                {r.restarts.length > 8 && <li className="text-[11px] text-zinc-500">and {r.restarts.length - 8} more</li>}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
