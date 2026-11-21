'use client';

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
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

/** Links in the notes open on GitHub in a new tab, never in place of the app. */
function linkSafety(node: Element) {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}

function toHtml(markdown: string): string {
  // No DOM on the server: notes only ever render in the browser.
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  DOMPurify.addHook('afterSanitizeAttributes', linkSafety);
  try {
    return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string, { USE_PROFILES: { html: true } });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', linkSafety);
  }
}

const PROSE = [
  'text-sm leading-relaxed text-zinc-300 break-words',
  '[&_p]:my-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_li]:pl-0.5',
  '[&_a]:text-brand-300 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:decoration-2',
  '[&_strong]:font-semibold [&_strong]:text-zinc-100',
  '[&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-zinc-200',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-white/[0.04] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-medium [&_h4]:text-zinc-100',
  '[&_blockquote]:my-2 [&_blockquote]:rounded-lg [&_blockquote]:bg-white/[0.03] [&_blockquote]:px-3 [&_blockquote]:py-2',
].join(' ');

function Markdown({ markdown }: { markdown: string }) {
  const html = useMemo(() => toHtml(markdown), [markdown]);
  return <div className={PROSE} dangerouslySetInnerHTML={{ __html: html }} />;
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
