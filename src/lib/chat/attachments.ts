import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, notFound } from '@/lib/api/errors';
import { loadConnection, openCredentials } from './connections';
import { loadOwn, requireCaller, type ChatCaller } from './messages';
import { chatAdapter, ChatProviderError } from './providers';
import type { InboundAttachment } from './providers/adapter';
import { CHAT_ATTACHMENT_KINDS, CHAT_ATTACHMENT_MAX_BYTES } from './types';

/**
 * GET /api/v1/chat/messages/{id}/attachments/{n}: one file sent with a chat
 * message, fetched from the provider now and streamed straight through.
 * Only the agent the message was routed to reaches it (404 for anyone else,
 * as for the message). Nothing is kept: the app holds the provider's
 * reference, never the bytes.
 *
 * The provider's file address is never handed out: Telegram's holds the bot
 * token and Slack's needs it in a header, so every provider is proxied the
 * same way (Discord's CDN links too, which expire and are refreshed). The
 * answer is the bytes with the file's type and name; no provider address,
 * id or token is in its headers. 413 attachment_too_large past 20 MB
 * (Telegram's bot limit, the same for every provider). Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/** A file name safe inside a Content-Disposition header: ASCII, no quotes, plus the UTF-8 form. */
function disposition(name: string | null, index: number): string {
  const fallback = `attachment-${index}`;
  const raw = (name ?? fallback).slice(0, 200);
  // eslint-disable-next-line no-control-regex -- control characters never reach a header
  const ascii = raw.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || fallback;
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

/** Only an inert type goes out as is; anything a browser would run is a download of bytes. */
function safeContentType(mime: string | null): string {
  if (!mime) return 'application/octet-stream';
  if (/^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript)$/.test(mime)) return 'application/octet-stream';
  return mime;
}

function storedAttachment(row: Row, index: number): InboundAttachment | null {
  const list = Array.isArray(row.attachments) ? row.attachments as Row[] : [];
  const item = list[index];
  if (!item || typeof item.ref !== 'string' || !item.ref) return null;
  return {
    kind: (CHAT_ATTACHMENT_KINDS as readonly string[]).includes(item.kind) ? item.kind : 'document',
    ref: item.ref,
    name: typeof item.name === 'string' ? item.name : null,
    mime_type: typeof item.mime_type === 'string' ? item.mime_type : null,
    size: typeof item.size === 'number' ? item.size : null,
    duration_seconds: typeof item.duration_seconds === 'number' ? item.duration_seconds : null,
  };
}

const tooLarge = () => new ApiError(413, 'PAYLOAD_TOO_LARGE', `The file is larger than ${CHAT_ATTACHMENT_MAX_BYTES / (1024 * 1024)} MB, the most the app fetches`, {
  reason: 'attachment_too_large', max_bytes: CHAT_ATTACHMENT_MAX_BYTES,
});

export async function fetchChatAttachment(service: SupabaseClient, caller: ChatCaller, messageId: string, n: string): Promise<Response> {
  await requireCaller(service, caller);
  if (!/^\d{1,2}$/.test(n)) throw notFound('Attachment');
  const index = Number(n);
  const message = await loadOwn(service, caller.memberId, messageId);
  const attachment = storedAttachment(message, index);
  if (!attachment) throw notFound('Attachment');
  if (attachment.size !== null && attachment.size > CHAT_ATTACHMENT_MAX_BYTES) throw tooLarge();

  const connection = await loadConnection(service, message.connection_id);
  if (!connection) throw new ApiError(409, 'CONFLICT', 'This chat connection was removed', { reason: 'connection_off' });
  const adapter = chatAdapter(connection.provider);
  if (!adapter) throw new ApiError(501, 'NOT_IMPLEMENTED', `${connection.provider} has no adapter yet`, { reason: 'no_adapter' });
  const credentials = openCredentials(connection as { id: string; credentials: string });

  let fetched;
  try {
    fetched = await adapter.fetchAttachment(credentials, attachment, CHAT_ATTACHMENT_MAX_BYTES);
  } catch (error) {
    if (!(error instanceof ChatProviderError)) throw error;
    if (error.code === 'too_large') throw tooLarge();
    // The provider's words and code only: never an address, which may hold the token.
    throw new ApiError(502, 'BAD_GATEWAY', error.message, { reason: 'provider_refused', provider: error.provider, code: error.code });
  }
  const headers = new Headers({
    'Content-Type': safeContentType(attachment.mime_type ?? fetched.mimeType),
    'Content-Disposition': disposition(attachment.name, index),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (fetched.size !== null) headers.set('Content-Length', String(fetched.size));
  return new Response(fetched.body, { status: 200, headers });
}
