import { hasForwardPrefix } from './subject';

/**
 * Quoted history stripping, for display only (new_text). The full text is
 * always kept, and forwards are shown in full. Cuts at the first reply
 * attribution ("On ... wrote:", localized variants), an Outlook header block
 * ("From: ... Sent: ..."), "-----Original Message-----", or a forwarded
 * message marker, and drops ">" quoted lines (inline answers survive).
 */

const ATTRIBUTION = [
  /^on\b.{1,400}\bwrote:\s*$/i,
  /^am\b.{1,400}\bschrieb\b.{0,200}:\s*$/i,
  /^le\b.{1,400}\ba\s+[ée]crit\s*:\s*$/i,
  /^el\b.{1,400}\bescribi[óo]\s*:\s*$/i,
  /^op\b.{1,400}\bschreef\b.{0,200}:\s*$/i,
  /^il\b.{1,400}\bha\s+scritto\s*:\s*$/i,
];
const ORIGINAL_MESSAGE = /^-{2,}\s*original message\s*-{2,}\s*$/i;
const FORWARD_MARKERS = [
  /^-{2,}\s*forwarded message\s*-{2,}\s*$/i,
  /^begin forwarded message:\s*$/i,
  /^-{2,}\s*weitergeleitete nachricht\s*-{2,}\s*$/i,
  /^-{2,}\s*message transf[ée]r[ée]\s*-{2,}\s*$/i,
];
const OUTLOOK_FROM = /^\*?(from|von|de|van|da)\s*:\*?\s+\S/i;
const OUTLOOK_FOLLOWER = /^\*?(sent|date|to|subject|gesendet|datum|an|betreff|envoy[ée]|[àa]|objet|enviado|para|asunto)\s*:/i;
const RULE = /^_{10,}\s*$/;

function isOutlookBlock(lines: string[], index: number): boolean {
  if (!OUTLOOK_FROM.test(lines[index])) return false;
  let followers = 0;
  for (let i = index + 1; i < Math.min(lines.length, index + 6); i++) {
    if (OUTLOOK_FOLLOWER.test(lines[i])) followers++;
  }
  return followers >= 2;
}

function cutIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const joined = i + 1 < lines.length ? `${line} ${lines[i + 1].trim()}` : line;
    if (ATTRIBUTION.some((pattern) => pattern.test(line))) return i;
    // Gmail wraps long attributions: "On Mon, ... <bob@x.com>" / "wrote:".
    if (/^on\b/i.test(line) && !/wrote:\s*$/i.test(line) && ATTRIBUTION[0].test(joined)) return i;
    if (ORIGINAL_MESSAGE.test(line) || FORWARD_MARKERS.some((pattern) => pattern.test(line))) return i;
    if (RULE.test(line) && i + 1 < lines.length && isOutlookBlock(lines, i + 1)) return i;
    if (isOutlookBlock(lines.map((l) => l.trim()), i)) return i;
  }
  return lines.length;
}

export function extractNewText(text: string | null | undefined): string {
  const source = (text ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const kept = lines.slice(0, cutIndex(lines)).filter((line) => !/^\s*>/.test(line));
  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return result || source.trim();
}

/** A forward: a forward prefix in the subject, or a forwarded-message marker in the body. */
export function isForwardedMessage(subject: string | null | undefined, text: string | null | undefined): boolean {
  if (hasForwardPrefix(subject)) return true;
  const lines = (text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.some((line) => FORWARD_MARKERS.some((pattern) => pattern.test(line.trim())));
}
