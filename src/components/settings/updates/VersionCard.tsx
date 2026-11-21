'use client';

import { CircleArrowUp, CircleCheck, RotateCw } from 'lucide-react';
import type { UpdatesState } from '@/lib/updates/types';
import { timeAgo } from '@/lib/task-times';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { newestPending, releaseDate } from './updates-data';
import { ExternalLinkText, Mono } from './parts';

const DESCRIPTION = 'New versions of the app, what changed in them, and one place to install them.';

/** "Checked 5 min ago", "Checked yesterday", "Checked Oct 24". */
function checkedLabel(iso: string | null): string {
  if (!iso) return 'Not checked yet';
  const ago = timeAgo(iso);
  // Dates stay capitalised ("Oct 24"); the words read mid-sentence.
  return `Checked ${ago === 'Just now' || ago === 'Yesterday' ? ago.toLowerCase() : ago}`;
}

/**
 * The top of Settings > Updates: the version this app runs, whether a newer
 * one is out, when that was last asked of GitHub, and Check now.
 */
export function VersionCard({
  state,
  checking,
  onCheck,
}: {
  state: UpdatesState;
  checking: boolean;
  onCheck: () => void;
}) {
  const source = state.role === 'source';
  const newest = newestPending(state);
  const behind = state.pending.length;

  const checkNow = (
    <Button size="sm" variant="secondary" onClick={onCheck} disabled={checking}
      icon={<RotateCw size={13} aria-hidden="true" className={checking ? 'animate-spin motion-reduce:animate-none' : undefined} />}>
      {checking ? 'Checking' : 'Check now'}
    </Button>
  );

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="updates-heading">
      <SettingsSectionHeader icon={CircleArrowUp} title="Updates" headingId="updates-heading" description={DESCRIPTION} />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-base font-medium text-white">
            You&apos;re on <Mono>{state.current}</Mono>.
          </p>
          {source ? (
            <p className="mt-1 text-sm text-zinc-400">This is the source install. Releases are published from here.</p>
          ) : newest ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-200">
              <span className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-sky-300" aria-hidden="true" />
              <span>
                <Mono>{newest.version}</Mono> is available.
                {behind > 1 && <span className="text-zinc-400"> You&apos;re {behind} releases behind.</span>}
              </span>
            </p>
          ) : !state.releasesError ? (
            <p className="mt-1 flex items-center gap-1.5 text-sm text-zinc-300">
              <CircleCheck size={14} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
              You&apos;re up to date.
            </p>
          ) : null}
        </div>

        <div className="flex flex-shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">
          {checkNow}
          <p className="text-[11px] text-zinc-400" aria-live="polite">{checking ? 'Asking GitHub' : checkedLabel(state.checkedAt)}</p>
        </div>
      </div>

      {source && state.latest && (
        <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm">
          <span className="text-zinc-400">Latest public release</span>
          <span className="text-zinc-100"><Mono>{state.latest.version}</Mono></span>
          {releaseDate(state.latest.publishedAt) && <span className="text-xs text-zinc-400">{releaseDate(state.latest.publishedAt)}</span>}
          <span className="ml-auto text-xs"><ExternalLinkText href={state.latest.url}>On GitHub</ExternalLinkText></span>
        </div>
      )}

      {source && !state.latest && !state.releasesError && (
        <p className="mt-5 rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-400">No public release yet.</p>
      )}

      {state.releasesError && (
        <div role="status" className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-white/[0.03] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-zinc-400">
            Couldn&apos;t check for new releases just now. {state.releasesError}
          </p>
          <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking}
            icon={<RotateCw size={12} aria-hidden="true" />}>
            Try again
          </Button>
        </div>
      )}
    </section>
  );
}
