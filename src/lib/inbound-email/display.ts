import { htmlToText } from './html-text';

/**
 * How the Inbox shows an email, the pure parts: which body opens first, the
 * inline images an HTML body references, and links in text cut down to a
 * readable name so tracking URLs never pour across the page.
 */

export type TextPart = { text: string } | { url: string; label: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'()[\]{}]+/gi;
// A link a mail client wrapped after its label: "View job (https://...)", "<https://...>", "[https://...]".
const WRAPPERS: Record<string, string> = { '(': ')', '<': '>', '[': ']' };

/** "upwork.com" for a long tracking link, "acme.com/pricing" for a short readable one. */
export function shortUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    return path && path.length <= 24 && !url.search && !/[0-9a-f]{16}|[A-Za-z0-9_-]{32}/.test(path) ? `${host}${path}` : host;
  } catch {
    return raw.slice(0, 40);
  }
}

/** The text with every web link split out, its wrapping brackets dropped. */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    let start = match.index;
    let url = match[0].replace(/[.,;:!?]+$/, '');
    let end = start + url.length;
    const open = text[start - 1];
    if (open && WRAPPERS[open] && text[end] === WRAPPERS[open]) {
      start -= 1;
      end += 1;
    } else if (open === '(' && url.endsWith(')')) {
      url = url.slice(0, -1);
    }
    let before = text.slice(at, start);
    // "label (url)": the space before the bracket goes with the bracket.
    if (start < match.index) before = before.replace(/[ \t]+$/, ' ');
    if (before) parts.push({ text: before });
    parts.push({ url, label: shortUrl(url) });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** Links longer than this read as tracking links in the agent's copy. */
const LONG_LINK = 80;

/**
 * The text with each long link (tracking redirects, mostly) replaced by
 * "[site link]". Short links stay whole: a shared document's address is
 * worth keeping. For the agent's copy of an email, where tracking URLs
 * would otherwise fill the read and push the real words past the cap.
 */
export function compactLinks(text: string | null): string | null {
  if (!text) return text;
  return linkParts(text).map((part) => {
    if ('text' in part) return part.text;
    return part.url.length > LONG_LINK ? `[${part.label} link]` : part.url;
  }).join('');
}

/** The cid: references in an HTML body, lowercased and without angle brackets. */
export function inlineImageIds(html: string | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const match of (html ?? '').matchAll(/cid:([^"'\s)>]+)/gi)) ids.add(normalizeContentId(match[1]));
  return ids;
}

export function normalizeContentId(value: string): string {
  let id = value.trim();
  try { id = decodeURIComponent(id); } catch { /* keep as is */ }
  return id.replace(/^<|>$/g, '').toLowerCase();
}

/** HTML a mail client marked as quoted history (the frame can drop it to show only the reply). */
export function hasQuotedHtml(html: string | null | undefined): boolean {
  return /class\s*=\s*["'][^"']*\b(gmail_quote|yahoo_quoted|moz-cite-prefix)\b|type\s*=\s*["']?cite\b|id\s*=\s*["']?(divRplyFwdMsg|appendonsend)\b/i.test(html ?? '');
}

/**
 * Whether an email opens as its designed HTML. Yes when it has HTML and the
 * new text is the whole email (a newsletter, a notification, a first
 * message): the HTML loses nothing and reads as designed. A reply that
 * quotes history opens on the new text, with the full email a click away.
 */
export function opensAsHtml(message: { html_body: string | null; text_body: string | null; new_text: string | null; is_forward: boolean }): boolean {
  if (!message.html_body) return false;
  if (message.is_forward) return true;
  const fresh = (message.new_text ?? '').trim();
  if (!fresh) return true;
  const whole = (message.text_body?.trim() ? message.text_body : htmlToText(message.html_body)).trim();
  return fresh.length >= whole.length * 0.9;
}
