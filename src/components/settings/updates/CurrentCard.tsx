'use client';

import { AlertTriangle, CircleArrowUp, CircleCheck, PartyPopper, RotateCw } from 'lucide-react';
import type { UpdatesState } from '@/lib/updates/types';
import { Button } from '@/components/ui/Button';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ReleaseNotes } from './ReleaseNotes';
import { ReleaseChips } from './WhatsNew';
import { releaseDate } from './updates-data';
import { CheckButton, Disclosure, ExternalLinkText, Mono, checkedLabel } from './parts';

/**
 * Settings > Updates with nothing to install: a calm confirmation of the
 * version this app runs, when GitHub was last asked, and that version's notes
 * folded away. Right after an update lands it says so once ("You're on
 * 2.0.43"), with what changed and whether its database changes landed.
 * The source install says releases are published from here.
 */
export function CurrentCard({
  state,
  checking,
  onCheck,
  justUpdated,
  onDismissUpdated,
}: {
  state: UpdatesState;
  checking: boolean;
  onCheck: () => void;
  /** This app just moved to `state.current` through this page. */
  justUpdated: boolean;
  onDismissUpdated: () => void;
}) {
  const source = state.role === 'source';
  // The notes of the version running now, when the newest release is this one.
  const notes = state.latest && state.latest.version === state.current ? state.latest : null;
  const checkAction = (
    <div className="flex flex-shrink-0 items-center gap-2.5">
      <span className="hidden text-[11px] text-zinc-400 sm:inline" aria-live="polite">{checking ? 'Asking GitHub' : checkedLabel(state.checkedAt)}</span>
      <CheckButton checking={checking} onCheck={onCheck} />
    </div>
  );

  if (justUpdated && !source) {
    return (
      <section className="glass-card rounded-xl p-4 lg:p-5" aria-labelledby="updates-heading">
        <SettingsSectionHeader
          icon={PartyPopper}
          title={<>You&apos;re on <span className="font-mono">{state.current}</span></>}
          headingId="updates-heading"
          description="The update is live. Here's what changed."
          action={<Button size="sm" variant="secondary" onClick={onDismissUpdated}>Done</Button>}
        />
        <div className="space-y-4">
          <DatabaseFollowUp state={state} />
          {notes && (
            <div className="rounded-lg bg-white/[0.03] px-4 py-3.5">
              <div className="mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <h3 className="text-sm font-medium text-white">What changed in <Mono>{notes.version}</Mono></h3>
                <ReleaseChips release={notes} />
                <span className="ml-auto text-xs"><ExternalLinkText href={notes.url}>On GitHub</ExternalLinkText></span>
              </div>
              <ReleaseNotes notes={notes.notes} version={notes.version} installed />
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5" aria-labelledby="updates-heading">
      <SettingsSectionHeader
        icon={source ? CircleArrowUp : CircleCheck}
        title={source ? 'Updates' : state.releasesError ? <>You&apos;re on <span className="font-mono">{state.current}</span></> : 'You\'re up to date'}
        headingId="updates-heading"
        description={source
          ? <>You&apos;re on <Mono>{state.current}</Mono>, the source install. Releases are published from here.</>
          : state.releasesError
            ? 'Couldn\'t check for newer versions just now.'
            : <>Running <Mono>{state.current}</Mono>, the newest version.</>}
        action={checkAction}
      />

      <p className="-mt-3 mb-4 text-[11px] text-zinc-400 sm:hidden">{checking ? 'Asking GitHub' : checkedLabel(state.checkedAt)}</p>

      {state.releasesError && (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-white/[0.03] px-3.5 py-2.5">
          <p className="min-w-0 flex-1 text-xs text-zinc-400">{state.releasesError}</p>
          <Button size="sm" variant="ghost" onClick={onCheck} disabled={checking} icon={<RotateCw size={12} aria-hidden="true" />}>
            Try again
          </Button>
        </div>
      )}

      {source && state.latest && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm">
          <span className="text-zinc-400">Latest public release</span>
          <span className="text-zinc-100"><Mono>{state.latest.version}</Mono></span>
          {releaseDate(state.latest.publishedAt) && <span className="text-xs text-zinc-400">{releaseDate(state.latest.publishedAt)}</span>}
          <span className="ml-auto text-xs"><ExternalLinkText href={state.latest.url}>On GitHub</ExternalLinkText></span>
        </div>
      )}
      {source && !state.latest && !state.releasesError && (
        <p className="rounded-lg bg-white/[0.03] px-3.5 py-3 text-sm text-zinc-400">No public release yet.</p>
      )}

      {!source && notes && (
        <div className="border-t border-white/[0.06] pt-3">
          <Disclosure
            id="current-release-notes"
            summary={
              <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span>What&apos;s in <Mono>{notes.version}</Mono></span>
                {releaseDate(notes.publishedAt) && <span className="text-xs font-normal text-zinc-400">{releaseDate(notes.publishedAt)}</span>}
              </span>
            }
          >
            <ReleaseNotes notes={notes.notes} version={notes.version} installed />
            <p className="mt-3 text-xs"><ExternalLinkText href={notes.url}>On GitHub</ExternalLinkText></p>
          </Disclosure>
        </div>
      )}
    </section>
  );
}

/** After an update: whether the database changes it carried have landed. */
function DatabaseFollowUp({ state }: { state: UpdatesState }) {
  const database = state.database;
  const changedDatabase = !!state.latest?.hasMigrations && state.latest.version === state.current;
  const link = <a href="#updates-database" className="rounded font-medium text-brand-300 underline underline-offset-2 hover:decoration-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">See database updates</a>;

  if (database?.pending === null) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-500/[0.1] px-3.5 py-2.5 text-sm text-zinc-200">
        <AlertTriangle size={14} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
        <span className="min-w-0 flex-1">This database has no record of its changes yet, so this page can&apos;t tell if they landed.</span>
        {link}
      </p>
    );
  }
  if (database && database.pending.length > 0) {
    const count = database.pending.length;
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-500/[0.1] px-3.5 py-2.5 text-sm text-zinc-200">
        <AlertTriangle size={14} className="flex-shrink-0 text-amber-300" aria-hidden="true" />
        <span className="min-w-0 flex-1">{count === 1 ? '1 database change hasn\'t been applied yet.' : `${count} database changes haven't been applied yet.`}</span>
        {link}
      </p>
    );
  }
  if (database && changedDatabase) {
    return (
      <p className="flex items-center gap-2 text-sm text-zinc-300">
        <CircleCheck size={14} className="flex-shrink-0 text-emerald-300" aria-hidden="true" />
        Its database changes are applied.
      </p>
    );
  }
  return null;
}
