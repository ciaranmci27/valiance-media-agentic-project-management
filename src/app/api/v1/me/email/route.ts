import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { assertPersonCaller } from '@/lib/api/people-only';
import { emailChangeRefusal, newEmail, provePasswordOverApi } from '@/lib/api/email-change-api';
import { changeSignInEmail } from '@/lib/team/email-change';

export const dynamic = 'force-dynamic';

const schema = z.object({
  new_email: newEmail,
  current_password: z.string().min(1).max(200),
}).strict();
type Body = z.infer<typeof schema>;

/**
 * Changes your own sign-in email (Settings > Account), by the same writer as
 * the app. Proof it is you: your current password (403 wrong_password or
 * current_password_required; an account with no password changes it in the
 * app). Your own key only, never an agent (403 people_only). The old address
 * is told. REST only: the password never goes through MCP. The audit row
 * never holds the password.
 *
 * Permission: tasks.read (any member's own key).
 */
export const POST = withApi<Body>(async ({ supabase, access, body, apiKeyId, teamMemberId }) => {
  assertPersonCaller(access);
  let updated: Record<string, unknown>;
  try {
    updated = await changeSignInEmail(supabase, {
      actor: { memberId: teamMemberId, role: access.role, managesTeam: false },
      targetId: teamMemberId,
      newEmail: body.new_email,
      proveSelf: (login) => provePasswordOverApi(login, body.current_password),
    });
  } catch (error) {
    throw emailChangeRefusal(error);
  }
  logAudit(supabase, { method: 'POST', endpoint: '/api/v1/me/email', entityType: 'team_member', entityId: teamMemberId, apiKeyId, teamMemberId, requestBody: { new_email: body.new_email }, statusCode: 200 });
  return success({ id: updated.id, email: updated.email });
}, { schema, permission: 'tasks.read' });
