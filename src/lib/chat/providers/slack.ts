import { createHmac } from 'node:crypto';
import {
  attachmentKindFor, ChatProviderError, cleanFileName, cleanMimeType, countOrNull, downloadCapped, postForm, postJson, safeEqual, tooLarge,
  type ChatAdapter, type ChatCredentials, type InboundAttachment, type ParsedInbound,
} from './adapter';

/**
 * Slack: an app with a bot token (xoxb-) and its signing secret, pasted by an
 * Owner. Slack signs every request: v0= HMAC-SHA256 of "v0:<timestamp>:<body>"
 * with the signing secret, in X-Slack-Signature, the timestamp in
 * X-Slack-Request-Timestamp (refused when more than five minutes off, so an
 * old request cannot be replayed). The URL verification challenge is
 * answered once signed. Direct messages, mentions and channel messages (a
 * company bot listens there) are read; a bot's own messages and edits are
 * ignored. A retry (X-Slack-Retry-Num) carries the same event_id, the dedupe
 * key.
 *
 * Replies carry the agent's name and avatar (username and icon_url, which
 * need the chat:write.customize scope), thread under the message they
 * answer, and may also show in the channel (reply_broadcast).
 *
 * Files: a message that shares files (subtype file_share) is read like any
 * other; each file becomes an attachment holding its url_private_download,
 * which must be on files.slack.com. The app fetches it only when the agent
 * asks, with the bot token in the Authorization header (the app needs the
 * files:read scope), so it is proxied and never handed out. A file Slack
 * gives no address for (Slack Connect's check_file_info) is left out.
 *
 * A link goes as Slack's <url|label> on its own line.
 *
 * Broadcast mentions in what is sent (<!channel>, <!here>, <!everyone>,
 * <!subteam^...>) become plain text, so an agent never notifies a whole
 * channel or group; a person's <@U...> stays, which replies use on purpose.
 */

const SLACK_API = 'https://slack.com/api';
const MAX_SKEW_SECONDS = 5 * 60;
/** A Slack conversation id: channels C, private channels G, DMs D. */
const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

export function slackSignature(signingSecret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack's payloads are read field by field
type Loose = any;

const auth = (credentials: ChatCredentials) => ({ Authorization: `Bearer ${credentials.bot_token}` });
const refused = (answer: Record<string, unknown>, what: string) =>
  new ChatProviderError('slack', String(answer.error ?? 'failed'), `${what}: ${String(answer.error ?? 'failed')}`);

export const slackAdapter: ChatAdapter = {
  provider: 'slack',
  identityProvider: 'slack',
  hasWorkspaces: true,

  verify({ headers, body, credentials, now }) {
    const timestamp = headers.get('x-slack-request-timestamp') ?? '';
    const signature = headers.get('x-slack-signature') ?? '';
    if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith('v0=') || !credentials.signing_secret) return false;
    const seconds = Math.floor((now ?? Date.now()) / 1000);
    if (Math.abs(seconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
    return safeEqual(signature, slackSignature(credentials.signing_secret, timestamp, body));
  },

  parse(body): ParsedInbound {
    let payload: Loose;
    try { payload = JSON.parse(body); } catch { return { kind: 'ignore', reason: 'invalid_json' }; }
    if (payload?.type === 'url_verification' && typeof payload.challenge === 'string') return { kind: 'challenge', challenge: payload.challenge.slice(0, 500) };
    if (payload?.type !== 'event_callback' || !payload.event) return { kind: 'ignore', reason: 'not_an_event' };
    const event = payload.event;
    // Edits, joins and the like are not messages; sharing a file is.
    if (event.bot_id || (event.subtype && event.subtype !== 'file_share') || !event.user) return { kind: 'ignore', reason: 'not_a_person' };
    const direct = event.type === 'message' && event.channel_type === 'im';
    const mention = event.type === 'app_mention';
    // A channel, private channel or group DM message: where a company bot listens.
    const shared = event.type === 'message' && ['channel', 'group', 'mpim'].includes(event.channel_type);
    if (!direct && !mention && !shared) return { kind: 'ignore', reason: 'event_type' };
    const raw = typeof event.text === 'string' ? event.text : '';
    const mentions = [...raw.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map((match) => match[1]);
    const text = raw.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>\s*/g, '').trim();
    const attachments = slackAttachments(event.files);
    if ((!text && attachments.length === 0) || typeof event.channel !== 'string' || typeof payload.event_id !== 'string') return { kind: 'ignore', reason: 'empty' };
    return {
      kind: 'message',
      dedupeKey: payload.event_id,
      workspaceId: typeof payload.team_id === 'string' ? payload.team_id : null,
      userId: String(event.user),
      userHandle: null,
      conversationId: event.channel,
      // The thread it was said in, if any. An answer to a top-level channel
      // message starts a thread on it (replyTo: the message's ts).
      threadId: typeof event.thread_ts === 'string' ? event.thread_ts : null,
      messageId: typeof event.ts === 'string' ? event.ts : null,
      text,
      direct,
      // A DM or an app_mention speaks to the bot; a channel message does when
      // it mentions the bot's own user (inbound knows the bot's id).
      addressed: direct || mention,
      mentions,
      ...(attachments.length ? { attachments } : {}),
    };
  },

  async send(credentials, message) {
    const threadTs = message.threadId ?? message.replyTo ?? null;
    const answer = await postJson('slack', `${SLACK_API}/chat.postMessage`, {
      channel: message.conversationId,
      text: message.link ? `${quietBroadcasts(message.text)}\n<${message.link.url}|${slackEscape(message.link.label)}>` : quietBroadcasts(message.text),
      // Plain @channel or @group text is never turned into a mention.
      link_names: false,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(threadTs && message.broadcast ? { reply_broadcast: true } : {}),
      ...(message.as ? { username: message.as.username.slice(0, 80), ...(message.as.iconUrl ? { icon_url: message.as.iconUrl } : {}) } : {}),
    }, auth(credentials));
    if (answer.ok !== true) throw refused(answer, 'Slack refused the message');
    return { externalMessageId: typeof answer.ts === 'string' ? answer.ts : null };
  },

  async openDirect(credentials, userId) {
    const answer = await postJson('slack', `${SLACK_API}/conversations.open`, { users: userId }, auth(credentials));
    const channel = (answer.channel as Loose)?.id;
    if (answer.ok !== true || typeof channel !== 'string') throw refused(answer, 'Slack did not open the direct message');
    return channel;
  },

  async resolveChannel(credentials, input) {
    const value = input.trim();
    if (SLACK_CHANNEL_ID.test(value)) {
      // The name is a nicety: without channels:read the id alone works.
      const info = await postForm('slack', `${SLACK_API}/conversations.info`, { channel: value }, auth(credentials)).catch(() => null);
      const name = info?.ok === true && typeof (info.channel as Loose)?.name === 'string' ? `#${(info.channel as Loose).name}` : null;
      return { id: value, name };
    }
    const wanted = value.replace(/^#/, '').toLowerCase();
    let cursor = '';
    for (let page = 0; page < 20; page++) {
      const list = await postForm('slack', `${SLACK_API}/conversations.list`, {
        types: 'public_channel,private_channel', exclude_archived: 'true', limit: '1000', ...(cursor ? { cursor } : {}),
      }, auth(credentials));
      if (list.ok !== true) {
        throw new ChatProviderError('slack', String(list.error ?? 'failed'),
          `Slack would not list channels (${String(list.error ?? 'failed')}). Paste the channel id instead: it is at the bottom of the channel's details and starts with C.`);
      }
      const found = ((list.channels as Loose[]) ?? []).find((channel) => typeof channel?.name === 'string' && channel.name.toLowerCase() === wanted);
      if (found) return { id: String(found.id), name: `#${found.name}` };
      cursor = String((list.response_metadata as Loose)?.next_cursor ?? '');
      if (!cursor) break;
    }
    throw new ChatProviderError('slack', 'channel_not_found', `No channel named #${wanted} that the bot can see. Invite the bot to it, or paste the channel id.`);
  },

  async connect({ credentials, displayName }) {
    const answer = await postJson('slack', `${SLACK_API}/auth.test`, {}, auth(credentials));
    if (answer.ok !== true) {
      throw new ChatProviderError('slack', String(answer.error ?? 'failed'), answer.error === 'invalid_auth' || answer.error === 'not_authed'
        ? 'Slack did not accept that bot token. Copy the Bot User OAuth Token again.'
        : `Slack refused the token: ${String(answer.error ?? 'failed')}`);
    }
    const team = typeof answer.team === 'string' ? answer.team : 'Slack';
    return {
      credentials: { bot_token: credentials.bot_token, signing_secret: credentials.signing_secret },
      workspaceId: typeof answer.team_id === 'string' ? answer.team_id : null,
      botId: typeof answer.user_id === 'string' ? answer.user_id : null,
      botHandle: typeof answer.user === 'string' ? answer.user : null,
      displayName: displayName ?? team,
    };
  },

  async disconnect() {
    // Nothing to undo: the Slack app stays as the Owner made it.
  },

  openUrl({ workspaceId, botId }) {
    // Slack's own redirect opens a DM with the bot user, in the app or the browser.
    if (!workspaceId || !botId || !/^[A-Z0-9]+$/.test(workspaceId) || !/^[A-Z0-9]+$/.test(botId)) return null;
    return `https://slack.com/app_redirect?team=${workspaceId}&channel=${botId}`;
  },

  async fetchAttachment(credentials, attachment, maxBytes) {
    if (attachment.size !== null && attachment.size > maxBytes) throw tooLarge('slack', maxBytes);
    if (!isSlackFileUrl(attachment.ref)) throw new ChatProviderError('slack', 'bad_file_url', 'Slack gave no address the app fetches files from');
    const got = await downloadCapped('slack', attachment.ref, {
      maxBytes,
      // The token goes to Slack's file host only, never to a host a redirect names.
      headersFor: (url) => (url.hostname === SLACK_FILE_HOST ? auth(credentials) : {}),
      allowRedirect: (url) => url.hostname === SLACK_FILE_HOST || url.hostname.endsWith('.slack-edge.com'),
    });
    if (!got.body) throw new ChatProviderError('slack', `http_${got.status}`, `Slack answered ${got.status} for the file`);
    // Without files:read Slack answers its sign-in page instead of the file.
    if (got.mimeType === 'text/html' && attachment.mime_type !== 'text/html') {
      await got.body.cancel().catch(() => undefined);
      throw new ChatProviderError('slack', 'missing_scope', 'Slack would not hand over the file: add the files:read bot scope to the Slack app and reinstall it');
    }
    return { body: got.body, size: got.size, mimeType: got.mimeType };
  },
};

const SLACK_FILE_HOST = 'files.slack.com';
const isSlackFileUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === SLACK_FILE_HOST;
  } catch {
    return false;
  }
};

/**
 * Slack's broadcast mentions as plain text: <!here> reads "@here", a user
 * group its handle, and none of them notify. People (<@U...>) are kept.
 */
const quietBroadcasts = (text: string) => text
  .replace(/<!subteam\^[^>|]*(?:\|([^>]*))?>/gi, (_match, label?: string) => (label ? `@${label.replace(/^@/, '')}` : '@group'))
  // Every other <!...> form (channel, here, everyone, the legacy group, and any Slack adds later) as plain text;
  // only <!date^...> stays, since it formats a date and notifies nobody.
  .replace(/<!(?!date\^)([^>|]*)(?:\|[^>]*)?>/gi, (_match, name: string) => `@${name.toLowerCase()}`);

/** Slack's mrkdwn control characters, so a label never breaks the link. */
const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '/');

/** The files on a Slack message: each one Slack gives a files.slack.com address for. */
export function slackAttachments(files: unknown): InboundAttachment[] {
  if (!Array.isArray(files)) return [];
  const out: InboundAttachment[] = [];
  for (const file of files.slice(0, 20) as Loose[]) {
    const url = file?.url_private_download ?? file?.url_private;
    if (!isSlackFileUrl(url)) continue;
    const mime = cleanMimeType(file.mimetype);
    const duration = countOrNull(file.duration_ms);
    out.push({
      // Slack's recorded clips are audio files marked slack_audio.
      kind: file.subtype === 'slack_audio' ? 'voice' : attachmentKindFor(mime),
      ref: url,
      name: cleanFileName(file.name ?? file.title),
      mime_type: mime,
      size: countOrNull(file.size),
      duration_seconds: duration === null ? null : Math.round(duration / 1000),
    });
  }
  return out;
}
