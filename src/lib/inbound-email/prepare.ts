import { normalizeAddress } from './addresses';
import { detectAutoMail } from './auto-mail';
import { evaluateAuth, type AuthVerdict } from './auth-results';
import { htmlToText } from './html-text';
import type { InboundEmail } from './normalized';
import { extractNewText, isForwardedMessage } from './quoted';
import { normalizeSubject } from './subject';
import { normalizeMessageId } from './threading';

/**
 * Everything ingestion derives from the email alone, before any database
 * read: identity, recipients, display text, trust and the auto-mail reason.
 * Pure, so the fixtures test it directly.
 */

export const MAX_BODY_CHARS = 2_000_000;

export interface PreparedRecipient {
  kind: 'from' | 'to' | 'cc' | 'reply_to';
  address: string;
  name: string;
}

export interface PreparedMessage {
  provider: string;
  provider_email_id: string;
  internet_message_id: string;
  in_reply_to: string[];
  reference_ids: string[];
  subject: string;
  subject_normalized: string;
  sent_at: string | null;
  received_at: string | null;
  text_body: string | null;
  html_body: string | null;
  new_text: string;
  is_forward: boolean;
  auth: AuthVerdict;
  auto_mail_reason: string | null;
  has_raw: boolean;
}

export interface PreparedEmail {
  fromAddress: string | null;
  deliveredTo: string[];
  message: PreparedMessage;
  recipients: PreparedRecipient[];
}

// Postgres text cannot hold NUL; mail occasionally carries it.
function clean(value: string | null | undefined, max: number): string | null {
  return value == null ? null : value.replace(/\u0000/g, '').slice(0, max);
}

export function prepareEmail(email: InboundEmail, options: { trustedAuthservIds: readonly string[] }): PreparedEmail {
  const fromAddress = normalizeAddress(email.from?.address);
  const recipients: PreparedRecipient[] = [];
  const seen = new Set<string>();
  const push = (kind: PreparedRecipient['kind'], list: { address: string; name: string }[]) => {
    for (const entry of list) {
      const address = normalizeAddress(entry.address);
      if (!address || seen.has(`${kind}:${address}`)) continue;
      if (kind === 'from' && recipients.some((r) => r.kind === 'from')) continue;
      seen.add(`${kind}:${address}`);
      recipients.push({ kind, address, name: (entry.name ?? '').replace(/\u0000/g, '').trim().slice(0, 300) });
    }
  };
  push('from', email.from ? [email.from] : []);
  push('to', email.to);
  push('cc', email.cc);
  push('reply_to', email.reply_to);

  const text = clean(email.text, MAX_BODY_CHARS);
  const html = clean(email.html, MAX_BODY_CHARS);
  const subject = clean(email.subject, 2000) ?? '';
  const readable = text && text.trim() ? text : htmlToText(html);
  const sentAt = email.date ? new Date(email.date) : null;
  const receivedAt = email.received_at ? new Date(email.received_at) : null;
  const ids = (list: string[]) => [...new Set(list.map(normalizeMessageId).filter((id): id is string => !!id))].slice(-100);
  const deliveredTo = [...new Set(email.delivered_to.map(normalizeAddress).filter((a): a is string => !!a))];

  return {
    fromAddress,
    deliveredTo,
    recipients,
    message: {
      provider: email.provider,
      provider_email_id: email.provider_email_id,
      internet_message_id: normalizeMessageId(email.message_id) ?? `missing-message-id.${email.provider}.${email.provider_email_id}`,
      in_reply_to: ids(email.in_reply_to),
      reference_ids: ids(email.references),
      subject,
      subject_normalized: normalizeSubject(subject).slice(0, 2000),
      sent_at: sentAt && !Number.isNaN(sentAt.getTime()) ? sentAt.toISOString() : null,
      received_at: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt.toISOString() : null,
      text_body: text,
      html_body: html,
      new_text: extractNewText(readable),
      is_forward: isForwardedMessage(subject, readable),
      auth: evaluateAuth({
        headers: email.headers,
        fromAddress,
        trustedIds: options.trustedAuthservIds,
        providerAuth: email.provider_auth,
      }),
      auto_mail_reason: detectAutoMail({ headers: email.headers, fromAddress }),
      has_raw: !!email.raw,
    },
  };
}
