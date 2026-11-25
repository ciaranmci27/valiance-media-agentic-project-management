import { createHmac } from 'node:crypto';
import { ChatProviderError, postJson, safeEqual, type ChatAdapter, type ParsedInbound } from './adapter';

/**
 * Slack: an app with a bot token (xoxb-) and its signing secret, pasted by an
 * Owner. Slack signs every request: v0= HMAC-SHA256 of "v0:<timestamp>:<body>"
 * with the signing secret, in X-Slack-Signature, the timestamp in
 * X-Slack-Request-Timestamp (refused when more than five minutes off, so an
 * old request cannot be replayed). The URL verification challenge is
 * answered once signed. Direct messages and mentions reach the assistant; a
 * bot's own messages and edits are ignored. A retry (X-Slack-Retry-Num)
 * carries the same event_id, the dedupe key.
 */

const SLACK_API = 'https://slack.com/api';
const MAX_SKEW_SECONDS = 5 * 60;

export function slackSignature(signingSecret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Slack's payloads are read field by field
type Loose = any;

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
    if (event.bot_id || event.subtype || !event.user) return { kind: 'ignore', reason: 'not_a_person' };
    const direct = event.type === 'message' && event.channel_type === 'im';
    const mention = event.type === 'app_mention';
    if (!direct && !mention) return { kind: 'ignore', reason: 'event_type' };
    const text = typeof event.text === 'string' ? event.text.replace(/<@[A-Z0-9]+>\s*/g, '').trim() : '';
    if (!text || typeof event.channel !== 'string' || typeof payload.event_id !== 'string') return { kind: 'ignore', reason: 'empty' };
    return {
      kind: 'message',
      dedupeKey: payload.event_id,
      workspaceId: typeof payload.team_id === 'string' ? payload.team_id : null,
      userId: String(event.user),
      userHandle: null,
      conversationId: event.channel,
      // A direct message stays in the conversation unless it is already a
      // thread; a mention in a channel is answered in its thread.
      threadId: typeof event.thread_ts === 'string' ? event.thread_ts : mention && typeof event.ts === 'string' ? event.ts : null,
      messageId: typeof event.ts === 'string' ? event.ts : null,
      text,
      direct,
    };
  },

  async send(credentials, message) {
    const answer = await postJson('slack', `${SLACK_API}/chat.postMessage`, {
      channel: message.conversationId,
      text: message.text,
      ...(message.threadId ? { thread_ts: message.threadId } : {}),
    }, { Authorization: `Bearer ${credentials.bot_token}` });
    if (answer.ok !== true) throw new ChatProviderError('slack', String(answer.error ?? 'failed'), `Slack refused the message: ${String(answer.error ?? 'failed')}`);
    return { externalMessageId: typeof answer.ts === 'string' ? answer.ts : null };
  },

  async connect({ credentials, displayName }) {
    const answer = await postJson('slack', `${SLACK_API}/auth.test`, {}, { Authorization: `Bearer ${credentials.bot_token}` });
    if (answer.ok !== true) {
      throw new ChatProviderError('slack', String(answer.error ?? 'failed'), answer.error === 'invalid_auth' || answer.error === 'not_authed'
        ? 'Slack did not accept that bot token. Copy the Bot User OAuth Token again.'
        : `Slack refused the token: ${String(answer.error ?? 'failed')}`);
    }
    const team = typeof answer.team === 'string' ? answer.team : 'Slack';
    return {
      credentials: { bot_token: credentials.bot_token, signing_secret: credentials.signing_secret },
      workspaceId: typeof answer.team_id === 'string' ? answer.team_id : null,
      botHandle: typeof answer.user === 'string' ? answer.user : null,
      displayName: displayName ?? team,
    };
  },

  async disconnect() {
    // Nothing to undo: the Slack app stays as the Owner made it.
  },

  openUrl() {
    return null;
  },
};
