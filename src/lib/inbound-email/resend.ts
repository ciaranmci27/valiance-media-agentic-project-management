import { normalizeAddress, parseAddressList } from './addresses';
import { firstHeader, headerLinesFromMap } from './headers';
import type { InboundAttachment, InboundEmail, InboundMailbox } from './normalized';
import { parseMessageIdList } from './message-ids';

/**
 * The Resend transport: Resend receives mail on the relay domain and posts
 * `email.received` (https://resend.com/docs/webhooks/emails/received). The
 * webhook carries metadata only, so the full message is read back through
 * the Receiving API with GET requests only. This module never sends,
 * replies to or forwards email.
 *
 * - Retrieve Received Email: GET /emails/receiving/{id} returns html, text,
 *   a headers map, to/cc/bcc/reply_to/received_for, the receiver's
 *   `authentication` verdict and `raw.download_url` (a signed URL with
 *   expires_at) for the original .eml
 *   (https://resend.com/docs/api-reference/emails/retrieve-received-email).
 *   html_format=cid keeps inline images as cid: references instead of
 *   base64 data URIs, so bodies stay small; the images are attachments.
 * - List Attachments: GET /emails/receiving/{id}/attachments returns every
 *   attachment (no limit means all) with a download_url valid for one hour
 *   (https://resend.com/docs/api-reference/emails/list-received-email-attachments,
 *   https://resend.com/docs/dashboard/receiving/attachments). Each webhook
 *   run lists them afresh, so a retry hours later gets live URLs.
 */

export const RESEND_API_BASE = 'https://api.resend.com';
export const RESEND_PROVIDER = 'resend';

export interface ResendReceivedEmail {
  id: string;
  to?: string[] | null;
  from?: string | null;
  created_at?: string | null;
  subject?: string | null;
  html?: string | null;
  text?: string | null;
  headers?: Record<string, unknown> | null;
  bcc?: string[] | null;
  cc?: string[] | null;
  reply_to?: string[] | null;
  received_for?: string[] | null;
  authentication?: { spf?: string | null; dkim?: string | null; dmarc?: string | null } | null;
  message_id?: string | null;
  raw?: { download_url?: string | null; expires_at?: string | null } | null;
  attachments?: { id: string; filename?: string | null; content_type?: string | null; content_disposition?: string | null; content_id?: string | null; size?: number | null }[] | null;
}

export interface ResendAttachment {
  id: string;
  filename?: string | null;
  size?: number | null;
  content_type?: string | null;
  content_disposition?: string | null;
  content_id?: string | null;
  download_url?: string | null;
  expires_at?: string | null;
}

export interface ResendWebhookEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[] | null;
    cc?: string[] | null;
    bcc?: string[] | null;
    received_for?: string[] | null;
  } | null;
}

export class ResendApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ResendApiError';
  }
}

export interface ResendReceiving {
  getEmail(id: string): Promise<ResendReceivedEmail>;
  listAttachments(id: string): Promise<ResendAttachment[]>;
  download(url: string): Promise<Response>;
}

export function createResendReceiving(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}): ResendReceiving {
  const doFetch = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? RESEND_API_BASE).replace(/\/$/, '');
  const get = async <T>(path: string): Promise<T> => {
    const response = await doFetch(`${base}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new ResendApiError(response.status, `Resend ${path} answered ${response.status}`);
    return (await response.json()) as T;
  };
  return {
    getEmail: (id) => get<ResendReceivedEmail>(`/emails/receiving/${encodeURIComponent(id)}?html_format=cid`),
    listAttachments: async (id) =>
      (await get<{ data?: ResendAttachment[] }>(`/emails/receiving/${encodeURIComponent(id)}/attachments`)).data ?? [],
    // Signed URLs carry their own authorization; no API key goes with them.
    download: (url) => doFetch(url, { method: 'GET', signal: AbortSignal.timeout(45_000) }),
  };
}

function bare(list: (string | null | undefined)[] | null | undefined): string[] {
  return (list ?? []).flatMap((value) => {
    const parsed = parseAddressList(value ?? '');
    if (parsed.length) return parsed.map((entry) => entry.address);
    const address = normalizeAddress(value);
    return address ? [address] : [];
  });
}

/** Header mailboxes when the header is there, else the API's bare addresses. */
function mailboxes(header: string | null, fallback: string[] | null | undefined): InboundMailbox[] {
  const parsed = parseAddressList(header);
  if (parsed.length) return parsed;
  return bare(fallback).map((address) => ({ address, name: '' }));
}

/** Builds the normalized email for the core from Resend's API. */
export async function inboundFromResend(
  client: ResendReceiving,
  emailId: string,
  webhook: ResendWebhookEvent['data'] = null,
): Promise<InboundEmail> {
  const [email, listed] = await Promise.all([client.getEmail(emailId), client.listAttachments(emailId)]);
  const headers = headerLinesFromMap(email.headers ?? {});
  const fromHeader = parseAddressList(firstHeader(headers, 'from'))[0] ?? null;
  const fromAddress = normalizeAddress(email.from) ?? fromHeader?.address ?? null;
  const metadata = new Map((email.attachments ?? []).map((attachment) => [attachment.id, attachment]));
  const attachments: InboundAttachment[] = listed.map((attachment) => {
    const known = metadata.get(attachment.id);
    const disposition = (attachment.content_disposition ?? known?.content_disposition ?? '').toLowerCase();
    return {
      provider_attachment_id: attachment.id,
      filename: attachment.filename ?? known?.filename ?? null,
      content_type: attachment.content_type ?? known?.content_type ?? null,
      size: typeof attachment.size === 'number' ? attachment.size : (typeof known?.size === 'number' ? known.size : null),
      disposition: disposition === 'inline' ? 'inline' : disposition === 'attachment' ? 'attachment' : null,
      content_id: attachment.content_id ?? known?.content_id ?? null,
      source: {
        fetch: async () => {
          if (!attachment.download_url) throw new ResendApiError(404, `Resend gave no download URL for attachment ${attachment.id}`);
          return client.download(attachment.download_url);
        },
      },
    };
  });
  const rawUrl = email.raw?.download_url ?? null;
  return {
    provider: RESEND_PROVIDER,
    provider_email_id: email.id ?? emailId,
    received_at: email.created_at ?? null,
    delivered_to: [
      ...bare(email.to), ...bare(email.cc), ...bare(email.bcc), ...bare(email.received_for),
      ...bare(webhook?.to), ...bare(webhook?.cc), ...bare(webhook?.bcc), ...bare(webhook?.received_for),
    ],
    message_id: email.message_id ?? firstHeader(headers, 'message-id'),
    in_reply_to: parseMessageIdList(firstHeader(headers, 'in-reply-to')),
    references: parseMessageIdList(firstHeader(headers, 'references')),
    subject: email.subject ?? firstHeader(headers, 'subject') ?? '',
    date: firstHeader(headers, 'date'),
    from: fromAddress ? { address: fromAddress, name: fromHeader?.address === fromAddress ? fromHeader.name : '' } : null,
    to: mailboxes(firstHeader(headers, 'to'), email.to),
    cc: mailboxes(firstHeader(headers, 'cc'), email.cc),
    reply_to: mailboxes(firstHeader(headers, 'reply-to'), email.reply_to),
    headers,
    text: email.text ?? null,
    html: email.html ?? null,
    provider_auth: email.authentication
      ? { spf: email.authentication.spf ?? null, dkim: email.authentication.dkim ?? null, dmarc: email.authentication.dmarc ?? null }
      : null,
    raw: rawUrl ? { fetch: () => client.download(rawUrl) } : null,
    attachments,
  };
}
