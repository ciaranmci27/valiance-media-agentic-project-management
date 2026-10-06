import { normalizeAddress, parseAddressList } from './addresses';
import { hasForwardPrefix } from './subject';

/**
 * The original sender of a forwarded email, one layer deep: the outermost
 * forwarded message only, never one forwarded inside it. Ingestion asks this
 * only for mail from a verified teammate (routing by the original sender);
 * anything else routes by its visible sender.
 *
 * Strict on purpose. An inline forward is a recognizable forward header block
 * near the top of the body, allowing a short note above it:
 * - Gmail: "---------- Forwarded message ---------" then "From: Name <addr>";
 * - Apple Mail: "Begin forwarded message:" then "From: Name <addr>";
 * - Outlook: "-----Original Message-----", or a header block ("From:",
 *   "Sent:", "To:", "Subject:", optionally under a "_____" rule). Outlook
 *   writes the same block on a reply, so it counts only when the subject
 *   carries a forward prefix (FW:, Fwd:).
 * A reply's quoted history (an "On ... wrote:" line or ">" quoted lines)
 * ends the search, and so does anything past the note's limits: a "From:"
 * line further down never makes an email a forward.
 * A forward as attachment is a message/rfc822 (or .eml) part; its own From
 * header names the original sender (fromRfc822Head).
 */

export interface ForwardedSender {
  address: string;
  name: string;
}

/** How much note may sit above the forward block. */
const NOTE_MAX_LINES = 12;
const NOTE_MAX_CHARS = 1200;
/** Header lines read after a marker, and blank lines allowed before them. */
const BLOCK_MAX_LINES = 8;
const BLOCK_MAX_GAP = 2;

const FORWARD_MARKERS = [
  /^-{2,}\s*forwarded message\s*-{2,}$/i,
  /^begin forwarded message\s*:$/i,
  /^-{2,}\s*weitergeleitete nachricht\s*-{2,}$/i,
  /^-{2,}\s*message transf[ée]r[ée]\s*-{2,}$/i,
  /^-{2,}\s*mensaje reenviado\s*-{2,}$/i,
];
const ORIGINAL_MESSAGE = /^-{2,}\s*original message\s*-{2,}$/i;
const RULE = /^_{10,}$/;
const REPLY_ATTRIBUTION = /^on\b.{1,400}\bwrote:$/i;
const HEADER = /^\*{0,2}([a-zà-ÿ][a-zà-ÿ -]{0,20}?)\s*:\*{0,2}\s*(.*)$/i;
const FROM_KEYS = new Set(['from', 'von', 'de', 'van', 'da']);
const OTHER_KEYS = new Set([
  'sent', 'date', 'to', 'cc', 'subject', 'reply-to',
  'gesendet', 'datum', 'an', 'betreff', 'envoyé', 'envoye', 'à', 'a', 'objet', 'enviado', 'fecha', 'para', 'asunto',
]);

interface HeaderLineMatch {
  key: string;
  value: string;
}

function headerOf(line: string): HeaderLineMatch | null {
  const match = HEADER.exec(line);
  if (!match) return null;
  return { key: match[1].trim().toLowerCase(), value: match[2].replace(/\*+/g, '').trim() };
}

/** "Name <addr>", "Name [mailto:addr]", "Name <mailto:addr>", "addr" or "<addr>" as one mailbox. */
export function parseForwardedFrom(value: string): ForwardedSender | null {
  const cleaned = value
    .replace(/\[mailto:([^\]\s]+)\]/gi, '<$1>')
    .replace(/<mailto:/gi, '<')
    .trim();
  const parsed = parseAddressList(cleaned)[0];
  if (parsed) return { address: parsed.address, name: parsed.name.replace(/^['"]|['"]$/g, '').trim() };
  // A display name with an address in it but no brackets ("Dana Wu dana@x.com").
  const bare = /([^\s<>()[\],;:"]+@[^\s<>()[\],;:"]+)/.exec(cleaned);
  const address = normalizeAddress(bare?.[1]);
  if (!address) return null;
  const name = cleaned.slice(0, bare!.index).replace(/["'<([]+$/g, '').trim();
  return { address, name };
}

/**
 * Reads a forward header block starting at `start`: the From line within the
 * first lines, and at least `others` more header lines (Date, Sent, To,
 * Subject, Cc), with up to BLOCK_MAX_GAP blank lines before it begins.
 */
function readBlock(lines: string[], start: number, others: number): ForwardedSender | null {
  let index = start;
  let gap = 0;
  while (index < lines.length && lines[index] === '' && gap < BLOCK_MAX_GAP) { index++; gap++; }
  let from: ForwardedSender | null = null;
  let fromSeen = false;
  let otherCount = 0;
  for (let i = index; i < Math.min(lines.length, index + BLOCK_MAX_LINES); i++) {
    const line = lines[i];
    if (line === '') break;
    const header = headerOf(line);
    if (!header) {
      // The block opens with a header; later lines that are not one (a wrapped value) are skipped.
      if (i === index) return null;
      continue;
    }
    if (FROM_KEYS.has(header.key) && !fromSeen) {
      // The From line opens the block (Apple and Gmail put it first; Outlook too).
      if (i - index > 1) return null;
      fromSeen = true;
      from = parseForwardedFrom(header.value);
    } else if (OTHER_KEYS.has(header.key)) {
      otherCount++;
    }
  }
  return from && otherCount >= others ? from : null;
}

/**
 * The original sender of an inline forward near the top of `text`, or null
 * when the body is not one (see the module comment for what counts).
 */
export function inlineForwardedSender(subject: string | null | undefined, text: string | null | undefined): ForwardedSender | null {
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim());
  const outlookAllowed = hasForwardPrefix(subject);
  let noteLines = 0;
  let noteChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FORWARD_MARKERS.some((pattern) => pattern.test(line))) return readBlock(lines, i + 1, 1);
    if (ORIGINAL_MESSAGE.test(line)) return outlookAllowed ? readBlock(lines, i + 1, 2) : null;
    if (RULE.test(line)) {
      const found = outlookAllowed ? readBlock(lines, i + 1, 2) : null;
      if (found) return found;
    } else if (FROM_KEYS.has(headerOf(line)?.key ?? '')) {
      const found = outlookAllowed ? readBlock(lines, i, 2) : null;
      if (found) return found;
      // A From: line that opens no forward block is note text; it is not a forward.
    }
    // A reply's quoted history: whatever follows is not a forward of this email.
    if (line.startsWith('>') || REPLY_ATTRIBUTION.test(line)) return null;
    if (line !== '') {
      noteLines++;
      noteChars += line.length;
      if (noteLines > NOTE_MAX_LINES || noteChars > NOTE_MAX_CHARS) return null;
    }
  }
  return null;
}

/** A forward attached whole: message/rfc822, or an .eml file. */
export function isAttachedMessage(contentType: string | null | undefined, filename: string | null | undefined): boolean {
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'message/rfc822' || /\.eml$/i.test((filename ?? '').trim());
}

/** The bytes read from an attached message to find its From header. */
export const ATTACHED_HEAD_BYTES = 64 * 1024;

/**
 * The From header of an attached message (its head: the bytes before the
 * first blank line, folded lines unfolded). Null when it has none.
 */
export function fromRfc822Head(bytes: Uint8Array): ForwardedSender | null {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, ATTACHED_HEAD_BYTES)).replace(/\r\n?/g, '\n');
  const end = text.search(/\n\n/);
  const head = (end === -1 ? text : text.slice(0, end)).replace(/\n[ \t]+/g, ' ');
  for (const line of head.split('\n')) {
    const match = /^from\s*:\s*(.*)$/i.exec(line);
    if (match) return parseForwardedFrom(match[1]);
  }
  return null;
}
