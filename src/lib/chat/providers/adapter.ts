import { timingSafeEqual } from 'node:crypto';
import type { ChatAttachmentKind, ChatConnectionKind } from '../types';

/**
 * One chat provider, in one file: how its requests are verified and read,
 * how a reply goes out, and what connecting it does. A new provider is a new
 * adapter in this folder plus its entry in index.ts and its credential form
 * in lib/chat/types.ts; nothing else changes. Server only.
 *
 * Every outbound call goes through chatHttp.fetch, so tests swap it for a
 * mock and nothing reaches a real provider. Tokens never appear in a log or
 * an error message: a failure names the provider's error code only.
 */

export type ChatCredentials = Record<string, string>;

/**
 * A file sent with an inbound message, as stored (chat_messages.attachments).
 * ref is how the provider finds it again: Telegram's file_id, Slack's
 * url_private_download (on files.slack.com), Discord's CDN url. The app
 * never downloads it on its own: the agent fetches it through the app,
 * which proxies it, so a bot token never leaves the server. ref is never
 * shown to an agent.
 */
export interface InboundAttachment {
  kind: ChatAttachmentKind;
  ref: string;
  name: string | null;
  mime_type: string | null;
  size: number | null;
  duration_seconds: number | null;
}

/** A fetched file: its bytes as a stream (capped), and what the provider said of it. */
export interface FetchedAttachment {
  body: ReadableStream<Uint8Array>;
  size: number | null;
  mimeType: string | null;
}

export type ParsedInbound =
  | { kind: 'challenge'; challenge: string }
  /** A verified hello from a relay (Discord's, when it connects): the connection is heard; nothing is recorded. */
  | { kind: 'ping'; heartbeat?: true }
  | { kind: 'ignore'; reason: string }
  | {
    kind: 'message';
    /** The provider's id for this delivery: a retry carries the same one. */
    dedupeKey: string;
    /** The provider workspace (a Slack team), or null where there is none. */
    workspaceId: string | null;
    userId: string;
    userHandle: string | null;
    conversationId: string;
    threadId: string | null;
    messageId: string | null;
    text: string;
    /** A one-to-one chat with the bot (a Slack DM, a private Telegram chat): the only place a link is sent. */
    direct: boolean;
    /**
     * Spoken to the bot: always in a direct chat; in a shared one, a Slack
     * mention, or a Telegram reply to a bot or command. Inbound also counts a
     * mention of the connection's bot handle. Only then does the app send
     * its own "can't answer right now" line there.
     */
    addressed?: boolean;
    /** Provider user ids mentioned in the text (Slack <@U...>), so inbound can tell a mention of its own bot. */
    mentions?: string[];
    /** Files sent with it. A message with files and no text is still a message. */
    attachments?: InboundAttachment[];
    /** The provider message this one quotes or replies to (Telegram reply_to_message, Discord message_reference), when any. */
    replyToMessageId?: string | null;
  };

export interface OutboundMessage {
  conversationId: string;
  threadId: string | null;
  text: string;
  /**
   * The message to answer under, when the answer should start a thread on
   * it (a company reply in a channel): Slack threads on its ts, Telegram
   * replies to it. Used only when threadId is null.
   */
  replyTo?: string | null;
  /** Slack: a threaded reply also shows in the channel (reply_broadcast). */
  broadcast?: boolean;
  /**
   * Who it appears from, where the provider lets a bot say (Slack
   * chat:write.customize; a Discord channel webhook, else the name in bold).
   * Telegram keeps the bot's name.
   */
  as?: { username: string; iconUrl: string | null } | null;
  /** A one-to-one chat with the bot (Discord: no channel webhook there). */
  direct?: boolean;
  /** The sender of the message answered (Discord: a webhook reply cannot reference a message, so it mentions them instead). */
  replyToUser?: string | null;
  /** A link shown the provider's way: a Slack <url|label>, a Telegram url button, a Discord [label](<url>). */
  link?: { url: string; label: string } | null;
}

export interface SendResult {
  externalMessageId: string | null;
  /** Credentials the send changed (Discord caches a channel's webhook): the caller stores them sealed. */
  credentials?: ChatCredentials;
}

export interface ConnectResult {
  credentials: ChatCredentials;
  /** The provider workspace or bot id: one connection per workspace and kind. */
  workspaceId: string | null;
  /** The bot's own id (Slack's bot user, Telegram's bot): one connection per bot. */
  botId: string | null;
  botHandle: string | null;
  displayName: string;
  /** A secret the Owner copies now and never sees again (Discord's relay secret). */
  relaySecret?: string;
}

export interface ChatAdapter {
  provider: 'slack' | 'telegram' | 'discord';
  /** The linked-identity provider senders are known by (member_identities.provider). */
  identityProvider: string;
  /**
   * Whether senders belong to a provider workspace (a Slack team). Then an
   * event from another workspace is ignored and a sender is known only by an
   * identity in this connection's workspace; without (Telegram), by one with
   * no workspace.
   */
  hasWorkspaces: boolean;
  /** Whether the request really came from the provider, for this connection. */
  verify(input: { headers: Headers; body: string; credentials: ChatCredentials; now?: number }): boolean;
  parse(body: string, headers: Headers): ParsedInbound;
  send(credentials: ChatCredentials, message: OutboundMessage): Promise<SendResult>;
  /** The one-to-one conversation with a person (a private reply): Slack opens the DM (im:write), Telegram's is the user id. */
  openDirect(credentials: ChatCredentials, userId: string): Promise<string>;
  /**
   * A channel an Owner typed, as an id or a name: its id and, when the
   * provider tells, its name. A name the provider cannot find is a
   * ChatProviderError that says to paste the id.
   */
  resolveChannel(credentials: ChatCredentials, input: string): Promise<{ id: string; name: string | null }>;
  /**
   * Checks the pasted credentials with the provider and does its one-time setup (Telegram's webhook).
   * With expectedBotId (a token being replaced), a token for another bot does no setup at all and
   * comes back with that bot's id, so the caller refuses it before anything changes at the provider.
   */
  connect(input: { credentials: ChatCredentials; inboundUrl: string; displayName?: string; kind?: ChatConnectionKind; expectedBotId?: string | null }): Promise<ConnectResult>;
  /** Undoes connect's setup when the connection is removed. Never throws. */
  disconnect(credentials: ChatCredentials): Promise<void>;
  /** A link that opens a chat with the bot, when there is one. */
  openUrl(input: { botHandle: string | null; workspaceId: string | null; botId?: string | null }): string | null;
  /**
   * Fetches a stored inbound file through the provider with the bot's
   * credentials, never past maxBytes (ChatProviderError too_large). The
   * answer is the bytes only: no provider address or token goes with it.
   */
  fetchAttachment(credentials: ChatCredentials, attachment: InboundAttachment, maxBytes: number): Promise<FetchedAttachment>;
}

/** A provider refused or failed: code is the provider's own error word, never a token. */
export class ChatProviderError extends Error {
  constructor(public provider: string, public code: string, message: string) {
    super(message);
  }
}

/** The one door to the network for every adapter: tests replace fetch. */
export const chatHttp: { fetch: typeof fetch } = {
  fetch: (input, init) => fetch(input, init),
};

const TIMEOUT_MS = 10_000;

/** POSTs JSON and reads JSON back; a network failure is a ChatProviderError, never the raw error. */
export async function postJson(provider: string, url: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return post(provider, url, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

/** POSTs a form (Slack's read methods take no JSON body) and reads JSON back. */
export async function postForm(provider: string, url: string, params: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return post(provider, url, new URLSearchParams(params).toString(), { 'Content-Type': 'application/x-www-form-urlencoded', ...headers });
}

async function post(provider: string, url: string, body: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await chatHttp.fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ChatProviderError(provider, 'network', `Could not reach ${provider}`);
  }
  const json = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!json) throw new ChatProviderError(provider, `http_${response.status}`, `${provider} answered ${response.status}`);
  return json;
}

/** Equal strings, in constant time. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// -- Inbound files ------------------------------------------------------------

/** What a file is from its MIME type, when the provider does not say (a voice note is told by the provider). */
export function attachmentKindFor(mimeType: string | null | undefined): ChatAttachmentKind {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

/** A provider's MIME type, or null when it is not one (it becomes the answer's Content-Type). */
export function cleanMimeType(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i.test(value) ? value.toLowerCase() : null;
}

/** A file name as the sender gave it, one line, at most 255 characters. */
export function cleanFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- control characters never reach a header or a reader
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return name || null;
}

/** A non-negative whole number, or null. */
export function countOrNull(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/**
 * GETs a file and streams it back, never past maxBytes: a Content-Length
 * over the cap is refused before any byte is read, and a body that grows
 * past it stops with too_large. Redirects are not followed blindly: each
 * hop must pass allowRedirect, and the headers (a bot token) go only where
 * headersFor gives them. A failure never names the address, which may hold
 * a token (Telegram's file links do).
 */
export async function downloadCapped(
  provider: string,
  url: string,
  options: { maxBytes: number; headersFor?: (url: URL) => Record<string, string>; allowRedirect?: (url: URL) => boolean },
): Promise<{ status: number; body: ReadableStream<Uint8Array> | null; size: number | null; mimeType: string | null }> {
  let target = new URL(url);
  for (let hop = 0; hop < 3; hop++) {
    let response: Response;
    try {
      response = await chatHttp.fetch(target.toString(), {
        method: 'GET',
        headers: options.headersFor?.(target) ?? {},
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new ChatProviderError(provider, 'network', `Could not reach ${provider} for the file`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      let next: URL | null = null;
      try { next = location ? new URL(location, target) : null; } catch { next = null; }
      if (!next || next.protocol !== 'https:' || !options.allowRedirect?.(next)) {
        throw new ChatProviderError(provider, 'redirected', `${provider} sent the file somewhere the app does not fetch from`);
      }
      target = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: null, size: null, mimeType: null };
    }
    const length = response.headers.get('content-length');
    const size = length !== null && /^\d+$/.test(length) ? Number(length) : null;
    if (size !== null && size > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw tooLarge(provider, options.maxBytes);
    }
    const mimeType = cleanMimeType((response.headers.get('content-type') ?? '').split(';')[0].trim());
    if (!response.body) return { status: response.status, body: new ReadableStream({ start: (controller) => controller.close() }), size: 0, mimeType };
    return { status: response.status, body: capStream(response.body, options.maxBytes, provider), size, mimeType };
  }
  throw new ChatProviderError(provider, 'redirected', `${provider} redirected the file too many times`);
}

export const tooLarge = (provider: string, maxBytes: number) =>
  new ChatProviderError(provider, 'too_large', `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, the most the app fetches`);

/** Passes bytes through until maxBytes, then stops with too_large. */
function capStream(body: ReadableStream<Uint8Array>, maxBytes: number, provider: string): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > maxBytes) {
        controller.error(tooLarge(provider, maxBytes));
        return;
      }
      controller.enqueue(chunk);
    },
  }));
}
