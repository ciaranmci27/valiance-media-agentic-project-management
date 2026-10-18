'use client';

import { BellRing } from 'lucide-react';
import { Sparkline } from '@/components/ui/Sparkline';
import type { Attention } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Disclosure, MiniStat, Missing, StatRow, fmtDuration, fmtPct } from './shared';

const KIND_LABELS: Record<string, string> = {
  telegram_reply: 'replies',
  cron_delivery: 'scheduled updates',
  pm_notify: 'notifications',
  blocking_question: 'blocking questions',
  host_alert: 'host alerts',
};

/**
 * Human attention: every agent message that reached a person, counted and
 * never quoted. Unsolicited messages are the cost; solicited ones are replies
 * to conversations a person started.
 */
export function AttentionCard({ attention, measuring, rangeDays, taskTitle }: {
  attention: Attention;
  measuring: boolean;
  rangeDays: number;
  taskTitle: (taskId: string) => string | null;
}) {
  const a = attention;
  const unsolicited = a.rows.reduce((sum, row) => sum + row.unsolicited, 0);
  const b = a.blockedToResume;
  return (
    <Card icon={BellRing} title="Human attention">
      {measuring ? (
        <CardSkeleton rows={4} />
      ) : !a.tracked ? (
        <Missing>Attention telemetry has not reported yet. Messages appear once the host publishes them.</Missing>
      ) : a.total === 0 ? (
        <Missing>No agent messages reached a person in this range.</Missing>
      ) : (
        <div className="p-5 space-y-4">
          <StatRow columns={3}>
            <MiniStat
              label="Messages"
              value={String(a.total)}
              sub={a.hostAlertShare ? `${fmtPct(a.hostAlertShare)} host alerts` : 'all from agents'}
            />
            <MiniStat
              label="Unsolicited a day"
              hint="Messages nobody asked for (updates, notifications, questions, alerts), averaged over the days in range."
              value={(unsolicited / rangeDays).toFixed(1)}
              sub={`${unsolicited} in range`}
            />
            <MiniStat
              label="Blocked to resumed"
              hint="From an agent's blocked event on a task to its next sign of progress on that task: median, with the 95th percentile below."
              value={b.medianMs === null ? null : fmtDuration(b.medianMs)}
              empty={b.unresolved > 0 ? 'None resumed' : 'No blocks'}
              sub={b.medianMs !== null ? `p95 ${fmtDuration(b.p95Ms ?? 0)} · ${b.unresolved} still blocked` : b.unresolved > 0 ? `${b.unresolved} still blocked` : undefined}
            />
          </StatRow>

          <ul className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
            {a.rows.map((row) => (
              <li key={row.agentId ?? 'fleet'} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200 truncate">{row.name}</p>
                  <p className="text-[11px] text-zinc-500 truncate">
                    {Object.entries(row.byKind).sort((x, y) => y[1] - x[1]).map(([kind, count]) => `${count} ${KIND_LABELS[kind] ?? kind}`).join(' · ')}
                  </p>
                </div>
                {row.dailyUnsolicited.some((v) => v > 0) && (
                  <Sparkline data={row.dailyUnsolicited} className="text-zinc-500 flex-shrink-0" />
                )}
                <span className="text-sm font-semibold text-white tabular-nums w-8 text-right flex-shrink-0">{row.total}</span>
              </li>
            ))}
          </ul>

          {a.blockingByTask.length > 0 && (
            <Disclosure label="Blocking questions by task" count={a.blockingByTask.length}>
              <ul className="space-y-1">
                {a.blockingByTask.map((row) => (
                  <li key={row.taskId} className="flex items-baseline justify-between gap-3 text-xs">
                    <span className="text-zinc-400 truncate">{taskTitle(row.taskId) ?? 'Task not in workspace'}</span>
                    <span className="text-zinc-300 tabular-nums">{row.count}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </Card>
  );
}
