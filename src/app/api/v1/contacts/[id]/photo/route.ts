import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { notFound } from '@/lib/api/errors';
import { PHOTO_BODY_BYTES, readPhoto, storePhoto } from '@/lib/api/photo-upload';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Uploads a contact's photo (the contact form): multipart, one field named
 * file, PNG or JPG up to 2 MB, stored where the app stores it and set as the
 * contact's avatar_url. A contact the key cannot reach is 403 or 404 before
 * anything is stored. REST only (a file upload); update_contact takes a link.
 *
 * Permission: contacts.manage.
 */
export const POST = (request: NextRequest, context: Context) => withApi<unknown, { id: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { data: before, error } = await supabase.from('contacts').select('id, avatar_url').eq('id', params.id).is('deleted_at', null).maybeSingle();
  if (error) throw error;
  if (!before) throw notFound('Contact');
  const url = await storePhoto(supabase, `contacts/${params.id}.jpg`, await readPhoto(request));
  const { data, error: updateError } = await supabase.from('contacts').update({ avatar_url: url }).eq('id', params.id).is('deleted_at', null).select().maybeSingle();
  if (updateError) throw updateError;
  if (!data) throw notFound('Contact');
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/contacts/${params.id}/photo`, entityType: 'contact', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: { avatar_url: before.avatar_url }, afterSnapshot: { avatar_url: url }, statusCode: 200 });
  return success(data);
}, { permission: 'contacts.manage', maxBodyBytes: PHOTO_BODY_BYTES })(request, context);
