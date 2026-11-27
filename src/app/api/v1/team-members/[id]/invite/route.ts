import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { ApiError, notFound } from '@/lib/api/errors';
import { appUrlFor, emailConfigured, InviteError, reissueInvite } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

const CODES: Record<number, string> = { 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_ERROR' };

/**
 * Resend invite (Team): a fresh set-your-password link, emailed to someone
 * who has not signed in yet; it replaces the earlier link. The same rules as
 * the Team page: only an Owner re-invites an Owner, an Admin or an agent;
 * never a personal agent; not once they have signed in.
 *
 * The link itself is never answered: it signs a person in, so it is a
 * credential, and only their inbox gets it (Copy invite link stays in the
 * app). So the invite is refused before a new link is made when email
 * cannot go out (409 email_not_set_up), and for an agent, whose address is
 * rarely an inbox (422 agent_link_only). Answers { emailed, email_status }.
 *
 * Permission: team.manage.
 */
export const POST = withApi<unknown, { id: string }>(async ({ supabase, params, access, origin, apiKeyId, teamMemberId }) => {
  const { data: target, error } = await supabase.from('team_members').select('id, role').eq('id', params.id).maybeSingle();
  if (error) throw error;
  if (!target) throw notFound('Team member');
  if (target.role === 'agent') {
    throw new ApiError(422, 'VALIDATION_ERROR', "An agent's invite link is copied in the app, never emailed or sent over the API", { reason: 'agent_link_only' });
  }
  if (!(await emailConfigured(supabase))) {
    throw new ApiError(409, 'CONFLICT', 'This workspace cannot send email yet, so the invite cannot be resent. Set up email sending in Settings, or copy the invite link in the app.', { reason: 'email_not_set_up' });
  }
  const { data: me } = await supabase.from('team_members').select('name').eq('id', teamMemberId).maybeSingle();
  let delivery;
  try {
    delivery = await reissueInvite({ service: supabase, access, memberId: params.id, send: true, appUrl: appUrlFor(origin), inviterName: (me as { name?: string } | null)?.name ?? null });
  } catch (failure) {
    if (failure instanceof InviteError) throw new ApiError(failure.status, CODES[failure.status] ?? 'INTERNAL_ERROR', failure.message, { reason: 'invite_refused' });
    throw failure;
  }
  // Never the link: it signs the person in.
  const answer = { emailed: delivery.emailed, email_status: delivery.emailStatus, ...(delivery.emailError ? { email_error: delivery.emailError } : {}) };
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/team-members/${params.id}/invite`, entityType: 'team_member', entityId: params.id, apiKeyId, teamMemberId, afterSnapshot: answer, statusCode: 200 });
  return success(answer);
}, { permission: 'team.manage' });
