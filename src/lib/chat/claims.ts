import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { instanceIdSchema } from '@/lib/agent-runs';
import { ApiError, badRequest, notFound } from '@/lib/api/errors';
import { MAX_LEASE_MINUTES } from '@/lib/api/claims';
import { attachmentViews } from './messages';

/**
 * Chat claims (20261127002000_agent_runtime.sql): a lease on one chat
 * message, or on a whole conversation (a DM, or a thread in a channel), so
 * that among an agent's workers (a pool on one key) exactly one answers.
 * The same lease rules as task claims: lease_minutes (default 30, at most
 * 240), claiming again renews, extend keeps it going, release ends it, and a
 * lease past its time is no lease.
 *
 * The holder is the agent and, optionally, one of its workers (instance_id;
 * left out, the agent itself). While a message or its conversation is
 * leased, nobody else replies to it or marks it handled (409
 * claimed_by_other): another worker of the same agent included. Follow-ups
 * in a held conversation go to the agent holding it (lib/chat/inbound.ts).
 * A conversation's holder keeps its running summary (summary on claim,
 * extend or release). Server only.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CHAT_SUMMARY_MAX = 4000;

export const chatClaimSchema = z.object({
  /** Which of the agent's workers holds it; left out, the agent itself. */
  instance_id: instanceIdSchema.optional(),
  lease_minutes: z.number().int().min(1).max(MAX_LEASE_MINUTES).optional(),
  /** A host key (agents.host) only: the agent the lease is held for, one it serves. */
  agent_id: z.uuid('agent_id must be an agent id').optional(),
  /** A conversation only: replaces its running summary (the holder's). */
  summary: z.string().trim().min(1).max(CHAT_SUMMARY_MAX, `summary is at most ${CHAT_SUMMARY_MAX} characters`).optional(),
}).strict();
export type ChatClaimInput = z.infer<typeof chatClaimSchema>;

export type ChatClaimSubject = 'message' | 'conversation';
export type ChatClaimAction = 'claim' | 'extend' | 'release';

export interface ChatLease {
  agent_id: string;
  agent_name?: string | null;
  /** The worker holding it; null for the agent itself. */
  instance_id: string | null;
  claimed_at: string | null;
  expires_at: string;
}

const live = (expires: unknown) => typeof expires === 'string' && Date.parse(expires) > Date.now();

/** A message's live lease (its agent holds it), or null. */
export function messageLease(row: Row): ChatLease | null {
  if (!row.agent_id || !live(row.claim_expires_at)) return null;
  return { agent_id: row.agent_id, instance_id: row.claim_instance ?? null, claimed_at: row.claimed_at ?? null, expires_at: row.claim_expires_at };
}

/** A conversation's live lease, or null. */
export function conversationLease(row: Row | null | undefined): ChatLease | null {
  if (!row?.holder_agent_id || !live(row.claim_expires_at)) return null;
  return { agent_id: row.holder_agent_id, instance_id: row.holder_instance ?? null, claimed_at: row.claimed_at ?? null, expires_at: row.claim_expires_at };
}

function heldError(subject: ChatClaimSubject, holder: Row | null | undefined): ApiError {
  const who = holder?.agent_name ?? 'Another agent';
  const worker = holder?.instance_id ? ` (worker ${holder.instance_id})` : '';
  return new ApiError(409, 'CONFLICT', `${who}${worker} holds this ${subject === 'message' ? 'chat message' : 'conversation'} until ${holder?.expires_at ?? 'its lease runs out'}.`, {
    reason: 'claimed_by_other',
    claimed_by: holder?.agent_id ?? null,
    claimed_by_name: holder?.agent_name ?? null,
    instance_id: holder?.instance_id ?? null,
    claimed_at: holder?.claimed_at ?? null,
    expires_at: holder?.expires_at ?? null,
    hint: 'Leave it to the holder, or try again after it runs out.',
  });
}

const missingRuntime = (error: { code?: string; message?: string } | null) =>
  !!error && (['42P01', '42703', '42883', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code ?? '') || /chat_claim|chat_conversations|claim_instance/.test(error.message ?? ''));

export function chatRuntimePending(): ApiError {
  return new ApiError(503, 'SERVICE_UNAVAILABLE', 'Chat claims and conversations work once the database update 20261127002000_agent_runtime.sql is applied', { reason: 'migration_pending' });
}

/**
 * Claims, extends or releases a lease for an agent (memberId) and its
 * worker (instance). A conversation's summary is written after, by its
 * holder. Answers what the lease now is.
 */
export async function chatClaim(
  service: SupabaseClient,
  agentId: string,
  subject: ChatClaimSubject,
  id: string,
  action: ChatClaimAction,
  input: Pick<ChatClaimInput, 'instance_id' | 'lease_minutes' | 'summary'>,
) {
  if (!UUID.test(id)) throw notFound(subject === 'message' ? 'Chat message' : 'Conversation');
  if (input.summary !== undefined && subject !== 'conversation') throw badRequest('summary is for a conversation', { reason: 'summary_on_message' });
  const instance = input.instance_id ?? null;
  // A message recorded before the update finds its conversation on first use.
  const { data, error } = await service.rpc('chat_claim', {
    p_subject: subject, p_id: id, p_agent: agentId, p_instance: instance, p_action: action, p_lease_minutes: input.lease_minutes ?? 30,
  });
  if (error) {
    if (missingRuntime(error)) throw chatRuntimePending();
    if (error.code === '22023') throw badRequest(error.message);
    throw error;
  }
  const result = (data ?? {}) as Row;
  const what = subject === 'message' ? 'Chat message' : 'Conversation';
  switch (result.outcome) {
    case 'not_found': throw notFound(what);
    case 'held': throw heldError(subject, result.holder);
    case 'done':
      throw new ApiError(409, 'CONFLICT', `This message was already ${result.status}: there is nothing left to claim.`, { reason: 'message_done', status: result.status });
    case 'not_held':
      throw new ApiError(409, 'CONFLICT', 'Your lease ran out. Claim it again.', { reason: 'claim_expired', expired_at: result.expired_at ?? null });
    default:
  }
  if (action === 'extend' && result.outcome === 'not_claimed') {
    throw new ApiError(409, 'CONFLICT', 'You do not hold a lease on this. Claim it first.', { reason: 'not_claimed' });
  }
  if (input.summary !== undefined) await writeSummary(service, id, agentId, input.summary);
  const lease: ChatLease | null = action === 'release' ? null
    : { agent_id: agentId, instance_id: instance, claimed_at: result.claimed_at ?? null, expires_at: result.expires_at };
  return {
    subject,
    id,
    claim: lease,
    ...(action === 'claim' ? { renewed: result.outcome === 'renewed' } : {}),
    ...(action === 'release' ? { released: result.outcome === 'released' } : {}),
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  };
}

async function writeSummary(service: SupabaseClient, conversationId: string, agentId: string, summary: string) {
  const { error } = await service.from('chat_conversations')
    .update({ summary, summary_updated_at: new Date().toISOString(), summary_by: agentId }).eq('id', conversationId);
  if (error) throw error;
}

/**
 * Refuses a reply or a handled mark while someone else leases the message
 * or its conversation: another agent, or another worker of this one. The
 * holder itself (the same agent and worker) goes ahead.
 */
export async function assertChatLease(service: SupabaseClient, message: Row, agentId: string, instanceId: string | null): Promise<void> {
  const own = messageLease(message);
  if (own && (own.agent_id !== agentId || own.instance_id !== instanceId)) {
    throw heldError('message', { ...own, agent_name: await nameOf(service, own.agent_id) });
  }
  if (!message.chat_conversation_id) return;
  const { data, error } = await service.from('chat_conversations')
    .select('holder_agent_id, holder_instance, claimed_at, claim_expires_at').eq('id', message.chat_conversation_id).maybeSingle();
  if (error) {
    if (missingRuntime(error)) return;
    throw error;
  }
  const held = conversationLease(data as Row | null);
  if (held && (held.agent_id !== agentId || held.instance_id !== instanceId)) {
    throw heldError('conversation', { ...held, agent_name: await nameOf(service, held.agent_id) });
  }
}

async function nameOf(service: SupabaseClient, id: string): Promise<string | null> {
  const { data } = await service.from('team_members').select('name').eq('id', id).maybeSingle();
  return (data as Row | null)?.name ?? null;
}

/** The live holder of a conversation, for routing a follow-up to it; null when none or before the update. */
export async function conversationHolder(service: SupabaseClient, connectionId: string, conversationId: string, threadKey: string): Promise<string | null> {
  const { data, error } = await service.from('chat_conversations')
    .select('holder_agent_id, holder_instance, claimed_at, claim_expires_at')
    .eq('connection_id', connectionId).eq('conversation_id', conversationId).eq('thread_key', threadKey).maybeSingle();
  if (error) {
    if (missingRuntime(error)) return null;
    throw error;
  }
  return conversationLease(data as Row | null)?.agent_id ?? null;
}

/** The thread key of a message, as pm.chat_thread_key reads it. */
export function threadKeyOf(row: { thread_id?: string | null; external_message_id?: string | null; is_direct?: boolean | null }, company: boolean): string {
  if (row.thread_id) return row.thread_id;
  if (row.is_direct) return '';
  return company && row.external_message_id ? row.external_message_id : '';
}

export const CONVERSATION_MESSAGES_DEFAULT = 50;
export const CONVERSATION_MESSAGES_MAX = 200;

const CONVERSATION_COLUMNS = 'id, connection_id, conversation_id, thread_key, holder_agent_id, holder_instance, claimed_at, claim_expires_at, summary, summary_updated_at, summary_by, created_at, last_message_at';
const ROW_COLUMNS = 'id, direction, status, conversation_id, thread_id, external_message_id, member_id, agent_id, is_request, is_direct, text, created_at, attachments, reply_to_id, chat_conversation_id, claim_instance, claimed_at, claim_expires_at';

/**
 * One conversation for an agent that has a message routed to it there: its
 * messages (oldest first, the newest `limit`), its lease and the running
 * summary its agents keep. A company conversation shows what was routed to
 * this agent and its own answers; a personal one, the whole DM with its
 * person. Anyone else reads it as missing.
 */
export async function getChatConversation(service: SupabaseClient, agentId: string, id: string, limit = CONVERSATION_MESSAGES_DEFAULT) {
  if (!UUID.test(id)) throw notFound('Conversation');
  const { data: conversation, error } = await service.from('chat_conversations').select(CONVERSATION_COLUMNS).eq('id', id).maybeSingle();
  if (error) {
    if (missingRuntime(error)) throw chatRuntimePending();
    throw error;
  }
  if (!conversation) throw notFound('Conversation');
  const { data: mine, error: mineError } = await service.from('chat_messages').select('id')
    .eq('chat_conversation_id', id).eq('direction', 'inbound').eq('agent_id', agentId).limit(1);
  if (mineError) throw mineError;
  if (!(mine ?? []).length) throw notFound('Conversation');
  const c = conversation as Row;
  const { data: connection, error: connectionError } = await service.from('chat_connections').select('id, provider, kind').eq('id', c.connection_id).maybeSingle();
  if (connectionError) throw connectionError;
  const company = (connection as Row | null)?.kind === 'company';
  const { data: rows, error: rowsError } = await service.from('chat_messages').select(ROW_COLUMNS)
    .eq('connection_id', c.connection_id).eq('conversation_id', c.conversation_id)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(CONVERSATION_MESSAGES_MAX * 3);
  if (rowsError) throw rowsError;
  const all = (rows ?? []) as Row[];
  const direct = all.some((row) => row.direction === 'inbound' && row.is_direct === true);
  const inThread = (row: Row) => (row.chat_conversation_id ? row.chat_conversation_id === id
    : threadKeyOf({ ...row, is_direct: row.is_direct ?? (direct ? true : null) }, company) === c.thread_key);
  const visible = (row: Row) => !company || row.agent_id === agentId;
  const picked = all.filter((row) => inThread(row) && visible(row)).slice(0, Math.min(Math.max(limit, 1), CONVERSATION_MESSAGES_MAX)).reverse();
  const people = [...new Set(picked.map((row) => row.member_id).filter(Boolean))] as string[];
  const names = new Map<string, string>();
  if (people.length) {
    const { data: members } = await service.from('team_members').select('id, name').in('id', people);
    for (const member of (members ?? []) as Row[]) names.set(member.id, member.name ?? '');
  }
  const held = conversationLease(c);
  return {
    id: c.id as string,
    connection_id: c.connection_id as string,
    provider: (connection as Row | null)?.provider ?? 'unknown',
    connection_kind: company ? 'company' : 'personal',
    conversation_id: c.conversation_id as string,
    thread_id: c.thread_key || null,
    claim: held ? { ...held, agent_name: await nameOf(service, held.agent_id) } : null,
    summary: (c.summary as string | null) ?? null,
    summary_updated_at: (c.summary_updated_at as string | null) ?? null,
    summary_by: (c.summary_by as string | null) ?? null,
    last_message_at: c.last_message_at as string,
    messages: picked.map((row) => ({
      id: row.id as string,
      direction: row.direction as 'inbound' | 'outbound',
      status: row.status as string,
      text: row.text as string,
      created_at: row.created_at as string,
      person: row.member_id ? { id: row.member_id as string, name: names.get(row.member_id) ?? '' } : null,
      agent_id: (row.agent_id as string | null) ?? null,
      is_request: row.direction === 'inbound' ? row.is_request !== false : undefined,
      in_reply_to: row.reply_to_id ?? null,
      attachments: row.direction === 'inbound' ? attachmentViews(row) : [],
      claim: row.direction === 'inbound' ? messageLease(row) : null,
    })),
  };
}

/** A message's conversation id, made on first use for one recorded before the update; null before it. */
export async function ensureConversation(service: SupabaseClient, message: Row): Promise<string | null> {
  if (message.chat_conversation_id) return message.chat_conversation_id as string;
  const { data, error } = await service.rpc('ensure_chat_conversation', { p_message_id: message.id });
  if (error) {
    if (missingRuntime(error)) return null;
    throw error;
  }
  return (data as string | null) ?? null;
}

