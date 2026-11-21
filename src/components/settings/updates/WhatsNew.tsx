'use client';

import { useState } from 'react';
import { AlertTriangle, ChevronDown, Database, Sparkles } from 'lucide-react';
import type { ReleaseInfo } from '@/lib/updates/types';
import { Tooltip } from '@/components/ui/Tooltip';
import { SettingsSectionHeader } from '@/components/settings/SettingsSectionHeader';
import { ReleaseNotes } from './ReleaseNotes';
import { releaseDate } from './updates-data';
import { ExternalLinkText } from './parts';

/** The chips a release can carry: what needs a person, and what touches the database. */
export function ReleaseChips({ release }: { release: ReleaseInfo }) {
  return (
    <>
      {release.breaking && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/[0.14] px-2 py-0.5 text-[11px] font-medium text-amber-300">
          <AlertTriangle size={11} aria-hidden="true" />
          Needs your attention
        </span>
      )}
      {release.hasMigrations && (
        <Tooltip content="This release updates your database when you apply it.">
          <span tabIndex={0}
            className="inline-flex items-center gap-1 rounded-full bg-white/[0.05] px-2 py-0.5 text-[11px] font-medium text-zinc-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
            <Database size={11} aria-hidden="true" />
            Changes the database
            <span className="sr-only">: this release updates your database when you apply it.</span>
          </span>
        </Tooltip>
      )}
    </>
  );
}

function ReleaseSection({ release, initiallyOpen }: { release: ReleaseInfo; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const bodyId = `release-notes-${release.version.replace(/\./g, '-')}`;
  const date = releaseDate(release.publishedAt);

  return (
    <li className="py-5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="font-mono text-sm font-medium text-white">{release.version}</h3>
        {date && <span className="text-xs text-zinc-400">{date}</span>}
        <ReleaseChips release={release} />
        <span className="ml-auto text-xs"><ExternalLinkText href={release.url}>On GitHub</ExternalLinkText></span>
      </div>

      <div id={bodyId} hidden={!open} className="mt-3">
        {open && <ReleaseNotes notes={release.notes} version={release.version} />}
      </div>

      {!initiallyOpen && (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-zinc-400 hover:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          {open ? 'Hide notes' : 'Show notes'}
        </button>
      )}
    </li>
  );
}

/**
 * What changed in each release this install has not got yet, newest first.
 * The newest release and any that need attention open with their notes; the
 * rest open on request, so the steps below stay close.
 */
export function WhatsNew({ pending, current }: { pending: ReleaseInfo[]; current: string }) {
  const newestFirst = [...pending].reverse();
  const description = newestFirst.length === 1
    ? `What changes when you update to ${newestFirst[0].version}.`
    : `Everything that changed since ${current}, newest first. Updating installs all of it at once.`;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-6" aria-labelledby="whats-new-heading">
      <SettingsSectionHeader icon={Sparkles} title="What's new" headingId="whats-new-heading" description={description} />
      <ul className="divide-y divide-white/[0.06]">
        {newestFirst.map((release, index) => (
          <ReleaseSection key={release.version} release={release} initiallyOpen={index === 0 || release.breaking} />
        ))}
      </ul>
    </section>
  );
}
