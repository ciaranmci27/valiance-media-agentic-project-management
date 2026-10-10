'use client';

import { BadgeCheck } from 'lucide-react';
import type { Quality } from '@/lib/agent-telemetry-analytics';
import { Card, CardSkeleton, Defined, fmtPct } from './shared';

/** Whether work held up: approved first time, stayed done, stayed merged. */
export function QualityCard({ quality, measuring }: { quality: Quality; measuring: boolean }) {
  const q = quality;
  // A calendar date (when tracking was installed), so it is read in UTC.
  const sinceLabel = q.reopenedSince
    ? new Date(q.reopenedSince).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
    : null;
  const tiles: { label: string; hint: string; value: string; sub: string }[] = [
    {
      label: 'First-pass approval',
      hint: 'Tasks John approved at review round 1, with no changes-requested round before it, over all tasks approved in range.',
      value: q.firstPassRate === null ? 'No approvals' : fmtPct(q.firstPassRate),
      sub: q.approvals > 0 ? `${q.firstPass} of ${q.approvals} approved tasks` : 'none in range',
    },
    {
      label: 'Review rounds per task',
      hint: 'Distinct review rounds over distinct tasks reviewed in range.',
      value: q.roundsPerTask === null ? 'No reviews' : q.roundsPerTask.toFixed(1),
      sub: q.tasksReviewed > 0 ? `${q.reviewRounds} rounds on ${q.tasksReviewed} tasks` : 'none in range',
    },
    {
      label: 'Reopened after done',
      hint: 'Tasks moved out of done, recorded by the database whoever moved them. Reopens before tracking began were never stored.',
      value: q.reopened === null ? 'Not tracked' : String(q.reopened),
      sub: q.reopened === null ? 'reopen tracking is not installed yet' : sinceLabel ? `recorded since ${sinceLabel}` : 'in range',
    },
    {
      label: 'Reverted after merge',
      hint: 'A later merged PR in the same repository titled Revert "<original title>", which is what GitHub\'s revert writes. Only merges made by the agents send an event; a revert merged by a person in GitHub does not, so this is a lower bound and never claims zero.',
      value: q.revertedAtLeast === null ? 'Not tracked' : `At least ${q.revertedAtLeast}`,
      sub: !q.revertTitlesReported
        ? 'merge events carry no PR title yet'
        : q.revertedAtLeast === null
          ? 'reverts merged in GitHub by a person send no event'
          : `of ${q.mergedPrs} merged in range; GitHub-merged reverts are not visible`,
    },
  ];
  return (
    <Card icon={BadgeCheck} title="Quality">
      {measuring ? (
        <CardSkeleton rows={4} />
      ) : (
        <div className="p-5">
          <div className="grid grid-cols-2 gap-4">
            {tiles.map((tile) => (
              <div key={tile.label}>
                <Defined hint={tile.hint}><span className="text-xs text-zinc-500">{tile.label}</span></Defined>
                <p className={`text-xl font-bold mt-1 ${tile.value.startsWith('No') || tile.value === 'Not tracked' ? 'text-zinc-500 text-base' : 'text-white'}`}>
                  {tile.value}
                </p>
                <p className="text-[11px] text-zinc-500">{tile.sub}</p>
              </div>
            ))}
          </div>
          {q.revertedPrs.length > 0 && (
            <ul className="mt-4 pt-3 border-t border-white/[0.08] space-y-1">
              {q.revertedPrs.map((row) => (
                <li key={row.prUrl} className="text-xs text-zinc-400 truncate">
                  <a href={row.prUrl} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-white underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
                    {row.prUrl.replace(/^https:\/\/github\.com\//, '')}
                  </a>
                  {' reverted by '}
                  <a href={row.revertUrl} target="_blank" rel="noreferrer" className="text-zinc-300 hover:text-white underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 rounded">
                    {row.revertUrl.replace(/^https:\/\/github\.com\//, '')}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
