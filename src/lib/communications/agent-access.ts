import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest, forbidden, notFound } from '@/lib/api/errors';
import { accessAllows } from '@/lib/api/access';
import type { AccessContext } from '@/lib/access-control';
import { comms } from '@/lib/communications/db';

/**
 * Rule 4: an API key reads the inboxes its member can read, as the Inbox
 * scopes them: every inbox for a member who manages inboxes through the API
 * (the owner), otherwise only the inboxes the member was granted
 * (communications.inbox_access, how an agent is narrowed to its own). Checked on the
 * server for every request; the key's own inbound_email scopes still decide
 * what it may do there. Messages
 * still receiving are invisible to agents, and so is every email in an inbox
 * the key cannot read: asking for one by id answers 404, the same as an id
 * that does not exist, so the answer never reveals that it does.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(value: string | null | undefined, name: string): string {
  if (!value || !UUID.test(value)) throw badRequest(`${name} must be a UUID`);
  return value.toLowerCase();
}

/** Only for an explicit inbox_id the key names, which reveals nothing new. */
export function inboxScopeDenied(): ApiError {
  return forbidden('Inbox scope denied', {
    reason: 'inbox_scope',
    grant_on: 'email_inbox_access',
    hint: "The key's member is not granted this inbox. Leave inbox_id out to read every granted inbox, or grant access in Settings > Email inboxes.",
  });
}

/**
 * A row that vanished while the request ran (deleted by a person or by
 * retention): an RPC's EMAIL_NOT_FOUND, or .single() finding no row.
 */
export function isGoneError(error: unknown): boolean {
  const value = error as { code?: string; message?: string } | null;
  return value?.code === 'PGRST116' || (value?.message ?? '').includes('EMAIL_NOT_FOUND');
}

export async function memberInboxIds(supabase: SupabaseClient, memberId: string, access: AccessContext): Promise<string[]> {
  if (accessAllows(access, 'inbound_email.manage', 'api')) {
    const { data, error } = await comms(supabase).from('inboxes').select('id').order('created_at');
    if (error) throw error;
    return ((data ?? []) as { id: string }[]).map((row) => row.id);
  }
  const { data, error } = await comms(supabase).from('inbox_access').select('inbox_id').eq('member_id', memberId);
  if (error) throw error;
  return ((data ?? []) as { inbox_id: string }[]).map((row) => row.inbox_id);
}

/** The inboxes a request covers: the one asked for (when granted), or every granted one. */
export async function inboxScope(supabase: SupabaseClient, memberId: string, access: AccessContext, inboxParam: string | null): Promise<string[]> {
  const granted = await memberInboxIds(supabase, memberId, access);
  if (!inboxParam) return granted;
  const inboxId = assertUuid(inboxParam, 'inbox_id');
  if (!granted.includes(inboxId)) throw inboxScopeDenied();
  return [inboxId];
}

export interface AccessibleMessage {
  id: string;
  inbox_id: string;
  thread_id: string;
  status: string;
}

export async function loadAccessibleMessage(
  supabase: SupabaseClient,
  memberId: string,
  access: AccessContext,
  messageId: string,
): Promise<AccessibleMessage> {
  const id = assertUuid(messageId, 'id');
  const { data, error } = await comms(supabase)
    .from('messages')
    .select('id, inbox_id, thread_id, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status === 'receiving') throw notFound('Email');
  const granted = await memberInboxIds(supabase, memberId, access);
  if (!granted.includes(data.inbox_id)) throw notFound('Email');
  return data as AccessibleMessage;
}
