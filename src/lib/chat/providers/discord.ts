import { createHmac, randomBytes } from 'node:crypto';
import {
  attachmentKindFor, chatHttp, ChatProviderError, cleanFileName, cleanMimeType, countOrNull, downloadCapped, safeEqual, tooLarge,
  type ChatAdapter, type ChatCredentials, type InboundAttachment, type OutboundMessage, type ParsedInbound, type SendResult,
} from './adapter';

/**
 * Discord: a bot from the Discord Developer Portal, its token pasted by an
 * Owner. Connecting checks the token (GET /users/@me: the bot's id and name)
 * and reads the application id (for the invite link). Credentials are
 * sealed like every provider's: the bot token, the relay secret, the
 * application id and, for a company bot, the channel webhooks it made.
 *
 * Inbound. A bot hears ordinary messages only over the Discord Gateway, a
 * websocket a serverless host cannot hold (HTTP interactions carry slash
 * commands only). So the install runs a small relay anywhere it likes
 * (app/relay/discord): it holds the Gateway with the bot token and posts
 * each MESSAGE_CREATE to this connection's inbound address, signed with the
 * relay secret the app made at connect and showed once:
 *
 *   X-PM-Relay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">
 *
 * A request without it, with a wrong one, or more than five minutes off is
 * refused (401, like any provider's bad signature). A message id already
 * recorded is a duplicate (the dedupe key is message:<id>), so a replay or
 * a relay's retry records nothing twice. The body is
 * { v: 1, t: 'MESSAGE_CREATE', d: <Discord's message>, channel: { id, type, parent_id } }
 * (channel tells a thread from a channel), or { v: 1, t: 'RELAY_READY' } when
 * the relay connects, which marks the connection heard ("Connected"), or
 * { v: 1, t: 'RELAY_HEARTBEAT' } every RELAY_HEARTBEAT_SECONDS while it runs,
 * which also stamps relay_seen_at, so a relay that stops reads Not receiving.
 *
 * Normalised: a DM has no guild_id. A thread's messages belong to its parent
 * channel (conversation) with the thread as thread_id, so a mapped channel's
 * threads route like the channel. Mentions are the mentions array and
 * <@id> in the text, plus the author of the message replied to (a reply to
 * the bot speaks to it) and that message's application (a reply to an agent
 * speaking through a webhook). Bots, webhooks (the agents' own replies) and
 * system messages are ignored.
 *
 * Outbound. POST /channels/{id}/messages; an answer to a channel message
 * replies to it (message_reference), which Discord shows in the channel, so
 * also_send_to_channel changes nothing here. Inside a thread it posts in the
 * thread. A private answer opens the DM (POST /users/@me/channels). Over
 * 2,000 characters it goes as several messages.
 *
 * Names. A Discord bot cannot change its name per message; a channel
 * webhook can. A company bot (invited with Manage Webhooks) makes one
 * webhook per channel the first time an agent answers there, caches its id
 * and token in the sealed credentials, and posts each agent reply through
 * it with the agent's username and avatar. A webhook cannot reply to a
 * message, so it mentions the asker instead. Without the permission (or in a
 * DM, or for a personal bot) the reply goes as the bot, the agent's name in
 * bold on the first line; a refused channel is retried after an hour.
 *
 * Rate limits: a 429 waits Discord's retry_after (up to 5 seconds) and tries
 * again, twice at most; longer is a ChatProviderError (rate_limited).
 *
 * Files: each attachment keeps its CDN url (on cdn.discordapp.com or
 * media.discordapp.net); a voice message (flag 8192) is a voice note. A
 * message with files and no text is still a message. The app fetches a
 * file only when the agent asks, proxied like every provider's; a url past
 * its expiry is refreshed with the bot token (POST /attachments/refresh-urls)
 * and tried once more.
 *
 * A link goes as a masked link, [label](<url>), on its own line.
 */

const DISCORD_API = 'https://discord.com/api/v10';
const USER_AGENT = 'DiscordBot (https://github.com/ciaranmci27/valiance-media-agentic-project-management, 1)';
const TIMEOUT_MS = 10_000;
const MAX_SKEW_SECONDS = 5 * 60;
const DISCORD_MAX = 2000;
const MAX_RETRY_WAIT_MS = 5_000;
const MAX_RETRIES = 2;
/** A channel that refused a webhook is tried again after this long (the permission may be granted). */
export const WEBHOOK_RETRY_MS = 60 * 60_000;
const SNOWFLAKE = /^\d{15,25}$/;
/** Thread channel types: announcement, public and private threads. */
const THREAD_TYPES = new Set([10, 11, 12]);
/** Text channels a name can resolve to: text and announcement. */
const TEXT_TYPES = new Set([0, 5]);
const WEBHOOK_NAME = 'PM agents';

export const RELAY_SIGNATURE_HEADER = 'X-PM-Relay-Signature';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Discord's payloads are read field by field
type Loose = any;

/** The wait between rate-limited tries: tests replace it. */
export const discordTiming: { sleep: (ms: number) => Promise<void> } = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The secret the relay signs with, made at connect and shown once. */
export function newRelaySecret(): string {
  return `rsec_${randomBytes(32).toString('hex')}`;
}

/** The hex HMAC-SHA256 of "<timestamp>.<body>" with the relay secret. */
export function relaySignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** The whole header value the relay sends: t=<unix>,v1=<hex>. */
export function relaySignatureHeader(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  return `t=${timestampSeconds},v1=${relaySignature(secret, String(timestampSeconds), body)}`;
}

interface Answer { status: number; json: Loose; }

/** One Discord call, rate limits honoured; never throws a raw network error or names the token. */
async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Answer> {
  const url = path.startsWith('https://') ? path : `${DISCORD_API}${path}`;
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await chatHttp.fetch(url, {
        method,
        headers: {
          'User-Agent': USER_AGENT,
          ...(options.token ? { Authorization: `Bot ${options.token}` } : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ChatProviderError('discord', 'network', 'Could not reach Discord');
    }
    const json = response.status === 204 ? {} : await response.json().catch(() => null);
    if (response.status !== 429) return { status: response.status, json };
    const seconds = Number(json?.retry_after ?? response.headers.get('retry-after') ?? NaN);
    const waitMs = Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : MAX_RETRY_WAIT_MS + 1;
    if (attempt >= MAX_RETRIES || waitMs > MAX_RETRY_WAIT_MS) {
      throw new ChatProviderError('discord', 'rate_limited', `Discord is rate limiting this bot. Try again in ${Number.isFinite(seconds) ? Math.ceil(seconds) : 'a few'} seconds.`);
    }
    await discordTiming.sleep(waitMs);
  }
}

const ok = (answer: Answer) => answer.status >= 200 && answer.status < 300 && answer.json !== null;

function refused(answer: Answer, what: string): ChatProviderError {
  const code = String(answer.json?.code ?? `http_${answer.status}`);
  const said = typeof answer.json?.message === 'string' ? answer.json.message.slice(0, 200) : `HTTP ${answer.status}`;
  return new ChatProviderError('discord', code, `${what}: ${said}`);
}

/** The parts of a text that fit one Discord message each. */
function parts(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += DISCORD_MAX) out.push(text.slice(at, at + DISCORD_MAX));
  return out.length ? out : [''];
}

/** Agent names never ping anyone or break the bold. */
const plainName = (name: string) => name.replace(/[*_`~|\\]/g, '').replace(/@/g, '').trim().slice(0, 80) || 'Agent';

/** Only people may be pinged by an agent's text: never @everyone, @here or a role. */
const ALLOWED_MENTIONS = { parse: ['users'], replied_user: true } as const;

const webhookKey = (channelId: string) => `webhook:${channelId}`;

/** The channel's cached webhook: its id and token, refused (and when), or nothing yet. */
function cachedWebhook(credentials: ChatCredentials, channelId: string): { id: string; token: string } | { refusedAt: number } | null {
  const value = credentials[webhookKey(channelId)];
  if (!value) return null;
  const [first, second] = value.split('/');
  if (first === 'none') return { refusedAt: Number(second) || 0 };
  return first && second ? { id: first, token: second } : null;
}

/** Posts as the bot: a reply references the message; the agent's name, when given, leads in bold. */
async function sendAsBot(credentials: ChatCredentials, message: OutboundMessage): Promise<string | null> {
  const target = message.threadId ?? message.conversationId;
  const replyTo = !message.threadId && message.replyTo && SNOWFLAKE.test(message.replyTo) ? message.replyTo : null;
  const text = message.as ? `**${plainName(message.as.username)}**\n${message.text}` : message.text;
  let first: string | null = null;
  for (const [index, content] of parts(text).entries()) {
    const answer = await call('POST', `/channels/${target}/messages`, {
      token: credentials.bot_token,
      body: {
        content,
        allowed_mentions: ALLOWED_MENTIONS,
        ...(replyTo && index === 0 ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } } : {}),
      },
    });
    if (!ok(answer)) throw refused(answer, 'Discord refused the message');
    if (first === null && typeof answer.json?.id === 'string') first = answer.json.id;
  }
  return first;
}

/** Posts through the channel's webhook under the agent's name and avatar; null when the webhook is gone. */
async function sendAsWebhook(hook: { id: string; token: string }, message: OutboundMessage & { as: NonNullable<OutboundMessage['as']> }): Promise<string | null | 'gone'> {
  const mention = !message.threadId && message.replyTo && message.replyToUser && SNOWFLAKE.test(message.replyToUser) ? message.replyToUser : null;
  const text = mention ? `<@${mention}> ${message.text}` : message.text;
  const query = `?wait=true${message.threadId ? `&thread_id=${encodeURIComponent(message.threadId)}` : ''}`;
  let first: string | null = null;
  for (const content of parts(text)) {
    const answer = await call('POST', `/webhooks/${hook.id}/${hook.token}${query}`, {
      body: {
        content,
        username: plainName(message.as.username),
        ...(message.as.iconUrl ? { avatar_url: message.as.iconUrl } : {}),
        allowed_mentions: mention ? { parse: [], users: [mention] } : { parse: ['users'] },
      },
    });
    // Deleted in Discord, or its token no longer works: forget it and go as the bot.
    if (first === null && (answer.status === 404 || answer.status === 401 || answer.json?.code === 10015)) return 'gone';
    if (!ok(answer)) throw refused(answer, 'Discord refused the message');
    if (first === null && typeof answer.json?.id === 'string') first = answer.json.id;
  }
  return first;
}

export const discordAdapter: ChatAdapter = {
  provider: 'discord',
  identityProvider: 'discord',
  // Discord user ids are global: a sender is known by an identity with no workspace.
  hasWorkspaces: false,

  verify({ headers, body, credentials, now }) {
    const header = headers.get(RELAY_SIGNATURE_HEADER) ?? '';
    const match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header.trim());
    if (!match || !credentials.relay_secret) return false;
    const seconds = Math.floor((now ?? Date.now()) / 1000);
    if (Math.abs(seconds - Number(match[1])) > MAX_SKEW_SECONDS) return false;
    return safeEqual(match[2], relaySignature(credentials.relay_secret, match[1], body));
  },

  parse(body): ParsedInbound {
    let payload: Loose;
    try { payload = JSON.parse(body); } catch { return { kind: 'ignore', reason: 'invalid_json' }; }
    if (payload?.t === 'RELAY_READY') return { kind: 'ping' };
    if (payload?.t === 'RELAY_HEARTBEAT') return { kind: 'ping', heartbeat: true };
    if (payload?.t !== 'MESSAGE_CREATE' || !payload.d || typeof payload.d !== 'object') return { kind: 'ignore', reason: 'not_a_message' };
    const message = payload.d;
    const author = message.author;
    if (!author || typeof author.id !== 'string' || author.bot || author.system || message.webhook_id) return { kind: 'ignore', reason: 'not_a_person' };
    // Ordinary messages and replies; joins, pins and the like are not.
    if (message.type !== undefined && message.type !== 0 && message.type !== 19) return { kind: 'ignore', reason: 'message_type' };
    if (typeof message.id !== 'string' || typeof message.channel_id !== 'string') return { kind: 'ignore', reason: 'empty' };

    const raw = typeof message.content === 'string' ? message.content : '';
    const people: Loose[] = Array.isArray(message.mentions) ? message.mentions : [];
    const byId = new Map(people.filter((user) => typeof user?.id === 'string').map((user) => [user.id as string, user]));
    const mentions = new Set<string>(byId.keys());
    for (const match of raw.matchAll(/<@!?(\d{5,25})>/g)) mentions.add(match[1]);
    const replied = message.referenced_message;
    if (typeof replied?.author?.id === 'string') mentions.add(replied.author.id);
    if (typeof replied?.application_id === 'string') mentions.add(replied.application_id);
    // A bot's mention is the address, not words; a person's reads as @name.
    const text = raw.replace(/<@!?(\d{5,25})>/g, (_token: string, id: string) => {
      const user = byId.get(id);
      if (!user || user.bot) return '';
      return `@${user.global_name || user.username || 'someone'}`;
    }).replace(/[ \t]{2,}/g, ' ').trim();
    const attachments = discordAttachments(message.attachments, Number(message.flags ?? 0));
    if (!text && attachments.length === 0) return { kind: 'ignore', reason: 'empty' };

    const channel = payload.channel ?? {};
    const inThread = THREAD_TYPES.has(Number(channel.type)) && typeof channel.parent_id === 'string' && channel.parent_id.length > 0;
    const direct = !message.guild_id;
    return {
      kind: 'message',
      dedupeKey: `message:${message.id}`,
      workspaceId: typeof message.guild_id === 'string' ? message.guild_id : null,
      userId: author.id,
      userHandle: typeof author.username === 'string' ? `@${author.username}` : null,
      conversationId: inThread ? channel.parent_id : message.channel_id,
      threadId: inThread ? message.channel_id : null,
      messageId: message.id,
      text,
      direct,
      // A server message speaks to the bot when it mentions it or replies to
      // it: inbound checks the mentions against the bot's own id.
      addressed: direct,
      mentions: [...mentions],
      ...(attachments.length ? { attachments } : {}),
      replyToMessageId: typeof replied?.id === 'string' ? replied.id
        : typeof message.message_reference?.message_id === 'string' ? message.message_reference.message_id : null,
    };
  },

  async send(credentials, original): Promise<SendResult> {
    const message: OutboundMessage = original.link
      ? { ...original, text: `${original.text}\n[${original.link.label.replace(/[[\]\\]/g, '')}](<${original.link.url}>)` }
      : original;
    const useWebhook = !!message.as && credentials.use_webhooks === '1' && !message.direct;
    if (!useWebhook) return { externalMessageId: await sendAsBot(credentials, message) };

    const as = message.as!;
    const channelId = message.conversationId;
    let changed: ChatCredentials | undefined;
    let hook = cachedWebhook(credentials, channelId);
    if (!hook || ('refusedAt' in hook && Date.now() - hook.refusedAt > WEBHOOK_RETRY_MS)) {
      const made = await call('POST', `/channels/${channelId}/webhooks`, { token: credentials.bot_token, body: { name: WEBHOOK_NAME } });
      if (ok(made) && typeof made.json?.id === 'string' && typeof made.json?.token === 'string') {
        hook = { id: made.json.id, token: made.json.token };
        changed = { ...credentials, [webhookKey(channelId)]: `${hook.id}/${hook.token}` };
      } else if (made.status === 403 || made.status === 400 || made.status === 404 || made.status === 401) {
        // No Manage Webhooks, a DM, or a channel that takes none (the limit of 15): go as the bot.
        hook = { refusedAt: Date.now() };
        changed = { ...credentials, [webhookKey(channelId)]: `none/${hook.refusedAt}` };
      } else {
        throw refused(made, 'Discord did not make the channel webhook');
      }
    }
    if ('id' in hook) {
      const sent = await sendAsWebhook(hook, { ...message, as });
      if (sent !== 'gone') return { externalMessageId: sent, ...(changed ? { credentials: changed } : {}) };
      const rest = { ...(changed ?? credentials) };
      delete rest[webhookKey(channelId)];
      changed = rest;
    }
    return { externalMessageId: await sendAsBot(credentials, message), ...(changed ? { credentials: changed } : {}) };
  },

  async openDirect(credentials, userId) {
    const answer = await call('POST', '/users/@me/channels', { token: credentials.bot_token, body: { recipient_id: userId } });
    if (!ok(answer) || typeof answer.json?.id !== 'string') throw refused(answer, 'Discord did not open the direct message');
    return answer.json.id;
  },

  async resolveChannel(credentials, input) {
    const value = input.trim().replace(/^<#(\d+)>$/, '$1');
    if (SNOWFLAKE.test(value)) {
      // The name is a nicety: the id alone works.
      const info = await call('GET', `/channels/${value}`, { token: credentials.bot_token }).catch(() => null);
      return { id: value, name: info && ok(info) && typeof info.json?.name === 'string' ? `#${info.json.name}` : null };
    }
    const wanted = value.replace(/^#/, '').toLowerCase();
    const guilds = await call('GET', '/users/@me/guilds?limit=200', { token: credentials.bot_token });
    if (!ok(guilds) || !Array.isArray(guilds.json)) throw refused(guilds, 'Discord would not list the bot\'s servers');
    for (const guild of (guilds.json as Loose[]).slice(0, 20)) {
      if (typeof guild?.id !== 'string') continue;
      const channels = await call('GET', `/guilds/${guild.id}/channels`, { token: credentials.bot_token });
      if (!ok(channels) || !Array.isArray(channels.json)) continue;
      const found = (channels.json as Loose[]).find((channel) => TEXT_TYPES.has(channel?.type) && typeof channel?.name === 'string' && channel.name.toLowerCase() === wanted);
      if (found) return { id: String(found.id), name: `#${found.name}` };
    }
    throw new ChatProviderError('discord', 'channel_not_found',
      `No channel named #${wanted} in the bot's servers. Invite the bot to the server, or paste the channel id (with Developer Mode on in Discord, right-click the channel and Copy Channel ID).`);
  },

  async connect({ credentials, displayName, kind }) {
    const me = await call('GET', '/users/@me', { token: credentials.bot_token });
    if (me.status === 401) throw new ChatProviderError('discord', '401', 'Discord did not accept that bot token. Reset it on the Bot page and copy it again.');
    if (!ok(me) || typeof me.json?.id !== 'string') throw refused(me, 'Discord refused the token');
    if (me.json.bot !== true) throw new ChatProviderError('discord', 'not_a_bot', 'That token is not a bot\'s. Copy it from the Bot page of your app in the Developer Portal.');
    const app = await call('GET', '/oauth2/applications/@me', { token: credentials.bot_token }).catch(() => null);
    const applicationId = app && ok(app) && typeof app.json?.id === 'string' ? app.json.id : me.json.id;
    const relaySecret = newRelaySecret();
    const username = typeof me.json.username === 'string' ? me.json.username : null;
    return {
      credentials: {
        bot_token: credentials.bot_token,
        relay_secret: relaySecret,
        application_id: applicationId,
        // Channel webhooks give each agent its own name; a personal bot only DMs.
        use_webhooks: kind === 'company' ? '1' : '0',
      },
      // The application: one connection per bot and kind, and the invite link.
      workspaceId: applicationId,
      botId: me.json.id,
      botHandle: username ? `@${username}` : null,
      displayName: displayName ?? (typeof me.json.global_name === 'string' && me.json.global_name ? me.json.global_name : username ?? 'Discord'),
      relaySecret,
    };
  },

  async disconnect(credentials) {
    // The channel webhooks it made go with it; the relay is the install's to stop.
    for (const [key, value] of Object.entries(credentials)) {
      if (!key.startsWith('webhook:')) continue;
      const [id, token] = value.split('/');
      if (id === 'none' || !id || !token) continue;
      try {
        await call('DELETE', `/webhooks/${id}/${token}`);
      } catch {
        // Removing the connection never waits on Discord.
      }
    }
  },

  openUrl({ botId }) {
    // The bot's profile, from which a person who shares a server with it messages it.
    return botId && /^\d{5,25}$/.test(botId) ? `https://discord.com/users/${botId}` : null;
  },

  async fetchAttachment(credentials, attachment, maxBytes) {
    if (attachment.size !== null && attachment.size > maxBytes) throw tooLarge('discord', maxBytes);
    if (!isDiscordCdnUrl(attachment.ref)) throw new ChatProviderError('discord', 'bad_file_url', 'Discord gave no address the app fetches files from');
    const get = (url: string) => downloadCapped('discord', url, { maxBytes, allowRedirect: (next) => isDiscordCdnUrl(next.toString()) });
    let got = await get(attachment.ref);
    if (!got.body && [403, 404, 410].includes(got.status)) {
      // A CDN link expires: Discord signs a fresh one for the bot.
      const fresh = await call('POST', '/attachments/refresh-urls', { token: credentials.bot_token, body: { attachment_urls: [attachment.ref] } });
      const refreshed = ok(fresh) && Array.isArray(fresh.json?.refreshed_urls) ? fresh.json.refreshed_urls[0]?.refreshed : null;
      if (isDiscordCdnUrl(refreshed)) got = await get(refreshed);
    }
    if (!got.body) throw new ChatProviderError('discord', `http_${got.status}`, `Discord answered ${got.status} for the file`);
    return { body: got.body, size: got.size, mimeType: got.mimeType };
  },
};

const DISCORD_CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
const isDiscordCdnUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && DISCORD_CDN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
};

/** A Discord voice message (MessageFlags.IS_VOICE_MESSAGE). */
const VOICE_MESSAGE_FLAG = 1 << 13;

/** The files on a Discord message: each one on Discord's CDN. */
export function discordAttachments(files: unknown, flags = 0): InboundAttachment[] {
  if (!Array.isArray(files)) return [];
  const out: InboundAttachment[] = [];
  for (const file of files.slice(0, 20) as Loose[]) {
    if (!isDiscordCdnUrl(file?.url)) continue;
    const mime = cleanMimeType(file.content_type);
    const voice = (flags & VOICE_MESSAGE_FLAG) !== 0 && (mime ?? '').startsWith('audio/');
    out.push({
      kind: voice ? 'voice' : attachmentKindFor(mime),
      ref: file.url,
      name: cleanFileName(file.filename),
      mime_type: mime,
      size: countOrNull(file.size),
      duration_seconds: countOrNull(file.duration_secs),
    });
  }
  return out;
}
