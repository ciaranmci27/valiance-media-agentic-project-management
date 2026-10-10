'use client';

import { Cpu } from 'lucide-react';
import type { EvalPoint, ModelRun } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Label, fmtDay, fmtPct, fmtWhen } from './shared';

/**
 * Which model answered for each agent over time, and each eval suite's score
 * history with the model on every point, so a drop after a model switch or a
 * rules change is visible. Only complete runs are connected: a partial run is
 * not comparable and stands alone.
 */
export function ModelsEvalsCard({ models, evals, measuring, withheldReason }: {
  models: { agentId: string; agentName: string; runs: ModelRun[] }[];
  evals: { suite: string; points: EvalPoint[] }[];
  measuring: boolean;
  withheldReason: string | null;
}) {
  return (
    <Card icon={Cpu} title="Models and evals">
      {measuring ? (
        <CardSkeleton rows={4} />
      ) : (
        <div className="p-5 grid md:grid-cols-2 gap-6">
          <div>
            <Label>Model per agent</Label>
            {withheldReason ? (
              <p className="text-xs text-zinc-500">{withheldReason}</p>
            ) : models.length === 0 ? (
              <p className="text-xs text-zinc-500">No turn in range names its model yet. Models appear once turns carry the model field.</p>
            ) : (
              <ul className="space-y-3">
                {models.map((row) => (
                  <li key={row.agentId}>
                    <p className="text-sm font-medium text-zinc-200">{row.agentName}</p>
                    <ol className="mt-1 space-y-0.5">
                      {row.runs.map((run, i) => (
                        <li key={`${run.model}:${i}`} className="text-[11px] text-zinc-400 flex items-baseline justify-between gap-3">
                          <code className="text-zinc-300 truncate">{run.model}</code>
                          <span className="text-zinc-500 flex-shrink-0">
                            {fmtDay(run.from)}{fmtDay(run.from) !== fmtDay(run.to) ? ` to ${fmtDay(run.to)}` : ''} · {run.turns} turn{run.turns === 1 ? '' : 's'}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <Label>Eval scores</Label>
            {evals.length === 0 ? (
              <p className="text-xs text-zinc-500">No eval runs in range. A score appears after each real run of an eval suite.</p>
            ) : (
              <div className="space-y-5">
                {evals.map((suite) => <EvalChart key={suite.suite} suite={suite.suite} points={suite.points} />)}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function EvalChart({ suite, points }: { suite: string; points: EvalPoint[] }) {
  const W = 300;
  const H = 90;
  const PAD = 8;
  const first = points[0].at;
  const last = points[points.length - 1].at;
  const x = (at: number) => (last === first ? W / 2 : PAD + ((at - first) / (last - first)) * (W - PAD * 2));
  const y = (pct: number) => PAD + (1 - pct) * (H - PAD * 2);
  const complete = points.filter((p) => p.complete && p.pct !== null);
  const latest = complete[complete.length - 1] ?? null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <p className="text-sm font-medium text-zinc-200">{suite}</p>
        <p className="text-[11px] text-zinc-500">
          {latest ? <>Latest complete <span className="text-zinc-200 font-semibold">{latest.score}/{latest.total}</span>{latest.model ? ` on ${latest.model}` : ''}</> : 'No complete run yet'}
        </p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[90px] text-emerald-400" role="img"
        aria-label={`${suite} eval scores: ${points.map((p) => `${fmtWhen(p.at)} ${p.score} of ${p.total}${p.complete ? '' : ' (partial)'}${p.model ? ` on ${p.model}` : ''}`).join('; ')}`}>
        {[0, 0.5, 1].map((g) => (
          <line key={g} x1={0} x2={W} y1={y(g)} y2={y(g)} className="stroke-white/[0.06]" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        ))}
        {complete.length > 1 && (
          <polyline fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
            points={complete.map((p) => `${x(p.at).toFixed(1)},${y(p.pct!).toFixed(1)}`).join(' ')} />
        )}
        {points.filter((p) => p.pct !== null).map((p) => (
          <circle key={p.id} cx={x(p.at)} cy={y(p.pct!)} r={3.5}
            className={p.complete ? 'fill-emerald-400' : 'fill-transparent stroke-zinc-400'} strokeWidth={p.complete ? 0 : 1.5}>
            <title>{`${fmtWhen(p.at)}: ${p.score}/${p.total} (${fmtPct(p.pct!)})${p.complete ? '' : ', partial run'}${p.model ? `, ${p.model}` : ''}${p.failedCases.length ? `, failed ${p.failedCases.slice(0, 5).join(', ')}` : ''}`}</title>
          </circle>
        ))}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-zinc-500">
        <span>{fmtDay(first)}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-400" aria-hidden="true" />complete</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full border border-zinc-400" aria-hidden="true" />partial</span>
        </span>
        <span>{fmtDay(last)}</span>
      </div>
    </div>
  );
}
