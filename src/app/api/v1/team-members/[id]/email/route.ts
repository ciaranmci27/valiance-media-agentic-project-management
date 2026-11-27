import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { ApiError } from '@/lib/api/errors';
import { accessAllows } from '@/lib/api/access';
import { assertOwnerCaller } from '@/lib/api/people-only';
import { emailChangeRefusal, newEmail } from '@/lib/api/email-change-api';
import { changeSignInEmail } from '@/lib/team/email-change';

export const dynamic = 'force-dynamic';

const schema = z.object({ new_email: newEmail }).strict();
type Body = z.infer<typeof schema>;

/**
 * Changes someone else's sign-in email (Team > Edit member), by the same
 * writer as the app: only an Owner (the email decides who can reset the
 * password), never another Owner's, never a login another app owns. The
 * old address is told who changed it. Your own: POST /api/v1/me/email, with
 * your current password.
 *
 * Permission: team.manage, on an Owner's key.
 */
export const POST = withApi<Body, { id: string }>(async ({ supabase, access, params, body, apiKeyId, teamMemberId }) => {
  if (params.id === teamMemberId) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Change your own sign-in email with POST /api/v1/me/email and your current password', { reason: 'use_me_email' });
  }
  assertOwnerCaller(access, "changes someone's sign-in email");
  let updated: Record<string, unknown>;
  try {
    updated = await changeSignInEmail(supabase, {
      actor: { memberId: teamMemberId, role: access.role, managesTeam: accessAllows(access, 'team.manage', 'api') },
      targetId: params.id,
      newEmail: body.new_email,
      proveSelf: async () => { throw new ApiError(422, 'VALIDATION_ERROR', 'Use POST /api/v1/me/email for your own', { reason: 'use_me_email' }); },
    });
  } catch (error) {
    throw emailChangeRefusal(error);
  }
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/team-members/${params.id}/email`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId, requestBody: body, statusCode: 200 });
  return success({ id: updated.id, email: updated.email });
}, { schema, permission: 'team.manage' });
