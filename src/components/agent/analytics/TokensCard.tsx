'use client';

import { Coins } from 'lucide-react';
import type { TimeLine, TokenView } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, Label, LINE_STYLE, Missing, fmtCount, fmtPct } from './shared';

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
  const ratioRows = t.perAgent.filter((row) => row.ledgerTokens !== null
    && (row.mergedPrs > 0 || row.acceptedSuggestions > 0 || row.tasksWorked > 0));

  return (
    <Card icon={Coins} title="Tokens">
      {measuring ? (
        <CardSkeleton rows={5} />
      ) : withheldReason ? (
        <Missing>{withheldReason}</Missing>
      ) : t.ledgerTokens === null && t.attributedTokens === 0 ? (
        <Missing>Usage telemetry has not reported for this selection, so there are no tokens to show.</Missing>
      ) : (
        <div className="p-5 space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Defined hint="Hermes' usage ledger: input, output and cached tokens per session. The total, and the source of model cost.">
                <span className="text-xs text-zinc-500">Usage ledger</span>
              </Defined>
              <p className="text-xl font-bold text-white mt-1">{t.ledgerTokens === null ? 'Not reported' : fmtCount(t.ledgerTokens)}</p>
            </div>
            <div>
              <Defined hint="Idle checks, waiting and skipped turns, over every token attributed to a turn.">
                <span className="text-xs text-zinc-500">Idle-token share</span>
              </Defined>
              <p className="text-xl font-bold text-zinc-200 mt-1">{t.idleShare === null ? 'Not measured' : fmtPct(t.idleShare)}</p>
            </div>
          </div>

          <div>
            <Label>Tokens by outcome</Label>
            {t.byOutcome.length === 0 ? (
              <p className="text-xs text-zinc-500">
                No turn carries tokens yet. Scheduled turns report their own tokens once the new publisher runs; directed turns take their session&apos;s usage.
              </p>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {t.byOutcome.map((slice) => {
                    const style = LINE_STYLE[slice.outcome as TimeLine];
                    return (
                      <li key={slice.outcome} className="flex items-baseline justify-between gap-3">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className={`w-2 h-2 rounded-sm flex-shrink-0 ${style.dot}`} aria-hidden="true" />
                          <span className="text-sm text-zinc-400 truncate">{style.label}</span>
                        </span>
                        <span className="text-sm font-semibold text-zinc-200">
                          {fmtCount(slice.tokens)}
                          <span className="text-zinc-500 font-normal"> · {slice.turns} turn{slice.turns === 1 ? '' : 's'}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[11px] text-zinc-500 mt-2">
                  {fmtCount(t.attributedTokens)} attributed to a turn
                  {t.ledgerTokens !== null && t.ledgerTokens > 0 && ` (${fmtPct(Math.min(1, t.attributedTokens / t.ledgerTokens))} of the ledger)`}.
                  Turns published before turn tokens existed carry none, so they are not attributed.
                </p>
              </>
            )}
          </div>

          <div>
            <Label>Tokens per output</Label>
            {ratioRows.length === 0 ? (
              <p className="text-xs text-zinc-500">No merged pull requests, accepted suggestions or worked tasks in range to divide by.</p>
            ) : (
              <div className="overflow-x-auto -mx-1">
                <table className="w-full text-sm">
                  <caption className="sr-only">Usage-ledger tokens per merged PR, per accepted suggestion and per task worked, by agent</caption>
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-zinc-500">
                      <th scope="col" className="text-left font-medium px-1 pb-1.5">Agent</th>
                      <th scope="col" className="text-right font-medium px-1 pb-1.5">Per merged PR</th>
                      <th scope="col" className="text-right font-medium px-1 pb-1.5">Per accepted suggestion</th>
                      <th scope="col" className="text-right font-medium px-1 pb-1.5">Per task worked</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {ratioRows.map((row) => (
                      <tr key={row.agentId}>
                        <th scope="row" className="text-left font-medium text-zinc-300 px-1 py-1.5">{row.agentName}</th>
                        {([['perMergedPr', 'mergedPrs'], ['perAcceptedSuggestion', 'acceptedSuggestions'], ['perTask', 'tasksWorked']] as const).map(([ratio, count]) => (
                          <td key={ratio} className="text-right px-1 py-1.5 text-zinc-200">
                            {row[ratio] === null ? <span className="text-zinc-600">-</span> : (
                              <>
                                {fmtCount(row[ratio]!)}
                                <span className="block text-[10px] text-zinc-500">{row[count]} in range</span>
                              </>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-zinc-500 mt-2">
              The agent&apos;s whole usage ledger in range divided by each output, so idle and waiting tokens are part of each figure.
            </p>
          </div>
        </div>
      )}
    </Card>
  );
}
