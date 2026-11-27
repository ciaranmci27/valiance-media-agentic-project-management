'use client';

import { Pill } from '@/components/ui/Pill';
import { useState } from 'react';
import { AlertTriangle, ChevronDown, Database, Gift } from 'lucide-react';
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
        <Pill tone="waiting">
          <AlertTriangle size={11} aria-hidden="true" />
          Needs your attention
        </Pill>
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
    <li className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <h3 className="min-w-0">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls={bodyId}
            className="inline-flex items-center gap-2 rounded py-0.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <ChevronDown size={15} aria-hidden="true" className={`flex-shrink-0 text-zinc-400 motion-safe:transition-transform ${open ? '' : '-rotate-90'}`} />
            <span className="font-mono text-sm font-medium text-white">{release.version}</span>
            {date && <span className="text-xs text-zinc-400">{date}</span>}
          </button>
        </h3>
        <ReleaseChips release={release} />
        <span className="ml-auto text-xs"><ExternalLinkText href={release.url}>On GitHub</ExternalLinkText></span>
      </div>

      <div id={bodyId} hidden={!open} className="mt-3 pl-[23px]">
        {open && <ReleaseNotes notes={release.notes} version={release.version} />}
      </div>
    </li>
  );
}

/**
 * What changed in each release, newest first, one per row that opens on
 * request. Before an update the newest opens by itself; during one
 * ("What you're getting") they all start folded, so the progress stays the
 * one thing on the page.
 */
export function WhatsNew({
  releases,
  current,
  title = 'What\'s new',
  openNewest = true,
}: {
  /** Newest first. */
  releases: ReleaseInfo[];
  current: string;
  title?: string;
  openNewest?: boolean;
}) {
  const description = releases.length === 1
    ? `What changes when you update to ${releases[0].version}.`
    : openNewest
      ? `Everything since ${current}, newest first. Updating installs all of it at once.`
      : `Everything since ${current} that this update brings, newest first.`;

  return (
    <section className="glass-card rounded-xl p-4 lg:p-5" aria-labelledby="whats-new-heading">
      <SettingsSectionHeader icon={Gift} title={title} headingId="whats-new-heading" description={description} />
      <ul className="divide-y divide-white/[0.06]">
        {releases.map((release, index) => (
          <ReleaseSection key={release.version} release={release} initiallyOpen={openNewest && index === 0} />
        ))}
      </ul>
    </section>
  );
}
