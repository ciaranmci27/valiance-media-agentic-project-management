'use client';

import { useMemo } from 'react';
import { Markdown } from '@/components/ui/Markdown';
import { AlertTriangle } from 'lucide-react';

/**
 * A release's notes, markdown from CHANGELOG.md, rendered and sanitized the
 * way file previews render markdown. The notes are split at their "###"
 * headings so the Breaking section can stand out as the one to read first.
 */

interface NotesSection {
  title: string | null;
  body: string;
}

/** Splits at ## and ### headings, dropping a heading that only repeats the version. */
export function splitNotes(markdown: string, version: string): NotesSection[] {
  const sections: NotesSection[] = [];
  let current: NotesSection = { title: null, body: '' };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!heading) {
      current.body += `${line}\n`;
      continue;
    }
    const title = heading[1];
    // "## [1.5.0] - 2026-11-20" names the release the card already names.
    if (!line.startsWith('###') && title.includes(version)) continue;
    if (current.title || current.body.trim()) sections.push(current);
    current = { title, body: '' };
  }
  if (current.title || current.body.trim()) sections.push(current);
  return sections.filter((section) => section.body.trim());
}

export function ReleaseNotes({ notes, version }: { notes: string; version: string }) {
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
                {section.title}: read this before you update
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
