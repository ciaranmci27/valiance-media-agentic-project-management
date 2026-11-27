import { safeLinkHref } from './safe-url';

/**
 * Rich text the app's editor writes (RichTextEditor: paragraphs, bold,
 * italic, strike, underline, lists, line breaks and links), made safe to put
 * in the page as HTML. Lead notes are written by members, by agents over
 * REST and by email triage from text in an inbound email, so they are never
 * trusted as HTML.
 *
 * Escape first, then turn back on only the editor's own tags, written
 * exactly as the editor writes them (no attributes, except a list's start
 * number and a link's address). Everything else stays visible as text, so a
 * `<script>`, `<img onerror>` or `style` can never reach the page. Works the
 * same on the server and in the browser (no DOM needed). Text with no
 * editor markup (an agent's or an email's plain notes) keeps its line breaks.
 */

const SIMPLE_TAGS = ['p', 'br', 'strong', 'b', 'em', 'i', 's', 'del', 'u', 'ul', 'ol', 'li'] as const;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtmlText(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function unescapeHtmlText(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

const SIMPLE_TAG = new RegExp(`&lt;(/?)(${SIMPLE_TAGS.join('|')})\\s*/?&gt;`, 'gi');
const ORDERED_LIST_START = /&lt;ol\s+start=&quot;(\d{1,6})&quot;\s*&gt;/gi;
// An opening link tag: attributes as the editor writes them, name="value".
// Inside an escaped value there is never a raw quote, only &quot; ends it.
const LINK_OPEN = /&lt;a((?:\s+[a-zA-Z-]+=&quot;(?:(?!&quot;)[^<>])*&quot;)*)\s*&gt;/gi;
const LINK_ATTR = /([a-zA-Z-]+)=&quot;((?:(?!&quot;)[^<>])*)&quot;/g;
const LINK_CLOSE = /&lt;\/a\s*&gt;/gi;
const LOOKS_LIKE_EDITOR_HTML = /<\/?(p|br|li|ul|ol|strong|em)\b/i;

function linkTag(attrs: string): string {
  let href: string | null = null;
  for (const match of attrs.matchAll(LINK_ATTR)) {
    // Undo this function's own escaping, then the attribute's (the editor
    // writes & as &amp;). Any other entity stays as is, so the check below
    // sees what it lets through, and the browser gets exactly that.
    if (match[1].toLowerCase() === 'href') href = safeLinkHref(unescapeHtmlText(unescapeHtmlText(match[2])));
  }
  if (!href) return '<a>';
  return `<a href="${escapeHtmlText(href)}" target="_blank" rel="noopener noreferrer nofollow">`;
}

export function richTextToSafeHtml(input: string | null | undefined): string {
  if (typeof input !== 'string' || !input) return '';
  const isEditorHtml = LOOKS_LIKE_EDITOR_HTML.test(input);
  let html = escapeHtmlText(input);
  if (!isEditorHtml) return html.replace(/\r?\n/g, '<br>');
  html = html
    .replace(SIMPLE_TAG, (_m, close: string, tag: string) => `<${close}${tag.toLowerCase()}>`)
    .replace(ORDERED_LIST_START, (_m, start: string) => `<ol start="${start}">`)
    .replace(LINK_OPEN, (_m, attrs: string) => linkTag(attrs))
    .replace(LINK_CLOSE, '</a>');
  return html;
}
