import type { ProviderAuth } from './auth-results';
import type { HeaderLine } from './headers';

/**
 * One received email as every transport hands it to the ingestion core.
 * A transport (Resend's webhook today; a Cloudflare Worker or another
 * provider later) builds this and calls ingestInbound; nothing in the core
 * knows which provider it came from beyond the two identity fields.
 */

export interface InboundMailbox {
  address: string;
  name: string;
}

/** A file the core copies into storage itself, server-side. */
export interface InboundFile {
  /** A fresh request for the file's bytes (provider download URLs expire). */
  fetch(): Promise<Response>;
}

export interface InboundAttachment {
  provider_attachment_id: string | null;
  filename: string | null;
  content_type: string | null;
  /** Declared by the provider; checked against the bytes actually copied. */
  size: number | null;
  disposition: 'attachment' | 'inline' | null;
  content_id: string | null;
  source: InboundFile;
}

export interface InboundEmail {
  provider: string;
  provider_email_id: string;
  received_at: string | null;
  /** Every address the message was delivered to (To, Cc, Bcc, envelope). */
  delivered_to: string[];
  message_id: string | null;
  in_reply_to: string[];
  references: string[];
  subject: string;
  date: string | null;
  from: InboundMailbox | null;
  to: InboundMailbox[];
  cc: InboundMailbox[];
  reply_to: InboundMailbox[];
  headers: HeaderLine[];
  text: string | null;
  html: string | null;
  /** The provider's own SPF/DKIM/DMARC verdict, when it gives one. */
  provider_auth: ProviderAuth | null;
  raw: InboundFile | null;
  attachments: InboundAttachment[];
}
