import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { accountSignInView, assertAccountChange } from '@/lib/api/sign-in';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/setup/first-owner';

export const dynamic = 'force-dynamic';

const passwordSchema = z.object({
  password: z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`).max(MAX_PASSWORD, `Use at most ${MAX_PASSWORD} characters.`),
}).strict();

/**
 * Sets or changes the signed-in member's password. Refused for a login
 * another app made (login_owned false): that app manages its password. Set
 * through the member's own session, so the project's own password rules
 * (strength, recent sign-in) apply. Answers the new sign-in view.
 */
export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, authUserId, sessionClient }) => {
    const body = await readWorkspaceBody(request, passwordSchema);
    await assertAccountChange(service, { memberId, authUserId }, 'set_password');
    const { error } = await sessionClient.auth.updateUser({ password: body.password });
    if (error) throw new ApiError(error.status && error.status < 500 ? 422 : 500, 'VALIDATION_ERROR', error.message || 'Could not set the password. Try again.', { fields: { password: error.message } });
    return accountSignInView(service, { memberId, authUserId });
  }, { noStore: true });
}
