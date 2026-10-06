import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, badRequest, forbidden, notFound } from '@/lib/api/errors';

/**
 * Rule 4: an API key reads only the inboxes its member was granted
 * (email_inbox_access), checked on the server for every request. Messages
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

export async function memberInboxIds(supabase: SupabaseClient, memberId: string): Promise<string[]> {
  const { data, error } = await supabase.from('email_inbox_access').select('inbox_id').eq('member_id', memberId);
  if (error) throw error;
  return ((data ?? []) as { inbox_id: string }[]).map((row) => row.inbox_id);
}

/** The inboxes a request covers: the one asked for (when granted), or every granted one. */
export async function inboxScope(supabase: SupabaseClient, memberId: string, inboxParam: string | null): Promise<string[]> {
  const granted = await memberInboxIds(supabase, memberId);
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
  messageId: string,
): Promise<AccessibleMessage> {
  const id = assertUuid(messageId, 'id');
  const { data, error } = await supabase
    .from('email_messages')
    .select('id, inbox_id, thread_id, status')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.status === 'receiving') throw notFound('Email');
  const granted = await memberInboxIds(supabase, memberId);
  if (!granted.includes(data.inbox_id)) throw notFound('Email');
  return data as AccessibleMessage;
}
