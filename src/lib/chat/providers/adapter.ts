import { timingSafeEqual } from 'node:crypto';

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

export type ParsedInbound =
  | { kind: 'challenge'; challenge: string }
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
  };

export interface OutboundMessage {
  conversationId: string;
  threadId: string | null;
  text: string;
}

export interface ConnectResult {
  credentials: ChatCredentials;
  /** The provider workspace or bot id: one connection each. */
  workspaceId: string | null;
  botHandle: string | null;
  displayName: string;
}

export interface ChatAdapter {
  provider: 'slack' | 'telegram';
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
  send(credentials: ChatCredentials, message: OutboundMessage): Promise<{ externalMessageId: string | null }>;
  /** Checks the pasted credentials with the provider and does its one-time setup (Telegram's webhook). */
  connect(input: { credentials: ChatCredentials; inboundUrl: string; displayName?: string }): Promise<ConnectResult>;
  /** Undoes connect's setup when the connection is removed. Never throws. */
  disconnect(credentials: ChatCredentials): Promise<void>;
  /** A link that opens a chat with the bot, when there is one. */
  openUrl(input: { botHandle: string | null; workspaceId: string | null }): string | null;
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
  let response: Response;
  try {
    response = await chatHttp.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
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
