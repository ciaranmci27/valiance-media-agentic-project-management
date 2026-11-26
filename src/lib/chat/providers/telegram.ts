import { randomBytes } from 'node:crypto';
import {
  ChatProviderError, cleanFileName, cleanMimeType, countOrNull, downloadCapped, postJson, safeEqual, tooLarge,
  type ChatAdapter, type InboundAttachment, type ParsedInbound,
} from './adapter';

/**
 * Telegram: a bot from BotFather, its token pasted by an Owner. Connecting
 * calls getMe (the bot's username, and its id as the workspace) and
 * setWebhook with this connection's address and a secret token the app
 * makes; Telegram sends that token back in X-Telegram-Bot-Api-Secret-Token on
 * every update, which is how a request is verified. Text messages from
 * people reach the assistant; a retry carries the same update_id.
 * Removing the connection deletes the webhook. Replies over Telegram's 4096
 * characters go as several messages.
 *
 * Files: a photo (its largest size), voice note, audio, document, video or
 * round video becomes an attachment holding Telegram's file_id, with its
 * caption as the text; a message with a file and no caption is still a
 * message. The app fetches a file only when the agent asks (getFile, then
 * the file link, which holds the bot token, so it is proxied and never
 * handed out). Telegram's bots download at most 20 MB.
 *
 * A link goes as an inline keyboard url button under the last part.
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
    const words = typeof message.text === 'string' ? message.text : typeof message.caption === 'string' ? message.caption : '';
    const raw = words.trim();
    const attachments = telegramAttachments(message);
    if ((!raw && attachments.length === 0) || message.chat?.id === undefined) return { kind: 'ignore', reason: 'empty' };
    // Opening the bot sends /start: that is a hello.
    const text = /^\/start(\s|$)/.test(raw) ? (raw.replace(/^\/start\s*/, '') || 'hi') : raw;
    const replied = message.reply_to_message?.message_id;
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
      ...(attachments.length ? { attachments } : {}),
      replyToMessageId: replied !== undefined ? String(replied) : null,
      direct: message.chat?.type === 'private',
      // In a group: a reply to a bot's message, or a /command. A mention of
      // this bot's handle is checked in inbound, which knows the handle.
      addressed: message.chat?.type === 'private' || message.reply_to_message?.from?.is_bot === true || raw.startsWith('/'),
    };
  },

  async send(credentials, message) {
    let first: string | null = null;
    // Telegram has no per-message name: the bot's own name stays. An answer
    // in a group replies to the message it answers (the first part only).
    const replyTo = message.replyTo && /^\d+$/.test(message.replyTo) ? Number(message.replyTo) : null;
    for (let at = 0; at < message.text.length; at += TELEGRAM_MAX) {
      const last = at + TELEGRAM_MAX >= message.text.length;
      const answer = await postJson('telegram', botUrl(credentials.bot_token, 'sendMessage'), {
        chat_id: message.conversationId,
        text: message.text.slice(at, at + TELEGRAM_MAX),
        ...(message.threadId ? { message_thread_id: Number(message.threadId) } : {}),
        ...(replyTo !== null && at === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        // A link is a button under the message (the last part).
        ...(message.link && last ? { reply_markup: { inline_keyboard: [[{ text: message.link.label, url: message.link.url }]] } } : {}),
      });
      if (answer.ok !== true) throw refused(answer, 'Telegram refused the message');
      const id = (answer.result as Loose)?.message_id;
      if (first === null && id !== undefined) first = String(id);
    }
    return { externalMessageId: first };
  },

  async openDirect(_credentials, userId) {
    // A private chat's id is the person's own id (they must have started the bot).
    return userId;
  },

  async resolveChannel(credentials, input) {
    const value = input.trim();
    // A chat id (-100123...) or a public group's @username: getChat knows both.
    const chatId = /^-?\d{1,20}$/.test(value) ? value : `@${value.replace(/^[@#]/, '')}`;
    const answer = await postJson('telegram', botUrl(credentials.bot_token, 'getChat'), { chat_id: chatId }).catch(() => null);
    const chat = answer?.ok === true ? answer.result as Loose : null;
    if (chat?.id !== undefined) return { id: String(chat.id), name: typeof chat.title === 'string' ? chat.title : typeof chat.username === 'string' ? `@${chat.username}` : null };
    if (/^-?\d{1,20}$/.test(value)) return { id: value, name: null };
    throw new ChatProviderError('telegram', 'chat_not_found', `Telegram does not know a group called ${chatId}. Add the bot to the group and paste the group's chat id instead.`);
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
      botId: bot?.id !== undefined ? String(bot.id) : null,
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

  async fetchAttachment(credentials, attachment, maxBytes) {
    if (attachment.size !== null && attachment.size > maxBytes) throw tooLarge('telegram', maxBytes);
    const info = await postJson('telegram', botUrl(credentials.bot_token, 'getFile'), { file_id: attachment.ref });
    if (info.ok !== true) throw refused(info, 'Telegram would not hand over the file');
    const file = info.result as Loose;
    const path = typeof file?.file_path === 'string' ? file.file_path : '';
    if (countOrNull(file?.file_size) !== null && file.file_size > maxBytes) throw tooLarge('telegram', maxBytes);
    if (!/^[A-Za-z0-9_\-./]{1,512}$/.test(path) || path.includes('..')) {
      throw new ChatProviderError('telegram', 'no_file_path', 'Telegram did not give a path for the file (it may be over 20 MB)');
    }
    // The file link holds the bot token: fetched here, never handed out or logged.
    const got = await downloadCapped('telegram', `${TELEGRAM_API}/file/bot${credentials.bot_token}/${path}`, { maxBytes });
    if (!got.body) throw new ChatProviderError('telegram', `http_${got.status}`, `Telegram answered ${got.status} for the file`);
    return { body: got.body, size: got.size, mimeType: got.mimeType };
  },
};

/** Telegram's files on a message, each with its file_id; a photo is its largest size. */
export function telegramAttachments(message: Loose): InboundAttachment[] {
  const out: InboundAttachment[] = [];
  const add = (kind: InboundAttachment['kind'], file: Loose, extra: { name?: unknown; mime?: unknown } = {}) => {
    if (typeof file?.file_id !== 'string' || !file.file_id || file.file_id.length > 255) return;
    out.push({
      kind,
      ref: file.file_id,
      name: cleanFileName(extra.name ?? file.file_name),
      mime_type: cleanMimeType(extra.mime ?? file.mime_type),
      size: countOrNull(file.file_size),
      duration_seconds: countOrNull(file.duration),
    });
  };
  if (Array.isArray(message.photo) && message.photo.length) {
    const sizes = message.photo as Loose[];
    const largest = sizes.reduce((best, size) => ((size?.file_size ?? (size?.width ?? 0) * (size?.height ?? 0)) > (best?.file_size ?? (best?.width ?? 0) * (best?.height ?? 0)) ? size : best), sizes[0]);
    add('photo', largest, { mime: 'image/jpeg' });
  }
  if (message.voice) add('voice', message.voice);
  if (message.audio) add('audio', message.audio, { name: message.audio.file_name ?? message.audio.title });
  if (message.document) add('document', message.document);
  if (message.video) add('video', message.video);
  if (message.video_note) add('video', message.video_note, { mime: 'video/mp4' });
  return out;
}
