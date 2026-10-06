import { firstHeader, headerValues, type HeaderLine } from './headers';

/**
 * Why a message is machine mail (out-of-office, newsletter, bounce, report),
 * or null for a person's mail. RFC 3834 Auto-Submitted, Precedence, list
 * headers, the common autoresponder headers, delivery-system senders and
 * multipart/report.
 */
export function detectAutoMail(input: { headers: readonly HeaderLine[]; fromAddress: string | null }): string | null {
  const { headers, fromAddress } = input;
  const local = (fromAddress ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (local === 'mailer-daemon' || local === 'postmaster') return `bounce: ${local} sender`;

  const contentType = (firstHeader(headers, 'content-type') ?? '').toLowerCase();
  if (/^\s*multipart\/report\b/.test(contentType)) return 'report: multipart/report';

  for (const value of headerValues(headers, 'auto-submitted')) {
    const keyword = value.split(';')[0].trim().toLowerCase();
    if (keyword && keyword !== 'no') return `auto-submitted: ${keyword.slice(0, 60)}`;
  }
  for (const value of headerValues(headers, 'precedence')) {
    const keyword = value.trim().toLowerCase();
    if (keyword === 'bulk' || keyword === 'list' || keyword === 'junk') return `precedence: ${keyword}`;
  }
  if (headerValues(headers, 'list-unsubscribe').length > 0) return 'list: list-unsubscribe';
  if (headerValues(headers, 'list-id').length > 0) return 'list: list-id';
  if (headerValues(headers, 'x-autoreply').length > 0) return 'autoreply: x-autoreply';
  if (headerValues(headers, 'x-autorespond').length > 0) return 'autoreply: x-autorespond';
  return null;
}
