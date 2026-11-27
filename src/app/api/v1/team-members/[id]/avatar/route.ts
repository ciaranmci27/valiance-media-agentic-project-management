import type { NextRequest } from 'next/server';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { forbidden, notFound } from '@/lib/api/errors';
import { PHOTO_BODY_BYTES, readPhoto, storePhoto } from '@/lib/api/photo-upload';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

/**
 * Uploads a team member's picture (Team > Edit member): multipart, one field
 * named file, PNG or JPG up to 2 MB, stored where the app stores it and set
 * as their avatar. The same rule as PATCH /api/v1/team-members/{id}: an
 * Owner's picture only with that Owner's own key. An agent's picture:
 * POST /api/v1/agents/{id}/picture. REST only (a file upload).
 *
 * Permission: team.manage.
 */
export const POST = (request: NextRequest, context: Context) => withApi<unknown, { id: string }>(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { data: before, error } = await supabase.from('team_members').select('id, role, avatar').eq('id', params.id).maybeSingle();
  if (error) throw error;
  if (!before) throw notFound('Team member');
  if (before.role === 'owner' && params.id !== teamMemberId) throw forbidden('An Owner is changed only by that Owner', { reason: 'owner_protected' });
  if (before.role === 'agent') throw forbidden("Set an agent's picture with POST /api/v1/agents/{id}/picture", { reason: 'use_agent_picture' });
  const url = await storePhoto(supabase, `team/${params.id}.jpg`, await readPhoto(request));
  const { data, error: updateError } = await supabase.from('team_members').update({ avatar: url }).eq('id', params.id)
    .select('id, name, email, avatar, role, status, timezone, created_at, updated_at').maybeSingle();
  if (updateError) throw updateError;
  if (!data) throw notFound('Team member');
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/team-members/${params.id}/avatar`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId, beforeSnapshot: { avatar: before.avatar }, afterSnapshot: { avatar: url }, statusCode: 200 });
  return success(data);
}, { permission: 'team.manage', maxBodyBytes: PHOTO_BODY_BYTES })(request, context);
