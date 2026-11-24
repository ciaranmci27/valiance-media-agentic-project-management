'use client';

import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown, rendered and sanitized the one way the app renders it (release
 * notes, brief entries; file previews use the same marked and DOMPurify).
 * Links open in a new tab, never in place of the app. Headings are kept
 * small so an entry never shouts over the page it sits in.
 */

function linkSafety(node: Element) {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}

// What Markdown produces, and nothing else. Text written by agents (and by
// anything that talks to an agent) renders here, so raw HTML in it must never
// restyle the page or draw a form: no style, class or id, no forms, no images
// (a remote image is a tracking beacon).
const MARKDOWN_TAGS = [
  'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];
const MARKDOWN_ATTRS = ['href', 'title'];

export function markdownToHtml(markdown: string): string {
  // No DOM on the server: markdown only ever renders in the browser.
  if (typeof window === 'undefined' || !DOMPurify.isSupported) return '';
  DOMPurify.addHook('afterSanitizeAttributes', linkSafety);
  try {
    return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string, {
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: MARKDOWN_ATTRS,
      ALLOW_DATA_ATTR: false,
    });
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes', linkSafety);
  }
}

export const MARKDOWN_PROSE = [
  'text-sm leading-relaxed text-zinc-300 break-words',
  '[&_p]:my-2 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-1 [&_li]:pl-0.5',
  '[&_a]:text-brand-300 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:decoration-2',
  '[&_strong]:font-semibold [&_strong]:text-zinc-100',
  '[&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.85em] [&_code]:text-zinc-200',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-white/[0.04] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-[15px] [&_h1]:font-semibold [&_h1]:text-white',
  '[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-zinc-100',
  '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-zinc-100',
  '[&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:text-sm [&_h4]:font-medium [&_h4]:text-zinc-100',
  '[&_blockquote]:my-2 [&_blockquote]:rounded-lg [&_blockquote]:bg-white/[0.03] [&_blockquote]:px-3 [&_blockquote]:py-2',
  '[&_hr]:my-3 [&_hr]:border-white/[0.08]',
].join(' ');

export function Markdown({ markdown, className = '' }: { markdown: string; className?: string }) {
  const html = useMemo(() => markdownToHtml(markdown), [markdown]);
  return <div className={`${MARKDOWN_PROSE} ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
