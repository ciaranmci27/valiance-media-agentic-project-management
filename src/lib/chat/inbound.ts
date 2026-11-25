import type { SupabaseClient } from '@supabase/supabase-js';
import { readAssistantSettings, findPersonalAgent, missingAssistantSchema, notifyAssistantBroken, statesOf } from '@/lib/api/assistant';
import { createLinkRequest, findIdentity } from '@/lib/api/identities';
import { afterResponse } from '@/lib/api/after-response';
import { readStoredBrand } from '@/lib/brand/server';
import { enabledModuleSet } from '@/lib/modules/server';
import { runDispatch } from '@/lib/webhooks/dispatch';
import { openCredentials, loadConnection } from './connections';
import { chatAdapter, type ChatAdapter, type ChatCredentials, type ParsedInbound } from './providers';
import { CHAT_WORDS } from './types';
import { assistantMessagePayload } from './messages';

/**
 * A chat provider's request to /api/chat/inbound/{connection_id}, end to end:
 *
 * 1. The connection must exist, have an adapter and readable credentials,
 *    and the adapter must verify the request (Slack's signature, Telegram's
 *    secret token) before anything is read. Each of those failing answers
 *    the same 401, so nobody can tell whether a connection exists. Slack's
 *    URL challenge is answered once verified. An event from another Slack
 *    workspace than the connection's is ignored.
 * 2. A retry of a delivery already recorded (the provider's event id) is a
 *    no-op; inbound messages are rate limited per connection and per sender.
 * 3. The sender is resolved through a verified linked account in this
 *    connection's workspace (or, for providers with no workspaces, one with
 *    none). Someone unknown gets a one-time link to connect their account
 *    (the existing link handshake), only in a one-to-one chat and at most
 *    once an hour; in a shared conversation they are asked to message the
 *    bot directly. Someone suspended, with no assistant, or whose assistant
 *    is paused gets one plain line, and a paused-by-admin assistant's admins
 *    are told.
 * 4. Otherwise the message is recorded for the person's assistant and sent
 *    to its webhook (assistant.message, ids only: chat is private, so the
 *    assistant fetches the text with its own key); with no endpoint it waits
 *    for the assistant to fetch it. No act-for token: a personal agent is
 *    already narrowed to its person.
 *
 * Nothing logs a token, and message text never reaches a log.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export interface InboundResult {
  status: number;
  body: Record<string, unknown>;
}

/** Inbound messages per connection per minute. */
export const CHAT_RATE_LIMIT = 120;
/** Inbound messages per sender per minute, so one stranger cannot flood a public bot. */
export const CHAT_SENDER_RATE_LIMIT = 20;
const CHAT_RATE_WINDOW_SECONDS = 60;
/** An unknown sender gets one link at most this often. */
export const LINK_THROTTLE_MS = 60 * 60_000;

const done = (body: Record<string, unknown>, status = 200): InboundResult => ({ status, body });
/** The one answer for an unknown connection, a bad signature, no adapter or unreadable credentials. */
const refused = (): InboundResult => done({ error: 'Unauthorized' }, 401);

/** Answers in the conversation the message came from, recorded as outbound; a send failure is recorded, never thrown. */
async function answer(
  service: SupabaseClient,
  ctx: { connection: Row; adapter: ChatAdapter; credentials: ChatCredentials },
  inbound: { id: string; conversationId: string; threadId: string | null },
  text: string,
): Promise<void> {
  let externalId: string | null = null;
  let error: string | null = null;
  try {
    externalId = (await ctx.adapter.send(ctx.credentials, { conversationId: inbound.conversationId, threadId: inbound.threadId, text })).externalMessageId;
  } catch (failure) {
    error = failure instanceof Error ? failure.message.slice(0, 500) : 'Send failed';
    console.error(`[chat] reply on connection ${ctx.connection.id} failed: ${error}`);
  }
  await service.from('chat_messages').insert({
    connection_id: ctx.connection.id, direction: 'outbound', status: error ? 'failed' : 'sent',
    conversation_id: inbound.conversationId, thread_id: inbound.threadId, external_message_id: externalId,
    reply_to_id: inbound.id, text, error,
  });
}

/** One message against a rate window; a function that returns a table answers rows. */
async function allowed(service: SupabaseClient, connectionId: string, subject: string, limit: number): Promise<boolean> {
  const { data, error } = await service.rpc('consume_chat_rate_limit', {
    p_connection_id: connectionId, p_subject: subject, p_limit: limit, p_window_seconds: CHAT_RATE_WINDOW_SECONDS,
  });
  if (error) throw error;
  const window = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean } | null;
  return window?.allowed === true;
}

export async function handleChatInbound(
  service: SupabaseClient,
  connectionId: string,
  request: { headers: Headers; body: string },
  appUrl: string,
): Promise<InboundResult> {
  let connection: Row | null;
  try {
    connection = await loadConnection(service, connectionId);
  } catch (error) {
    if (missingAssistantSchema(error as { code?: string })) return refused();
    throw error;
  }
  if (!connection) return refused();
  const adapter = chatAdapter(connection.provider);
  if (!adapter) return refused();
  let credentials: ChatCredentials;
  try {
    credentials = openCredentials(connection as { id: string; credentials: string });
  } catch {
    console.error(`[chat] connection ${connection.id}: credentials cannot be opened (APP_ENCRYPTION_KEY missing or changed)`);
    return refused();
  }
  if (!adapter.verify({ headers: request.headers, body: request.body, credentials })) return refused();

  const parsed: ParsedInbound = adapter.parse(request.body, request.headers);
  if (parsed.kind === 'challenge') return done({ challenge: parsed.challenge });
  if (parsed.kind === 'ignore') return done({ status: 'ignored', reason: parsed.reason });
  if (connection.enabled === false) return done({ status: 'ignored', reason: 'connection_off' });
  // Another workspace's event (a Slack app installed twice): not this connection's.
  if (adapter.hasWorkspaces && connection.external_workspace_id && parsed.workspaceId !== connection.external_workspace_id) {
    return done({ status: 'ignored', reason: 'other_workspace' });
  }

  // A retry of what is already recorded: nothing more to do.
  const { data: seen } = await service.from('chat_messages').select('id').eq('connection_id', connection.id).eq('dedupe_key', parsed.dedupeKey).maybeSingle();
  if (seen) return done({ status: 'duplicate', id: (seen as Row).id });

  if (!(await allowed(service, connection.id, '', CHAT_RATE_LIMIT))) return done({ error: 'Too many messages. Try again in a minute.' }, 429);
  if (!(await allowed(service, connection.id, `user:${parsed.userId}`, CHAT_SENDER_RATE_LIMIT))) return done({ error: 'Too many messages. Try again in a minute.' }, 429);

  console.info(`[chat] inbound on ${connection.provider} connection ${connection.id}, ${parsed.text.length} characters`);
  await service.from('chat_connections').update({ last_inbound_at: new Date().toISOString() }).eq('id', connection.id);
  const ctx = { connection, adapter, credentials };

  /** Records the message; a race with a retry (the same dedupe key) is a duplicate. */
  const record = async (fields: Row): Promise<string | null> => {
    const { data, error } = await service.from('chat_messages').insert({
      connection_id: connection!.id, direction: 'inbound', conversation_id: parsed.conversationId, thread_id: parsed.threadId,
      external_message_id: parsed.messageId, external_user_id: parsed.userId, dedupe_key: parsed.dedupeKey, text: parsed.text.slice(0, 40000), ...fields,
    }).select('id').single();
    if (error?.code === '23505') return null;
    if (error) throw error;
    return (data as Row).id as string;
  };
  const unrouted = async (fields: Row, words: string | null): Promise<InboundResult> => {
    const id = await record({ status: 'unrouted', handled_at: new Date().toISOString(), ...fields });
    if (!id) return done({ status: 'duplicate' });
    if (words) await answer(service, ctx, { id, conversationId: parsed.conversationId, threadId: parsed.threadId }, words);
    return done({ status: 'unrouted', id });
  };

  const [modules, settings] = await Promise.all([enabledModuleSet(service), readAssistantSettings(service)]);
  if (!modules.has('agents') || !settings.enabled) return unrouted({}, CHAT_WORDS.assistantsOff);

  // Who is it? Only a verified linked account in this connection's workspace says.
  const workspaceId = adapter.hasWorkspaces ? (connection.external_workspace_id ?? parsed.workspaceId) : null;
  const identity = await findIdentity(service, { provider: adapter.identityProvider, external_id: parsed.userId, workspace_id: workspaceId });
  if (!identity || !identity.verified_at) {
    // A one-time link only in a one-to-one chat: never where others read it.
    if (!parsed.direct) return unrouted({}, CHAT_WORDS.linkDirectly);
    const since = new Date(Date.now() - LINK_THROTTLE_MS).toISOString();
    let recentQuery = service.from('identity_link_requests').select('id').eq('provider', adapter.identityProvider).eq('external_id', parsed.userId)
      .gte('created_at', since);
    recentQuery = workspaceId === null ? recentQuery.is('workspace_id', null) : recentQuery.eq('workspace_id', workspaceId);
    const { data: recent } = await recentQuery.limit(1);
    if ((recent ?? []).length) return unrouted({}, CHAT_WORDS.linkAgain);
    const link = await createLinkRequest(service, { memberId: connection.created_by ?? null, keyId: null } as { memberId: string; keyId: string | null }, {
      provider: adapter.identityProvider, external_id: parsed.userId, workspace_id: workspaceId, handle: parsed.userHandle,
    }, appUrl);
    let workspace = 'this workspace';
    try { workspace = (await readStoredBrand(service)).settings.name?.trim() || workspace; } catch { /* the default name */ }
    return unrouted({}, CHAT_WORDS.linkPrompt(workspace, link.url));
  }

  const { data: person } = await service.from('team_members').select('id, name, role, status').eq('id', identity.member_id).maybeSingle();
  const member = person as Row | null;
  if (!member || member.role === 'agent' || member.status === 'suspended') return unrouted({ identity_id: identity.id }, CHAT_WORDS.inactive);
  const known = { member_id: member.id, identity_id: identity.id };

  const agent = await findPersonalAgent(service, member.id);
  if (!agent) return unrouted(known, CHAT_WORDS.noAssistant);
  const { state, reason } = (await statesOf(service, [agent])).get(agent.id)!;
  if (state === 'paused') return unrouted({ ...known, agent_id: agent.id }, CHAT_WORDS.pausedByYou(`${appUrl.replace(/\/+$/, '')}/assistant`));
  if (state === 'broken' && reason === 'paused_by_admin') {
    await notifyAssistantBroken(service, { id: agent.id, name: agent.name }, { id: member.id, name: member.name }, reason);
    return unrouted({ ...known, agent_id: agent.id }, CHAT_WORDS.paused);
  }

  // For the assistant: recorded, then sent to its webhook or left for it to fetch.
  const id = await record({ ...known, agent_id: agent.id, status: 'pending' });
  if (!id) return done({ status: 'duplicate' });
  if (!modules.has('webhooks')) return done({ status: 'pending', id });
  const payload = await assistantMessagePayload(service, id);
  const { data: emitted, error: emitError } = await service.rpc('emit_assistant_message', { p_message_id: id, p_agent_id: agent.id, p_data: payload });
  if (emitError) {
    console.error(`[chat] could not queue assistant.message for ${id}`, emitError.code);
    return done({ status: 'pending', id });
  }
  if (emitted !== true) return done({ status: 'pending', id });
  await service.from('chat_messages').update({ status: 'notified' }).eq('id', id).eq('status', 'pending');
  afterResponse('webhook dispatch', () => runDispatch());
  return done({ status: 'notified', id });
}
