'use client';

import { BellRing } from 'lucide-react';
import { Sparkline } from '@/components/ui/Sparkline';
import type { Attention } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, Label, Missing, fmtDuration, fmtPct } from './shared';

const KIND_LABELS: Record<string, string> = {
  telegram_reply: 'Telegram replies',
  cron_delivery: 'Scheduled updates',
  pm_notify: 'Notifications',
  blocking_question: 'Blocking questions',
  host_alert: 'Host alerts',
};

/**
 * Ciaran's attention: every message that reached him, counted and never
 * quoted. Unsolicited messages are the cost; solicited ones are replies to
 * conversations he started.
 */
export function AttentionCard({ attention, measuring, rangeDays, taskTitle }: {
  attention: Attention;
  measuring: boolean;
  rangeDays: number;
  taskTitle: (taskId: string) => string | null;
}) {
  const a = attention;
  return (
    <Card icon={BellRing} title="Ciaran's attention"
      aside={!measuring && a.total > 0 ? <span className="text-xs text-zinc-500 font-medium">{a.total} message{a.total === 1 ? '' : 's'}</span> : undefined}>
      {measuring ? (
        <CardSkeleton rows={5} />
      ) : !a.tracked ? (
        <Missing>Attention telemetry has not reported yet. Messages appear once the host publishes attention.message rows.</Missing>
      ) : a.total === 0 ? (
        <Missing>No messages reached Ciaran in this range.</Missing>
      ) : (
        <div className="p-5 space-y-5">
          <ul className="divide-y divide-white/[0.06] -my-2">
            {a.rows.map((row) => (
              <li key={row.agentId ?? 'fleet'} className="py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-200 truncate">{row.name}</p>
                    <p className="text-[11px] text-zinc-500">
                      {(row.unsolicited / rangeDays).toFixed(1)} unsolicited a day · {row.solicited} solicited
                    </p>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    {row.dailyUnsolicited.some((v) => v > 0) && (
                      <Sparkline data={row.dailyUnsolicited} className="text-zinc-500" />
                    )}
                    <span className="text-sm font-semibold text-white tabular-nums">{row.total}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {Object.entries(row.byKind).sort((x, y) => y[1] - x[1]).map(([kind, count]) => (
                    <span key={kind} className="text-[11px] px-1.5 py-0.5 rounded bg-white/[0.05] text-zinc-400">
                      {KIND_LABELS[kind] ?? kind} {count}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          {a.hostAlertShare !== null && (
            <p className="text-[11px] text-zinc-500">
              {fmtPct(a.hostAlertShare)} of messages were host alerts rather than an agent speaking.
            </p>
          )}

          <div className="grid sm:grid-cols-2 gap-5 pt-3 border-t border-white/[0.08]">
            <div>
              <Label>Blocking questions per task</Label>
              {a.blockingByTask.length === 0 ? (
                <p className="text-xs text-zinc-500">No blocking questions in range.</p>
              ) : (
                <ul className="space-y-1">
                  {a.blockingByTask.slice(0, 6).map((row) => (
                    <li key={row.taskId} className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-zinc-400 truncate">{taskTitle(row.taskId) ?? 'Task not in workspace'}</span>
                      <span className="text-sm font-semibold text-zinc-200 tabular-nums">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <Label>
                <Defined hint="From an agent's blocked event on a task to its next sign of progress on that task (billing resumed, or any work event). Median and 95th percentile.">
                  Blocked to resumed
                </Defined>
              </Label>
              {a.blockedToResume.samples === 0 && a.blockedToResume.unresolved === 0 ? (
                <p className="text-xs text-zinc-500">No blocked events on a task in range.</p>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm text-zinc-300">
                    {a.blockedToResume.medianMs === null ? 'None resumed yet' : (
                      <>Median <span className="font-semibold text-white">{fmtDuration(a.blockedToResume.medianMs)}</span>
                        {' · '}p95 <span className="font-semibold text-white">{fmtDuration(a.blockedToResume.p95Ms ?? 0)}</span></>
                    )}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {a.blockedToResume.samples} resumed · {a.blockedToResume.unresolved} still blocked
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
