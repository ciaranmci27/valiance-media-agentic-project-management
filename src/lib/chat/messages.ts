import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { assistantPending, missingAssistantSchema } from '@/lib/api/assistant';
import { connectionKind, loadConnection, openCredentials, storeCredentials } from './connections';
import { chatAdapter, ChatProviderError } from './providers';
import { CHAT_ATTACHMENT_KINDS, type AssistantChatMessage, type ChatActFor, type ChatAttachmentView, type ChatChannelInfo, type ChatConnectionKind, type ChatReplyInput } from './types';

/**
 * What an agent does with chat: reads the messages routed to it (the poll,
 * when it has no webhook), replies through the provider's adapter, or marks
 * one handled. Only the agent a message was routed to reaches it; anyone
 * else reads it as missing. Chat is private, like a personal inbox: the
 * webhooks carry ids only, and the text is read here with the agent's own
 * key.
 *
 * - A personal message (the personal bot) goes to its person's own
 *   assistant, which already acts for them: no act-for token.
 * - A company message (the company bot) goes to a company agent. A request
 *   from a linked person is answered for that person: the reply needs
 *   X-Act-For naming them (mint it with the message's act_for body), so
 *   what the agent does and says for them is never more than both may.
 *   Context (is_request false) is never answered.
 *
 * The /api/v1/chat routes take both; the deprecated /api/v1/assistant ones
 * take a personal assistant only, as before. Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_COLUMNS = 'id, connection_id, direction, status, conversation_id, thread_id, external_message_id, external_user_id, member_id, identity_id, agent_id, text, created_at';
const COMPANY_COLUMNS = `${LEGACY_COLUMNS}, is_request, is_direct, route`;
const MESSAGE_COLUMNS = `${COMPANY_COLUMNS}, attachments, reply_to_id`;
/** Earlier messages in the conversation the webhook and the poll carry. */
export const THREAD_CONTEXT = 10;

/** Who may call: any agent on /api/v1/chat, a personal assistant only on the deprecated /api/v1/assistant routes. */
export type ChatCaller = { memberId: string; access: AccessContext; principalId?: string | null; personalOnly?: boolean };

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingAssistantSchema(error)) throw assistantPending();
  throw error;
}

const missingColumn = (error: { code?: string } | null | undefined) => !!error && (error.code === '42703' || error.code === 'PGRST204');

/**
 * Reads chat_messages with the file and company columns, or without them on
 * a database before 20261125001500 (no files) or 20261125001100 (every
 * message then reads as a request).
 */
async function selectMessages(build: (columns: string) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>): Promise<Row[]> {
  let { data, error } = await build(MESSAGE_COLUMNS);
  if (missingColumn(error)) ({ data, error } = await build(COMPANY_COLUMNS));
  if (missingColumn(error)) ({ data, error } = await build(LEGACY_COLUMNS));
  if (error) fail(error);
  if (data === null || data === undefined) return [];
  return Array.isArray(data) ? data as Row[] : [data as Row];
}

async function connectionsOf(service: SupabaseClient, ids: string[]): Promise<Map<string, { provider: string; kind: ChatConnectionKind }>> {
  if (ids.length === 0) return new Map();
  let { data, error }: { data: unknown; error: { code?: string } | null } = await service.from('chat_connections').select('id, provider, kind').in('id', ids);
  if (missingColumn(error)) ({ data, error } = await service.from('chat_connections').select('id, provider').in('id', ids));
  return new Map(((error ? [] : data ?? []) as Row[]).map((row) => [row.id as string, { provider: row.provider as string, kind: connectionKind(row) }]));
}

async function peopleOf(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await service.from('team_members').select('id, name').in('id', ids);
  return new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row.name as string]));
}

/** The channel mappings for these messages' conversations (company connections only). */
async function channelsOf(service: SupabaseClient, rows: Row[], connections: Map<string, { kind: ChatConnectionKind }>): Promise<Map<string, Row>> {
  const company = rows.filter((row) => connections.get(row.connection_id)?.kind === 'company');
  if (company.length === 0) return new Map();
  const { data, error } = await service.from('chat_channel_routes').select('connection_id, channel_id, channel_name, agent_id, listen')
    .in('connection_id', [...new Set(company.map((row) => row.connection_id as string))])
    .in('channel_id', [...new Set(company.map((row) => row.conversation_id as string))]);
  if (error) return new Map();
  return new Map(((data ?? []) as Row[]).map((route) => [`${route.connection_id}\n${route.channel_id}`, route]));
}

async function identitiesOf(service: SupabaseClient, ids: string[]): Promise<Map<string, Row>> {
  if (ids.length === 0) return new Map();
  const { data } = await service.from('member_identities').select('id, provider, external_id, workspace_id').in('id', ids);
  return new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row]));
}

interface Lookups {
  connections: Map<string, { provider: string; kind: ChatConnectionKind }>;
  people: Map<string, string>;
  channels: Map<string, Row>;
  identities: Map<string, Row>;
}

async function lookups(service: SupabaseClient, rows: Row[]): Promise<Lookups> {
  const connections = await connectionsOf(service, [...new Set(rows.map((row) => row.connection_id as string))]);
  const actFor = rows.filter((row) => connections.get(row.connection_id)?.kind === 'company' && row.identity_id && row.member_id && row.is_request !== false);
  const [people, channels, identities] = await Promise.all([
    peopleOf(service, [...new Set(rows.map((row) => row.member_id).filter(Boolean) as string[])]),
    channelsOf(service, rows, connections),
    identitiesOf(service, [...new Set(actFor.map((row) => row.identity_id as string))]),
  ]);
  return { connections, people, channels, identities };
}

function channelInfo(row: Row, kind: ChatConnectionKind, channels: Map<string, Row>): ChatChannelInfo {
  const route = channels.get(`${row.connection_id}\n${row.conversation_id}`);
  return {
    id: row.conversation_id,
    name: route?.channel_name ?? null,
    // The personal bot only ever hears DMs.
    direct: kind === 'personal' ? true : typeof row.is_direct === 'boolean' ? row.is_direct : null,
    mapped_agent_id: route?.agent_id ?? null,
    listen: route ? (route.listen === 'all' ? 'all' : 'mentions') : null,
  };
}

function actForOf(row: Row, kind: ChatConnectionKind, identities: Map<string, Row>): ChatActFor | null {
  if (kind !== 'company' || row.is_request === false || !row.member_id || !row.identity_id) return null;
  const identity = identities.get(row.identity_id);
  if (!identity) return null;
  return { method: 'POST', path: '/api/v1/delegations', body: { provider: identity.provider, external_id: identity.external_id, workspace_id: identity.workspace_id ?? null } };
}

/** The stored files of a message, as the agent reads them: never the provider's file id or address. */
export function attachmentViews(row: Row): ChatAttachmentView[] {
  const stored = Array.isArray(row.attachments) ? row.attachments as Row[] : [];
  return stored.map((item, index) => ({
    index,
    kind: (CHAT_ATTACHMENT_KINDS as readonly string[]).includes(item?.kind) ? item.kind : 'document',
    name: typeof item?.name === 'string' ? item.name : null,
    mime_type: typeof item?.mime_type === 'string' ? item.mime_type : null,
    size: typeof item?.size === 'number' ? item.size : null,
    duration_seconds: typeof item?.duration_seconds === 'number' ? item.duration_seconds : null,
    download: { method: 'GET', path: `/api/v1/chat/messages/${row.id}/attachments/${index}` },
  }));
}

function present(row: Row, found: Lookups): AssistantChatMessage {
  const connection = found.connections.get(row.connection_id);
  const kind = connection?.kind ?? 'personal';
  return {
    id: row.id,
    status: row.status,
    text: row.text,
    created_at: row.created_at,
    provider: connection?.provider ?? 'unknown',
    connection_id: row.connection_id,
    connection_kind: kind,
    conversation_id: row.conversation_id,
    thread_id: row.thread_id ?? null,
    external_message_id: row.external_message_id ?? null,
    external_user_id: row.external_user_id ?? null,
    person: row.member_id ? { id: row.member_id, name: found.people.get(row.member_id) ?? '' } : null,
    agent_id: row.agent_id ?? null,
    is_request: row.is_request !== false,
    route: row.route ?? null,
    channel: channelInfo(row, kind, found.channels),
    act_for: actForOf(row, kind, found.identities),
    attachments: attachmentViews(row),
    // On an inbound message, reply_to_id names the started message it answers.
    in_reply_to: row.direction === 'inbound' ? row.reply_to_id ?? null : null,
  };
}

type ThreadItem = { id: string; direction: string; text: string; created_at: string; is_request?: boolean };

/**
 * The conversation before a message, oldest first, for context. A personal
 * message: this person's messages and the answers to them. A company one:
 * what was recorded for the same agent in that conversation and thread
 * (requests and context) and the agent's answers.
 */
async function threadBefore(service: SupabaseClient, message: Row, kind: ChatConnectionKind): Promise<ThreadItem[]> {
  const rows = await selectMessages((columns) => {
    let query = service.from('chat_messages').select(columns)
      .eq('connection_id', message.connection_id).eq('conversation_id', message.conversation_id).lt('created_at', message.created_at);
    query = message.thread_id ? query.eq('thread_id', message.thread_id) : query.is('thread_id', null);
    return query.order('created_at', { ascending: false }).limit(THREAD_CONTEXT * (kind === 'company' ? 3 : 2));
  });
  const keep = kind === 'company'
    ? (row: Row) => row.agent_id === message.agent_id
    : (row: Row) => row.direction === 'outbound' || row.member_id === message.member_id;
  return rows.filter(keep).slice(0, THREAD_CONTEXT).reverse()
    .map((row) => ({ id: row.id, direction: row.direction, text: row.text, created_at: row.created_at, ...(kind === 'company' ? { is_request: row.is_request !== false } : {}) }));
}

/**
 * The assistant.message webhook's data, exactly as before (deprecated: use
 * chat.message): ids only, never chat text. The message's id and where it
 * came from, its person, the agent, the ids of the thread so far, and where
 * to read and answer it.
 */
export async function assistantMessagePayload(service: SupabaseClient, messageId: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.from('chat_messages').select(LEGACY_COLUMNS).eq('id', messageId).single();
  if (error) throw error;
  const row = data as Row;
  const [connections, people, thread] = await Promise.all([
    connectionsOf(service, [row.connection_id]), peopleOf(service, row.member_id ? [row.member_id] : []), threadBefore(service, row, 'personal'),
  ]);
  return {
    message: {
      id: row.id,
      created_at: row.created_at,
      provider: connections.get(row.connection_id)?.provider ?? 'unknown',
      connection_id: row.connection_id,
      conversation_id: row.conversation_id,
      thread_id: row.thread_id ?? null,
    },
    person: row.member_id ? { id: row.member_id, name: people.get(row.member_id) ?? '' } : null,
    agent_id: row.agent_id,
    thread_ids: thread.map((item) => item.id),
    read: { method: 'GET', path: `/api/v1/assistant/messages/${row.id}` },
    reply: { method: 'POST', path: `/api/v1/assistant/messages/${row.id}/reply` },
  };
}

/**
 * The chat.message webhook's data, for personal and company messages alike:
 * ids only, never chat text. Which connection (and its kind), the channel
 * (DM or not, its mapping and listen mode), the thread, whether it is a
 * request or context, the agent and the sender, the body to mint an act-for
 * pass for a company request, and where to read and answer it (no reply for
 * context).
 */
export async function chatMessagePayload(service: SupabaseClient, messageId: string): Promise<Record<string, unknown>> {
  const [row] = await selectMessages((columns) => service.from('chat_messages').select(columns).eq('id', messageId).single());
  const found = await lookups(service, [row]);
  const message = present(row, found);
  const thread = await threadBefore(service, row, message.connection_kind);
  return {
    message: {
      id: row.id,
      created_at: row.created_at,
      provider: message.provider,
      connection_id: row.connection_id,
      connection_kind: message.connection_kind,
      conversation_id: row.conversation_id,
      thread_id: row.thread_id ?? null,
      external_message_id: row.external_message_id ?? null,
      external_user_id: row.external_user_id ?? null,
    },
    agent_id: row.agent_id,
    connection_kind: message.connection_kind,
    is_request: message.is_request,
    route: message.route,
    channel: message.channel,
    has_attachments: message.attachments.length > 0,
    attachment_count: message.attachments.length,
    in_reply_to: message.in_reply_to,
    thread: { id: row.thread_id ?? null, message_ids: thread.map((item) => item.id) },
    person: message.person,
    act_for: message.act_for,
    read: { method: 'GET', path: `/api/v1/chat/messages/${row.id}` },
    reply: message.is_request ? { method: 'POST', path: `/api/v1/chat/messages/${row.id}/reply` } : null,
  };
}

/** The caller must be an agent; on the deprecated routes, a personal one. */
export async function requireCaller(service: SupabaseClient, caller: ChatCaller) {
  const refuse = () => forbidden('Only a person\'s own assistant reads and answers its chat here. Company agents use /api/v1/chat/messages.', { reason: 'not_a_personal_agent' });
  if (caller.access.role !== 'agent') {
    if (caller.personalOnly) throw refuse();
    throw forbidden('Only an agent reads and answers chat', { reason: 'not_an_agent' });
  }
  if (!caller.personalOnly) return;
  if (!caller.access.principal_id) throw refuse();
  const { data } = await service.from('team_members').select('delegate_of').eq('id', caller.memberId).maybeSingle();
  if (!(data as Row | null)?.delegate_of) throw refuse();
}

/**
 * Messages routed to this agent, oldest first: pending (the default:
 * waiting, nothing was sent to a webhook), notified, replied, handled,
 * unrouted, context, or all. Each with the thread so far.
 */
export async function listAssistantMessages(
  service: SupabaseClient,
  caller: ChatCaller,
  filters: { status: string; limit: number },
): Promise<{ messages: (AssistantChatMessage & { thread: ThreadItem[] })[] }> {
  await requireCaller(service, caller);
  const rows = await selectMessages((columns) => {
    let query = service.from('chat_messages').select(columns).eq('agent_id', caller.memberId).eq('direction', 'inbound');
    if (filters.status !== 'all') query = query.eq('status', filters.status);
    return query.order('created_at').order('id').limit(filters.limit);
  });
  if (rows.length === 0) return { messages: [] };
  const found = await lookups(service, rows);
  const presented = rows.map((row) => present(row, found));
  const threads = await Promise.all(rows.map((row, index) => threadBefore(service, row, presented[index].connection_kind)));
  return { messages: presented.map((message, index) => ({ ...message, thread: threads[index] })) };
}

/** One message routed to this agent, with its text and the thread so far. Anyone else's reads as missing. */
export async function getAssistantMessage(
  service: SupabaseClient,
  caller: ChatCaller,
  messageId: string,
): Promise<AssistantChatMessage & { thread: ThreadItem[] }> {
  await requireCaller(service, caller);
  const row = await loadOwn(service, caller.memberId, messageId);
  const found = await lookups(service, [row]);
  const message = present(row, found);
  return { ...message, thread: await threadBefore(service, row, message.connection_kind) };
}

export async function loadOwn(service: SupabaseClient, agentId: string, messageId: string): Promise<Row> {
  if (!UUID.test(messageId)) throw notFound('Chat message');
  const [row] = await selectMessages((columns) => service.from('chat_messages').select(columns).eq('id', messageId).maybeSingle());
  if (!row || row.direction !== 'inbound' || row.agent_id !== agentId) throw notFound('Chat message');
  return row;
}

const notARequest = () => new ApiError(409, 'CONFLICT', 'This message is context from a channel you listen to, not a request: it is never answered', { reason: 'not_a_request' });

/** An https image the provider can fetch, or null. */
const iconUrl = (avatar: unknown): string | null => (typeof avatar === 'string' && /^https:\/\/\S+$/.test(avatar) && avatar.length <= 2000 ? avatar : null);

/**
 * Replies to a message through the provider, under the agent's own name and
 * avatar where the provider allows (Slack). Where it goes:
 * - private: to the sender by DM (Slack opens it; Telegram's is the user).
 * - otherwise where it was said: in its thread unless in_thread is false; a
 *   company answer to a top-level channel message starts a thread on it,
 *   and also_send_to_channel shows it in the channel too (Slack).
 * A company request from a person needs X-Act-For naming them. The reply is
 * recorded either way; a provider refusal answers 502 with its reason.
 */
export async function replyToMessage(
  service: SupabaseClient,
  caller: ChatCaller,
  messageId: string,
  input: ChatReplyInput,
): Promise<{ id: string; status: 'sent'; external_message_id: string | null; reply_to: string; conversation_id: string; private: boolean }> {
  await requireCaller(service, caller);
  const message = await loadOwn(service, caller.memberId, messageId);
  if (message.is_request === false) throw notARequest();
  const connection = await loadConnection(service, message.connection_id);
  if (!connection || connection.enabled === false) throw new ApiError(409, 'CONFLICT', 'This chat connection is switched off or was removed', { reason: 'connection_off' });
  const kind = connectionKind(connection);
  if (kind === 'company' && message.member_id) {
    if (!caller.principalId) {
      throw forbidden('Answer a company chat request for the person who wrote it: send X-Act-For with a pass minted for them', {
        reason: 'act_for_required',
        hint: 'POST /api/v1/delegations with the message\'s act_for body, then send its token as X-Act-For with this same key.',
      });
    }
    if (caller.principalId !== message.member_id) {
      throw forbidden('X-Act-For names someone other than the person who wrote this message', { reason: 'act_for_mismatch' });
    }
  }
  const adapter = chatAdapter(connection.provider);
  if (!adapter) throw new ApiError(501, 'NOT_IMPLEMENTED', `${connection.provider} has no adapter yet`, { reason: 'no_adapter' });
  const credentials = openCredentials(connection as { id: string; credentials: string });
  const direct = kind === 'personal' || message.is_direct === true;
  const goesPrivate = input.private === true && !direct;
  if (goesPrivate && !message.external_user_id) throw new ApiError(409, 'CONFLICT', 'This message has no sender to answer privately', { reason: 'no_sender' });
  const { data: me } = await service.from('team_members').select('name, avatar').eq('id', caller.memberId).maybeSingle();
  const as = me ? { username: String((me as Row).name ?? 'Agent'), iconUrl: iconUrl((me as Row).avatar) } : null;

  let conversationId = message.conversation_id as string;
  let threadId: string | null = input.in_thread === false ? null : message.thread_id ?? null;
  let replyTo: string | null = null;
  let externalId: string | null = null;
  let failure: ChatProviderError | null = null;
  try {
    if (goesPrivate) {
      conversationId = await adapter.openDirect(credentials, message.external_user_id);
      threadId = null;
    } else if (!direct && input.in_thread !== false && !threadId) {
      // A channel answer starts a thread on the message it answers.
      replyTo = message.external_message_id ?? null;
    }
    const sent = await adapter.send(credentials, {
      conversationId, threadId, replyTo, text: input.text, as,
      broadcast: !goesPrivate && !direct && input.also_send_to_channel === true,
      direct: direct || goesPrivate,
      replyToUser: replyTo ? message.external_user_id ?? null : null,
    });
    externalId = sent.externalMessageId;
    // Discord made or dropped a channel webhook: kept sealed for the next reply.
    if (sent.credentials) await storeCredentials(service, connection.id, sent.credentials);
  } catch (error) {
    if (!(error instanceof ChatProviderError)) throw error;
    failure = error;
  }
  const { data, error } = await service.from('chat_messages').insert({
    connection_id: message.connection_id, direction: 'outbound', status: failure ? 'failed' : 'sent',
    conversation_id: conversationId, thread_id: threadId ?? replyTo, external_message_id: externalId,
    member_id: message.member_id, agent_id: caller.memberId, reply_to_id: message.id, text: input.text, error: failure ? failure.message.slice(0, 500) : null,
  }).select('id').single();
  if (error) fail(error);
  if (failure) {
    throw new ApiError(502, 'BAD_GATEWAY', failure.message, { reason: 'provider_refused', provider: failure.provider, code: failure.code });
  }
  await service.from('chat_messages').update({ status: 'replied', handled_at: new Date().toISOString() }).eq('id', message.id);
  return { id: (data as Row).id, status: 'sent', external_message_id: externalId, reply_to: message.id, conversation_id: conversationId, private: goesPrivate };
}

/** Marks a message handled without a reply, so the poll stops listing it. Context is never a request, so never handled. */
export async function markMessageHandled(service: SupabaseClient, caller: ChatCaller, messageId: string): Promise<{ id: string; status: string }> {
  await requireCaller(service, caller);
  const message = await loadOwn(service, caller.memberId, messageId);
  if (message.is_request === false) throw notARequest();
  if (message.status === 'replied' || message.status === 'handled') return { id: message.id, status: message.status };
  const { error } = await service.from('chat_messages').update({ status: 'handled', handled_at: new Date().toISOString() }).eq('id', message.id);
  if (error) fail(error);
  return { id: message.id, status: 'handled' };
}
