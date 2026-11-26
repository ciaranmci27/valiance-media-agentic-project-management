'use client';

import { useMemo } from 'react';
import { Markdown } from '@/components/ui/Markdown';
import { AlertTriangle } from 'lucide-react';
import { splitNotes } from './update-phase';

/**
 * A release's notes, markdown from CHANGELOG.md, rendered and sanitized the
 * way file previews render markdown. The notes are split at their "###"
 * headings so the Breaking section can stand out as the one to read first.
 */

/** `installed`: the release is already live, so Breaking reads as what to do now. */
export function ReleaseNotes({ notes, version, installed = false }: { notes: string; version: string; installed?: boolean }) {
  const sections = useMemo(() => splitNotes(notes, version), [notes, version]);
  if (sections.length === 0) {
    return <p className="text-sm text-zinc-400">No notes for this release.</p>;
  }
  return (
    <div className="space-y-4">
      {sections.map((section, index) => {
        const breaking = !!section.title && /^breaking/i.test(section.title);
        if (breaking) {
          return (
            <div key={index} className="rounded-lg bg-amber-500/[0.1] px-3.5 py-3">
              <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-amber-300">
                <AlertTriangle size={14} aria-hidden="true" className="flex-shrink-0" />
                {section.title}: {installed ? 'what you need to do' : 'read this before you update'}
              </h4>
              <Markdown markdown={section.body} />
            </div>
          );
        }
        return (
          <div key={index}>
            {section.title && (
              <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">{section.title}</h4>
            )}
            <Markdown markdown={section.body} />
          </div>
        );
      })}
    </div>
  );
}
