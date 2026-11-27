import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { apiKeyAllows } from '@/lib/api/access';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { missingAssistantSchema, readAssistantSettings } from '@/lib/api/assistant';
import { connectionKind, CONNECTION_COLUMNS, openCredentials, storeCredentials } from './connections';
import { chatAdapter, ChatProviderError, type ChatAdapter } from './providers';
import type { ChatConnectionKind, ChatSendInput } from './types';
import { ACT_FOR_PROOF_MINUTES } from '@/lib/delegation';

/** Whether this member wrote to this agent in chat in the last ACT_FOR_PROOF_MINUTES. */
async function memberWroteLately(service: SupabaseClient, agentId: string, memberId: string): Promise<boolean> {
  const since = new Date(Date.now() - ACT_FOR_PROOF_MINUTES * 60_000).toISOString();
  const { data, error } = await service.from('chat_messages').select('id')
    .eq('direction', 'inbound').eq('agent_id', agentId).eq('member_id', memberId).gte('created_at', since).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * An agent starts a chat conversation (POST /api/v1/chat/messages, MCP
 * send_chat_message): a personal assistant's morning digest or urgent alert
 * to its person, a company agent's daily report in its channel. Who may be
 * messaged is narrow on purpose, since an agent that can message anyone is a
 * spam and privacy risk:
 *
 * - A personal assistant messages only its own person (delegate_of), in the
 *   DM of a personal connection where that person has a verified linked
 *   account. Never a channel, never anyone else.
 * - A company agent works only on company connections that list it
 *   (chat_connection_agents).
 *   - A channel: only one mapped to it (chat_channel_routes) on that
 *     connection. Being the connection's default agent does not widen this:
 *     the default answers DMs, it does not post anywhere it likes. Map the
 *     channel to it.
 *   - A DM: only to an active member with a verified linked account on that
 *     connection, and only when that member wrote to this agent in chat in
 *     the last ACT_FOR_PROOF_MINUTES, or, unprompted, with chat.notify on
 *     both the agent and its key. Acting for them (X-Act-For) never stands
 *     in for either, and a pass for someone else is refused. No role holds
 *     chat.notify by default.
 * - Rate limits, per connection: CHAT_SEND_AGENT_LIMIT messages an hour per
 *   agent, CHAT_SEND_RECIPIENT_LIMIT an hour per recipient (a person or a
 *   channel, whichever agents send). 429 chat_rate_limited past either.
 * - A paused or on-hold agent is refused before this runs (423, the request
 *   gate), and a person's Pause suspends their assistant (its key stops).
 *
 * The message goes under the agent's own name and avatar where the provider
 * allows, as replies do, and is recorded outbound with initiated true. A
 * reply to it goes back to the same agent (inbound.ts). No webhook event is
 * sent for it: the agent made it and has the answer. Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

export const CHAT_SEND_AGENT_LIMIT = 60;
export const CHAT_SEND_RECIPIENT_LIMIT = 20;
export const CHAT_SEND_WINDOW_SECONDS = 60 * 60;

export interface ChatSendCaller {
  memberId: string;
  access: AccessContext;
  principalId: string | null;
  scopes: string[];
}

export interface ChatSendResult {
  id: string;
  status: 'sent';
  connection_id: string;
  provider: string;
  conversation_id: string;
  external_message_id: string | null;
  direct: boolean;
  to: { person_id: string | null; channel_id: string | null; channel_name: string | null };
}

const missingColumn = (error: { code?: string } | null | undefined) => !!error && (error.code === '42703' || error.code === 'PGRST204');

const databasePending = () => new ApiError(503, 'SERVICE_UNAVAILABLE', 'Starting chat conversations works once the database update 20261125001500_chat_outbound_media.sql is applied', {
  reason: 'database_update_pending', migration: '20261125001500_chat_outbound_media.sql',
});

const notAllowed = (message: string, reason: string, hint?: string) => forbidden(message, { reason, ...(hint ? { hint } : {}) });

/** An https image the provider can fetch, or null. */
const iconUrl = (avatar: unknown): string | null => (typeof avatar === 'string' && /^https:\/\/\S+$/.test(avatar) && avatar.length <= 2000 ? avatar : null);

/** The stored text: the words, and the link as plain text, so the record says what was sent. */
const recordedText = (input: ChatSendInput) => (input.link ? `${input.text}\n${input.link.label}: ${input.link.url}` : input.text).slice(0, 40000);

/** Enabled connections of one kind, narrowed by connection_id or provider. */
async function connectionsOfKind(service: SupabaseClient, kind: ChatConnectionKind, input: ChatSendInput): Promise<Row[]> {
  let query = service.from('chat_connections').select(CONNECTION_COLUMNS).eq('enabled', true);
  if (input.connection_id) query = query.eq('id', input.connection_id);
  if (input.provider) query = query.eq('provider', input.provider);
  const { data, error } = await query.order('created_at');
  if (missingColumn(error) || missingAssistantSchema(error)) throw databasePending();
  if (error) throw error;
  return ((data ?? []) as Row[]).filter((row) => connectionKind(row) === kind && chatAdapter(row.provider));
}

/** The member's verified linked account a connection knows them by, or null. */
async function identityOn(service: SupabaseClient, connection: Row, adapter: ChatAdapter, memberId: string): Promise<Row | null> {
  let query = service.from('member_identities').select('id, external_id, workspace_id')
    .eq('member_id', memberId).eq('provider', adapter.identityProvider).not('verified_at', 'is', null);
  const workspace = adapter.hasWorkspaces ? connection.external_workspace_id ?? null : null;
  query = workspace === null ? query.is('workspace_id', null) : query.eq('workspace_id', workspace);
  const { data, error } = await query.limit(1);
  if (error) throw error;
  return ((data ?? []) as Row[])[0] ?? null;
}

const chooseConnection = (options: Row[]) => new ApiError(409, 'CONFLICT', 'More than one chat connection fits: send connection_id or provider', {
  reason: 'choose_connection',
  options: options.map((row) => ({ connection_id: row.id, provider: row.provider, display_name: row.display_name })),
});

type Target = { connection: Row; adapter: ChatAdapter; personId: string | null; identity: Row | null; channel: Row | null };

/** A personal assistant: its own person only, on a personal connection where they linked an account. */
async function personalTarget(service: SupabaseClient, me: Row, input: ChatSendInput): Promise<Target> {
  if (input.channel) {
    throw notAllowed('A personal assistant messages only its own person, by DM: never a channel', 'recipient_not_allowed');
  }
  if (input.person_id && input.person_id !== me.delegate_of) {
    throw notAllowed('A personal assistant messages only its own person', 'recipient_not_allowed', 'Leave out person_id: it defaults to your person.');
  }
  if (!(await readAssistantSettings(service)).enabled) {
    throw new ApiError(409, 'CONFLICT', 'Assistants are switched off in this workspace', { reason: 'assistants_off' });
  }
  const candidates: Target[] = [];
  for (const connection of await connectionsOfKind(service, 'personal', input)) {
    const adapter = chatAdapter(connection.provider)!;
    const identity = await identityOn(service, connection, adapter, me.delegate_of);
    if (identity) candidates.push({ connection, adapter, personId: me.delegate_of, identity, channel: null });
  }
  if (candidates.length === 0) {
    throw new ApiError(409, 'CONFLICT', 'Your person has not linked a chat account on a personal chat connection yet', {
      reason: 'no_linked_chat', hint: 'They link one from their Assistant page by messaging the bot.',
    });
  }
  if (candidates.length > 1) throw chooseConnection(candidates.map((candidate) => candidate.connection));
  return candidates[0];
}

/** A company agent: a channel mapped to it, or a member it may DM, on a company connection that lists it. */
async function companyTarget(service: SupabaseClient, caller: ChatSendCaller, input: ChatSendInput): Promise<Target> {
  if (!input.channel && !input.person_id) throw new ApiError(422, 'VALIDATION_ERROR', 'Send channel (one mapped to you) or person_id (a member to DM)', { reason: 'recipient_required' });
  const all = await connectionsOfKind(service, 'company', input);
  const { data: links, error } = all.length
    ? await service.from('chat_connection_agents').select('connection_id').eq('agent_id', caller.memberId).in('connection_id', all.map((row) => row.id))
    : { data: [], error: null };
  if (error) throw error;
  const mine = new Set(((links ?? []) as Row[]).map((link) => link.connection_id as string));
  const connections = all.filter((row) => mine.has(row.id));
  if (connections.length === 0) {
    throw notAllowed('No company chat connection lists you: an Owner adds you on the connection first', 'not_on_connection');
  }

  if (input.channel) {
    const wanted = input.channel.trim();
    const name = `#${wanted.replace(/^[#@]/, '')}`.toLowerCase();
    const { data: routes, error: routeError } = await service.from('chat_channel_routes').select('connection_id, channel_id, channel_name, agent_id')
      .in('connection_id', connections.map((row) => row.id)).eq('agent_id', caller.memberId);
    if (routeError) throw routeError;
    const matches = ((routes ?? []) as Row[]).filter((route) => route.channel_id === wanted
      || (typeof route.channel_name === 'string' && [name, `@${wanted.replace(/^[#@]/, '')}`.toLowerCase()].includes(route.channel_name.toLowerCase())));
    if (matches.length === 0) {
      throw notAllowed('You post only to a channel mapped to you on a company connection', 'channel_not_allowed',
        'An Owner maps the channel to you under Settings > Assistants > Chat. Being the default agent does not let you post in other channels.');
    }
    if (new Set(matches.map((route) => route.connection_id)).size > 1) {
      throw chooseConnection(connections.filter((row) => matches.some((route) => route.connection_id === row.id)));
    }
    const connection = connections.find((row) => row.id === matches[0].connection_id)!;
    return { connection, adapter: chatAdapter(connection.provider)!, personId: null, identity: null, channel: matches[0] };
  }

  const personId = input.person_id!;
  if (caller.principalId && caller.principalId !== personId) {
    throw notAllowed('X-Act-For names someone other than the person you are messaging', 'act_for_mismatch');
  }
  // A DM to someone who did not just write to you needs chat.notify, acting for them or not.
  if (!apiKeyAllows(caller.access, caller.scopes, 'chat.notify') && !(await memberWroteLately(service, caller.memberId, personId))) {
    throw notAllowed(`Message a person in chat only when they wrote to you in the last ${ACT_FOR_PROOF_MINUTES} minutes, or hold chat.notify to message them unasked`, 'chat_notify_required',
      'Reply to their message (POST /api/v1/chat/messages/{id}/reply) while it is fresh. For unprompted alerts an Owner grants chat.notify to you and to this key.');
  }
  const { data: person, error: personError } = await service.from('team_members').select('id, role, status').eq('id', personId).maybeSingle();
  if (personError) throw personError;
  const active = person && (person as Row).role !== 'agent' && (person as Row).status !== 'suspended';
  if (!active) throw notFound('Person');
  const candidates: Target[] = [];
  for (const connection of connections) {
    const adapter = chatAdapter(connection.provider)!;
    const identity = await identityOn(service, connection, adapter, personId);
    if (identity) candidates.push({ connection, adapter, personId, identity, channel: null });
  }
  if (candidates.length === 0) {
    throw new ApiError(409, 'CONFLICT', 'That person has not linked a chat account on a company connection that lists you', { reason: 'no_linked_chat' });
  }
  if (candidates.length > 1) throw chooseConnection(candidates.map((candidate) => candidate.connection));
  return candidates[0];
}

/** One message against an hourly window; the same table and function as inbound limits. */
async function allowed(service: SupabaseClient, connectionId: string, subject: string, limit: number): Promise<{ allowed: boolean; reset_at: string | null }> {
  const { data, error } = await service.rpc('consume_chat_rate_limit', {
    p_connection_id: connectionId, p_subject: subject, p_limit: limit, p_window_seconds: CHAT_SEND_WINDOW_SECONDS,
  });
  if (error) throw error;
  const window = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; reset_at?: string } | null;
  return { allowed: window?.allowed === true, reset_at: window?.reset_at ?? null };
}

/** The DM with a person: the one they last wrote the bot from, else the provider opens it. */
async function directConversation(service: SupabaseClient, target: Target): Promise<string> {
  const externalId = target.identity!.external_id as string;
  let query = service.from('chat_messages').select('conversation_id')
    .eq('connection_id', target.connection.id).eq('direction', 'inbound').eq('external_user_id', externalId);
  if (connectionKind(target.connection) === 'company') query = query.eq('is_direct', true);
  const { data } = await query.order('created_at', { ascending: false }).limit(1);
  const known = ((data ?? []) as Row[])[0]?.conversation_id;
  if (typeof known === 'string' && known) return known;
  return target.adapter.openDirect(openCredentials(target.connection as { id: string; credentials: string }), externalId);
}

export async function sendChatMessage(service: SupabaseClient, caller: ChatSendCaller, input: ChatSendInput): Promise<ChatSendResult> {
  if (caller.access.role !== 'agent') throw forbidden('Only an agent starts a chat conversation', { reason: 'not_an_agent' });
  const { data: meRow, error: meError } = await service.from('team_members').select('id, name, avatar, delegate_of').eq('id', caller.memberId).maybeSingle();
  if (meError) throw meError;
  const me = meRow as Row | null;
  if (!me) throw forbidden('Only an agent starts a chat conversation', { reason: 'not_an_agent' });
  // Before anything is sent: a started message must be recordable as one.
  const { error: columnError } = await service.from('chat_messages').select('initiated').limit(1);
  if (missingColumn(columnError) || missingAssistantSchema(columnError)) throw databasePending();
  if (columnError) throw columnError;

  const target = me.delegate_of ? await personalTarget(service, me, input) : await companyTarget(service, caller, input);
  const { connection, adapter } = target;
  const direct = !target.channel;
  const recipient = target.channel ? `channel:${target.channel.channel_id}` : `member:${target.personId}`;

  for (const [subject, limit, which] of [
    [`out:agent:${caller.memberId}`, CHAT_SEND_AGENT_LIMIT, 'agent'],
    [`out:to:${recipient}`, CHAT_SEND_RECIPIENT_LIMIT, 'recipient'],
  ] as const) {
    const window = await allowed(service, connection.id, subject, limit);
    if (!window.allowed) {
      throw new ApiError(429, 'RATE_LIMIT_EXCEEDED', which === 'agent'
        ? `You started ${limit} chat messages on this connection in the last hour. Try again later.`
        : `This ${target.channel ? 'channel' : 'person'} got ${limit} started messages in the last hour. Try again later.`, {
        reason: 'chat_rate_limited', limit: which, per_hour: limit, reset_at: window.reset_at,
      });
    }
  }

  const credentials = openCredentials(connection as { id: string; credentials: string });
  const as = { username: String(me.name ?? 'Agent'), iconUrl: iconUrl(me.avatar) };
  let conversationId: string = target.channel?.channel_id ?? '';
  let externalId: string | null = null;
  let failure: ChatProviderError | null = null;
  try {
    if (direct) conversationId = await directConversation(service, target);
    const sent = await adapter.send(credentials, {
      conversationId, threadId: null, text: input.text, as, direct, link: input.link ?? null,
    });
    externalId = sent.externalMessageId;
    // Discord made or dropped a channel webhook: kept sealed for the next send.
    if (sent.credentials) await storeCredentials(service, connection.id, credentials, sent.credentials);
  } catch (error) {
    if (!(error instanceof ChatProviderError)) throw error;
    failure = error;
  }

  const { data, error } = await service.from('chat_messages').insert({
    connection_id: connection.id, direction: 'outbound', status: failure ? 'failed' : 'sent', initiated: true,
    conversation_id: conversationId || (target.identity?.external_id ?? 'unknown'), thread_id: null, external_message_id: externalId,
    member_id: target.personId, agent_id: caller.memberId, is_direct: direct, text: recordedText(input),
    error: failure ? failure.message.slice(0, 500) : null,
  }).select('id').single();
  if (missingColumn(error)) throw databasePending();
  if (error) throw error;
  if (failure) {
    throw new ApiError(502, 'BAD_GATEWAY', failure.message, { reason: 'provider_refused', provider: failure.provider, code: failure.code });
  }
  return {
    id: (data as Row).id,
    status: 'sent',
    connection_id: connection.id,
    provider: connection.provider,
    conversation_id: conversationId,
    external_message_id: externalId,
    direct,
    to: { person_id: target.personId, channel_id: target.channel?.channel_id ?? null, channel_name: target.channel?.channel_name ?? null },
  };
}

/** Why a system chat notice did not go out: the person has no chat to reach, or got too many this hour. */
export type SystemChatSkip = 'no_linked_chat' | 'rate_limited';

/**
 * Sends a person a notice from the app itself, not from an agent: the
 * notification delivery point (lib/notification-delivery) uses it for chat.
 * It reaches only the person's own verified linked account, by DM, on an
 * enabled connection: the one they last wrote to first, else a company
 * connection, else their own assistant's. It counts against the same
 * per-recipient hourly limit agents' messages do, so the app and agents
 * together never flood a person. sendChatMessage stays agents only; this is
 * the one other way out, and it takes no recipient from a caller: the
 * delivery queue names the person, who asked for chat in their settings.
 */
export async function sendSystemChatNotice(
  service: SupabaseClient,
  personId: string,
  input: { text: string; link: { url: string; label: string } | null; as: { username: string; iconUrl: string | null } },
): Promise<{ status: 'sent'; id: string } | { status: 'skipped'; reason: SystemChatSkip }> {
  const { data: connections, error } = await service.from('chat_connections').select(CONNECTION_COLUMNS).eq('enabled', true).order('created_at');
  if (missingColumn(error) || missingAssistantSchema(error)) throw databasePending();
  if (error) throw error;
  const candidates: (Target & { known: boolean })[] = [];
  for (const connection of (connections ?? []) as Row[]) {
    const adapter = chatAdapter(connection.provider);
    if (!adapter) continue;
    const identity = await identityOn(service, connection, adapter, personId);
    if (!identity) continue;
    const { data: wrote } = await service.from('chat_messages').select('id')
      .eq('connection_id', connection.id).eq('direction', 'inbound').eq('external_user_id', identity.external_id).limit(1);
    candidates.push({ connection, adapter, personId, identity, channel: null, known: ((wrote ?? []) as Row[]).length > 0 });
  }
  if (candidates.length === 0) return { status: 'skipped', reason: 'no_linked_chat' };
  // Where they already talk to a bot first; a company bot before an assistant's.
  candidates.sort((a, b) => Number(b.known) - Number(a.known)
    || Number(connectionKind(a.connection) === 'personal') - Number(connectionKind(b.connection) === 'personal'));
  const target = candidates[0];
  const window = await allowed(service, target.connection.id, `out:to:member:${personId}`, CHAT_SEND_RECIPIENT_LIMIT);
  if (!window.allowed) return { status: 'skipped', reason: 'rate_limited' };

  const credentials = openCredentials(target.connection as { id: string; credentials: string });
  let conversationId = '';
  let externalId: string | null = null;
  let failure: ChatProviderError | null = null;
  try {
    conversationId = await directConversation(service, target);
    const sent = await target.adapter.send(credentials, {
      conversationId, threadId: null, text: input.text, as: input.as, direct: true, link: input.link,
    });
    externalId = sent.externalMessageId;
    if (sent.credentials) await storeCredentials(service, target.connection.id, credentials, sent.credentials);
  } catch (sendError) {
    if (!(sendError instanceof ChatProviderError)) throw sendError;
    failure = sendError;
  }
  const { data, error: insertError } = await service.from('chat_messages').insert({
    connection_id: target.connection.id, direction: 'outbound', status: failure ? 'failed' : 'sent', initiated: true,
    conversation_id: conversationId || String(target.identity!.external_id), thread_id: null, external_message_id: externalId,
    member_id: personId, agent_id: null, is_direct: true, text: recordedText({ text: input.text, link: input.link ?? undefined } as ChatSendInput),
    error: failure ? failure.message.slice(0, 500) : null,
  }).select('id').single();
  if (missingColumn(insertError)) throw databasePending();
  if (insertError) throw insertError;
  if (failure) throw failure;
  return { status: 'sent', id: (data as Row).id };
}
