import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { ApiError, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { fetchContactEmails } from '@/lib/supabase/queries';
import { contactEmailsSchema, writeContactEmails, type ContactEmailsInput } from '@/lib/contact-emails';
import type { SupabaseClient } from '@supabase/supabase-js';

const byPrimaryThenAge = (a: { is_primary: boolean; created_at: string }, b: { is_primary: boolean; created_at: string }) =>
  Number(b.is_primary) - Number(a.is_primary) || a.created_at.localeCompare(b.created_at);

async function liveContact(supabase: SupabaseClient, id: string) {
  const { data, error } = await supabase.from('contacts').select('id').eq('id', id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Contact');
}

/**
 * A contact's email addresses, primary first: id, email, label, is_primary.
 * The primary one is also the contact's email.
 *
 * Permission: contacts.read.
 */
export const GET = withApi<unknown, { id: string }>(async ({ supabase, params }) => {
  await liveContact(supabase, params.id);
  return success((await fetchContactEmails(supabase, params.id)).sort(byPrimaryThenAge));
}, { permission: 'contacts.read' });

/**
 * Makes a contact's addresses exactly this list, as the contact form in the
 * app saves them: a row with an id keeps that address (and takes the new
 * email or label), a row without one is added, an address left out is
 * removed. The one marked is_primary (else the first) becomes primary and
 * the contact's email; an empty list clears them. Answers the saved list,
 * primary first. An address twice in the list is 409.
 *
 * Permission: contacts.manage.
 */
export const PUT = withApi<ContactEmailsInput, { id: string }>(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  await liveContact(supabase, params.id);
  const addresses = body.emails.map((row) => row.email);
  if (new Set(addresses).size !== addresses.length) {
    throw new ApiError(409, 'CONFLICT', 'The same address is in the list twice', { reason: 'duplicate_email' });
  }
  const before = await fetchContactEmails(supabase, params.id);
  const known = new Set(before.map((row) => row.id));
  const stranger = body.emails.find((row) => row.id && !known.has(row.id));
  if (stranger) throw new ApiError(422, 'VALIDATION_ERROR', 'An id is not one of this contact\'s addresses', { reason: 'unknown_email_id', id: stranger.id });
  let rows;
  try {
    rows = await writeContactEmails(supabase, params.id, body.emails.map((row) => ({
      id: row.id, email: row.email, label: row.label ?? null, is_primary: row.is_primary ?? false,
    })));
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      throw new ApiError(409, 'CONFLICT', 'One of these addresses is already saved on this contact', { reason: 'duplicate_email' });
    }
    throw error;
  }
  const saved = rows.sort(byPrimaryThenAge);
  logAudit(supabase, { method: 'PUT', endpoint: `/api/v1/contacts/${params.id}/emails`, entityType: 'contact', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, beforeSnapshot: before, afterSnapshot: saved, statusCode: 200 });
  return success(saved);
}, { schema: contactEmailsSchema, permission: 'contacts.manage' });
