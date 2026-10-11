'use client';

import { Coins } from 'lucide-react';
import type { TimeLine, TokenView } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Label, LINE_STYLE, MiniStat, Missing, StatRow, fmtCount, fmtPct } from './shared';

const RATIOS = [
  { ratio: 'perMergedPr', count: 'mergedPrs', label: 'Per merged PR' },
  { ratio: 'perAcceptedSuggestion', count: 'acceptedSuggestions', label: 'Per accepted suggestion' },
  { ratio: 'perTask', count: 'tasksWorked', label: 'Per task worked' },
] as const;

/**
 * Tokens: one ledger, two views. The usage ledger is the total (and the cost);
 * turn tokens attribute part of it to what each turn was. Attribution is never
 * added to the ledger, and the unattributed remainder is shown, not hidden.
 */
export function TokensCard({ tokens, measuring, withheldReason }: {
  tokens: TokenView;
  measuring: boolean;
  withheldReason: string | null;
}) {
  const t = tokens;
  // Only the ratios and agents that have something to divide by.
  const columns = RATIOS.filter((c) => t.perAgent.some((row) => row[c.ratio] !== null));
  const rows = t.perAgent.filter((row) => columns.some((c) => row[c.ratio] !== null));

  return (
    <Card icon={Coins} title="Tokens">
      {measuring ? (
        <CardSkeleton rows={4} />
      ) : withheldReason ? (
        <Missing>{withheldReason}</Missing>
      ) : t.ledgerTokens === null && t.attributedTokens === 0 ? (
        <Missing>Usage telemetry has not reported for this selection, so there are no tokens to show.</Missing>
      ) : (
        <div className="p-5 space-y-5">
          <StatRow columns={3}>
            <MiniStat
              label="Usage ledger"
              hint="Hermes' usage ledger: input, output and cached tokens per session. The total, and the source of model cost."
              value={t.ledgerTokens === null ? null : fmtCount(t.ledgerTokens)}
              empty="Not reported"
            />
            <MiniStat
              label="Attributed to turns"
              hint="Tokens tied to a specific turn: scheduled turns report their own, directed turns take their session's usage. Older turns carry none."
              value={fmtCount(t.attributedTokens)}
              sub={t.ledgerTokens ? `${fmtPct(Math.min(1, t.attributedTokens / t.ledgerTokens))} of the ledger` : undefined}
            />
            <MiniStat
              label="Idle-token share"
              hint="Idle checks, waiting and skipped turns, over every token attributed to a turn."
              value={t.idleShare === null ? null : fmtPct(t.idleShare)}
              valueClass={t.idleShare !== null && t.idleShare > 0.5 ? 'text-amber-400' : 'text-white'}
            />
          </StatRow>

          {t.byOutcome.length > 0 && (
            <div>
              <Label>By outcome</Label>
              <div className="flex h-2 rounded-full overflow-hidden bg-white/[0.04]" role="img"
                aria-label={`Attributed tokens by outcome: ${t.byOutcome.map((s) => `${LINE_STYLE[s.outcome as TimeLine].label} ${fmtCount(s.tokens)}`).join(', ')}`}>
                {t.byOutcome.map((slice) => (
                  <div key={slice.outcome} className={LINE_STYLE[slice.outcome as TimeLine].bar} style={{ width: `${(slice.tokens / t.attributedTokens) * 100}%` }} />
                ))}
              </div>
              <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1">
                {t.byOutcome.map((slice) => (
                  <li key={slice.outcome} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${LINE_STYLE[slice.outcome as TimeLine].dot}`} aria-hidden="true" />
                      <span className="text-zinc-400 truncate">{LINE_STYLE[slice.outcome as TimeLine].label}</span>
                    </span>
                    <span className="text-zinc-300 tabular-nums">{fmtCount(slice.tokens)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rows.length > 0 && (
            <div>
              <Label>Tokens per output</Label>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <caption className="sr-only">Usage-ledger tokens divided by each agent&apos;s outputs in range</caption>
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                      <th scope="col" className="text-left font-medium pb-1.5 pr-2">Agent</th>
                      {columns.map((c) => <th key={c.ratio} scope="col" className="text-right font-medium pb-1.5 pl-2">{c.label}</th>)}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {rows.map((row) => (
                      <tr key={row.agentId}>
                        <th scope="row" className="text-left font-medium text-zinc-300 py-1.5 pr-2">{row.agentName}</th>
                        {columns.map((c) => (
                          <td key={c.ratio} className="text-right py-1.5 pl-2 tabular-nums">
                            {row[c.ratio] === null ? <span className="text-zinc-600">-</span> : (
                              <span className="text-zinc-200">{fmtCount(row[c.ratio]!)} <span className="text-zinc-500">/ {row[c.count]}</span></span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-zinc-500 mt-2">The whole ledger divided by each output, so idle and waiting tokens are part of every figure.</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
