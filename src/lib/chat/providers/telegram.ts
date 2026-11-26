import { randomBytes } from 'node:crypto';
import { ChatProviderError, postJson, safeEqual, type ChatAdapter, type ParsedInbound } from './adapter';

/**
 * Telegram: a bot from BotFather, its token pasted by an Owner. Connecting
 * calls getMe (the bot's username, and its id as the workspace) and
 * setWebhook with this connection's address and a secret token the app
 * makes; Telegram sends that token back in X-Telegram-Bot-Api-Secret-Token on
 * every update, which is how a request is verified. Text messages from
 * people reach the assistant; a retry carries the same update_id.
 * Removing the connection deletes the webhook. Replies over Telegram's 4096
 * characters go as several messages.
 */

const TELEGRAM_API = 'https://api.telegram.org';
const TELEGRAM_MAX = 4000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Telegram's payloads are read field by field
type Loose = any;

const botUrl = (token: string, method: string) => `${TELEGRAM_API}/bot${token}/${method}`;

/** The secret Telegram echoes back: 1 to 256 of A-Z, a-z, 0-9, _ and -. */
export function newTelegramSecret(): string {
  return randomBytes(32).toString('hex');
}

function refused(answer: Record<string, unknown>, what: string): ChatProviderError {
  const code = String(answer.error_code ?? 'failed');
  return new ChatProviderError('telegram', code, `${what}: ${typeof answer.description === 'string' ? answer.description.slice(0, 200) : code}`);
}

export const telegramAdapter: ChatAdapter = {
  provider: 'telegram',
  identityProvider: 'telegram',
  hasWorkspaces: false,

  verify({ headers, credentials }) {
    const sent = headers.get('x-telegram-bot-api-secret-token') ?? '';
    return !!credentials.secret_token && sent.length > 0 && safeEqual(sent, credentials.secret_token);
  },

  parse(body): ParsedInbound {
    let update: Loose;
    try { update = JSON.parse(body); } catch { return { kind: 'ignore', reason: 'invalid_json' }; }
    if (typeof update?.update_id !== 'number') return { kind: 'ignore', reason: 'not_an_update' };
    const message = update.message;
    if (!message || typeof message !== 'object') return { kind: 'ignore', reason: 'not_a_message' };
    if (!message.from || message.from.is_bot) return { kind: 'ignore', reason: 'not_a_person' };
    const raw = typeof message.text === 'string' ? message.text.trim() : '';
    if (!raw || message.chat?.id === undefined) return { kind: 'ignore', reason: 'empty' };
    // Opening the bot sends /start: that is a hello.
    const text = /^\/start(\s|$)/.test(raw) ? (raw.replace(/^\/start\s*/, '') || 'hi') : raw;
    return {
      kind: 'message',
      dedupeKey: `update:${update.update_id}`,
      workspaceId: null,
      userId: String(message.from.id),
      userHandle: typeof message.from.username === 'string' ? `@${message.from.username}` : null,
      conversationId: String(message.chat.id),
      threadId: message.message_thread_id !== undefined ? String(message.message_thread_id) : null,
      messageId: message.message_id !== undefined ? String(message.message_id) : null,
      text,
      direct: message.chat?.type === 'private',
      // In a group: a reply to a bot's message, or a /command. A mention of
      // this bot's handle is checked in inbound, which knows the handle.
      addressed: message.chat?.type === 'private' || message.reply_to_message?.from?.is_bot === true || raw.startsWith('/'),
    };
  },

  async send(credentials, message) {
    let first: string | null = null;
    for (let at = 0; at < message.text.length; at += TELEGRAM_MAX) {
      const answer = await postJson('telegram', botUrl(credentials.bot_token, 'sendMessage'), {
        chat_id: message.conversationId,
        text: message.text.slice(at, at + TELEGRAM_MAX),
        ...(message.threadId ? { message_thread_id: Number(message.threadId) } : {}),
      });
      if (answer.ok !== true) throw refused(answer, 'Telegram refused the message');
      const id = (answer.result as Loose)?.message_id;
      if (first === null && id !== undefined) first = String(id);
    }
    return { externalMessageId: first };
  },

  async connect({ credentials, inboundUrl, displayName }) {
    const me = await postJson('telegram', botUrl(credentials.bot_token, 'getMe'), {});
    if (me.ok !== true) {
      throw new ChatProviderError('telegram', String(me.error_code ?? 'failed'), 'Telegram did not accept that bot token. Copy it from BotFather again.');
    }
    const bot = me.result as Loose;
    if (!/^https:\/\//.test(inboundUrl)) {
      throw new ChatProviderError('telegram', 'not_https', `Telegram only sends to a public https address, and this app is at ${new URL(inboundUrl).origin}.`);
    }
    const secret = newTelegramSecret();
    const hook = await postJson('telegram', botUrl(credentials.bot_token, 'setWebhook'), {
      url: inboundUrl, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true,
    });
    if (hook.ok !== true) throw refused(hook, 'Telegram did not take the webhook');
    const username = typeof bot?.username === 'string' ? bot.username : null;
    return {
      credentials: { bot_token: credentials.bot_token, secret_token: secret },
      workspaceId: bot?.id !== undefined ? String(bot.id) : null,
      botHandle: username ? `@${username}` : null,
      displayName: displayName ?? (typeof bot?.first_name === 'string' ? bot.first_name : 'Telegram'),
    };
  },

  async disconnect(credentials) {
    try {
      await postJson('telegram', botUrl(credentials.bot_token, 'deleteWebhook'), {});
    } catch {
      // Removing the connection never waits on Telegram.
    }
  },

  openUrl({ botHandle }) {
    return botHandle ? `https://t.me/${botHandle.replace(/^@/, '')}` : null;
  },
};
