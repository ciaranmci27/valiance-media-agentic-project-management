import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessContext } from '@/lib/access-control';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { assistantPending, missingAssistantSchema } from '@/lib/api/assistant';
import { loadConnection, openCredentials } from './connections';
import { chatAdapter, ChatProviderError } from './providers';
import type { AssistantChatMessage, ChatReplyInput } from './types';

/**
 * What a person's assistant does with chat: reads the messages waiting for
 * it (the poll, when it has no webhook), replies in the conversation they
 * came from through the provider's adapter, or marks one handled. Only the
 * assistant a message was routed to reaches it; anyone else reads it as
 * missing. Chat is private, like a personal inbox: the webhook carries ids
 * only, and the text is read here with the assistant's own key. No act-for
 * token is minted: a personal agent is already narrowed to its person.
 * Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MESSAGE_COLUMNS = 'id, connection_id, direction, status, conversation_id, thread_id, external_message_id, external_user_id, member_id, identity_id, agent_id, text, created_at';
/** Earlier messages in the conversation the webhook and the poll carry. */
export const THREAD_CONTEXT = 10;

function fail(error: { code?: string; message?: string } | null | undefined): never {
  if (missingAssistantSchema(error)) throw assistantPending();
  throw error;
}

async function providersOf(service: SupabaseClient, connectionIds: string[]): Promise<Map<string, string>> {
  if (connectionIds.length === 0) return new Map();
  const { data } = await service.from('chat_connections').select('id, provider').in('id', connectionIds);
  return new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row.provider as string]));
}

async function peopleOf(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data } = await service.from('team_members').select('id, name').in('id', ids);
  return new Map(((data ?? []) as Row[]).map((row) => [row.id as string, row.name as string]));
}

function present(row: Row, providers: Map<string, string>, people: Map<string, string>): AssistantChatMessage {
  return {
    id: row.id,
    status: row.status,
    text: row.text,
    created_at: row.created_at,
    provider: providers.get(row.connection_id) ?? 'unknown',
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    thread_id: row.thread_id ?? null,
    external_message_id: row.external_message_id ?? null,
    external_user_id: row.external_user_id ?? null,
    person: row.member_id ? { id: row.member_id, name: people.get(row.member_id) ?? '' } : null,
    agent_id: row.agent_id ?? null,
  };
}

/** The conversation before a message, oldest first: what was said both ways, for context. */
async function threadBefore(service: SupabaseClient, message: Row): Promise<{ id: string; direction: string; text: string; created_at: string }[]> {
  let query = service.from('chat_messages').select('id, direction, text, created_at, member_id')
    .eq('connection_id', message.connection_id).eq('conversation_id', message.conversation_id).lt('created_at', message.created_at);
  query = message.thread_id ? query.eq('thread_id', message.thread_id) : query.is('thread_id', null);
  const { data } = await query.order('created_at', { ascending: false }).limit(THREAD_CONTEXT * 2);
  // In a shared conversation (a channel), only this person's messages and the answers to them.
  return ((data ?? []) as Row[])
    .filter((row) => row.direction === 'outbound' || row.member_id === message.member_id)
    .slice(0, THREAD_CONTEXT)
    .reverse()
    .map((row) => ({ id: row.id, direction: row.direction, text: row.text, created_at: row.created_at }));
}

/**
 * The assistant.message webhook's data: ids only, never chat text (delivery
 * views and logs must not show it). The message's id and where it came
 * from, its person, the agent, the ids of the thread so far, and where to
 * read and answer it.
 */
export async function assistantMessagePayload(service: SupabaseClient, messageId: string): Promise<Record<string, unknown>> {
  const { data, error } = await service.from('chat_messages').select(MESSAGE_COLUMNS).eq('id', messageId).single();
  if (error) throw error;
  const row = data as Row;
  const [providers, people, thread] = await Promise.all([
    providersOf(service, [row.connection_id]), peopleOf(service, row.member_id ? [row.member_id] : []), threadBefore(service, row),
  ]);
  return {
    message: {
      id: row.id,
      created_at: row.created_at,
      provider: providers.get(row.connection_id) ?? 'unknown',
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

/** The key's member must be a personal agent; chat is only ever routed to one. */
function requirePersonal(access: AccessContext) {
  if (access.role !== 'agent' || !access.principal_id) {
    throw forbidden('Only a person\'s own assistant reads and answers its chat', { reason: 'not_a_personal_agent' });
  }
}

/**
 * Messages routed to this assistant, oldest first: pending (the default:
 * waiting, nothing was sent to a webhook), notified, replied, handled, or
 * all. Each with the thread so far.
 */
export async function listAssistantMessages(
  service: SupabaseClient,
  agent: { memberId: string; access: AccessContext },
  filters: { status: string; limit: number },
): Promise<{ messages: (AssistantChatMessage & { thread: Awaited<ReturnType<typeof threadBefore>> })[] }> {
  requirePersonal(agent.access);
  let query = service.from('chat_messages').select(MESSAGE_COLUMNS).eq('agent_id', agent.memberId).eq('direction', 'inbound');
  if (filters.status !== 'all') query = query.eq('status', filters.status);
  const { data, error } = await query.order('created_at').order('id').limit(filters.limit);
  if (error) fail(error);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) return { messages: [] };
  const [providers, people, threads] = await Promise.all([
    providersOf(service, [...new Set(rows.map((row) => row.connection_id as string))]),
    peopleOf(service, [...new Set(rows.map((row) => row.member_id).filter(Boolean) as string[])]),
    Promise.all(rows.map((row) => threadBefore(service, row))),
  ]);
  return { messages: rows.map((row, index) => ({ ...present(row, providers, people), thread: threads[index] })) };
}

/** One message routed to this assistant, with its text and the thread so far. Anyone else's reads as missing. */
export async function getAssistantMessage(
  service: SupabaseClient,
  agent: { memberId: string; access: AccessContext },
  messageId: string,
): Promise<AssistantChatMessage & { thread: Awaited<ReturnType<typeof threadBefore>> }> {
  requirePersonal(agent.access);
  const row = await loadOwn(service, agent.memberId, messageId);
  const [providers, people, thread] = await Promise.all([
    providersOf(service, [row.connection_id]), peopleOf(service, row.member_id ? [row.member_id] : []), threadBefore(service, row),
  ]);
  return { ...present(row, providers, people), thread };
}

async function loadOwn(service: SupabaseClient, agentId: string, messageId: string): Promise<Row> {
  if (!UUID.test(messageId)) throw notFound('Chat message');
  const { data, error } = await service.from('chat_messages').select(MESSAGE_COLUMNS).eq('id', messageId).maybeSingle();
  if (error) fail(error);
  const row = data as Row | null;
  if (!row || row.direction !== 'inbound' || row.agent_id !== agentId) throw notFound('Chat message');
  return row;
}

/**
 * Replies to a message in the conversation it came from (its thread, unless
 * in_thread is false), through the provider. The reply is recorded either
 * way; a provider refusal answers 502 with the provider's reason.
 */
export async function replyToMessage(
  service: SupabaseClient,
  agent: { memberId: string; access: AccessContext },
  messageId: string,
  input: ChatReplyInput,
): Promise<{ id: string; status: 'sent'; external_message_id: string | null; reply_to: string }> {
  requirePersonal(agent.access);
  const message = await loadOwn(service, agent.memberId, messageId);
  const connection = await loadConnection(service, message.connection_id);
  if (!connection || connection.enabled === false) throw new ApiError(409, 'CONFLICT', 'This chat connection is switched off or was removed', { reason: 'connection_off' });
  const adapter = chatAdapter(connection.provider);
  if (!adapter) throw new ApiError(501, 'NOT_IMPLEMENTED', `${connection.provider} has no adapter yet`, { reason: 'no_adapter' });
  const threadId = input.in_thread === false ? null : message.thread_id ?? null;
  let externalId: string | null = null;
  let failure: ChatProviderError | null = null;
  try {
    externalId = (await adapter.send(openCredentials(connection as { id: string; credentials: string }), { conversationId: message.conversation_id, threadId, text: input.text })).externalMessageId;
  } catch (error) {
    if (!(error instanceof ChatProviderError)) throw error;
    failure = error;
  }
  const { data, error } = await service.from('chat_messages').insert({
    connection_id: message.connection_id, direction: 'outbound', status: failure ? 'failed' : 'sent',
    conversation_id: message.conversation_id, thread_id: threadId, external_message_id: externalId,
    member_id: message.member_id, agent_id: agent.memberId, reply_to_id: message.id, text: input.text, error: failure ? failure.message.slice(0, 500) : null,
  }).select('id').single();
  if (error) fail(error);
  if (failure) {
    throw new ApiError(502, 'BAD_GATEWAY', failure.message, { reason: 'provider_refused', provider: failure.provider, code: failure.code });
  }
  await service.from('chat_messages').update({ status: 'replied', handled_at: new Date().toISOString() }).eq('id', message.id);
  return { id: (data as Row).id, status: 'sent', external_message_id: externalId, reply_to: message.id };
}

/** Marks a message handled without a reply, so the poll stops listing it. */
export async function markMessageHandled(service: SupabaseClient, agent: { memberId: string; access: AccessContext }, messageId: string): Promise<{ id: string; status: string }> {
  requirePersonal(agent.access);
  const message = await loadOwn(service, agent.memberId, messageId);
  if (message.status === 'replied' || message.status === 'handled') return { id: message.id, status: message.status };
  const { error } = await service.from('chat_messages').update({ status: 'handled', handled_at: new Date().toISOString() }).eq('id', message.id);
  if (error) fail(error);
  return { id: message.id, status: 'handled' };
}
