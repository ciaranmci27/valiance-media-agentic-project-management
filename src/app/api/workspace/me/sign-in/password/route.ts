import { z } from 'zod';
import { ApiError } from '@/lib/api/errors';
import { confirmItIsYou, sendAccountNotice, signOutOtherSessions } from '@/lib/api/account-security';
import { accountSignInView, assertAccountChange, loginFacts } from '@/lib/api/sign-in';
import { readWorkspaceBody, workspaceRoute } from '@/lib/api/workspace-route';
import { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/setup/first-owner';

export const dynamic = 'force-dynamic';

const passwordSchema = z.object({
  password: z.string().min(MIN_PASSWORD, `Use at least ${MIN_PASSWORD} characters.`).max(MAX_PASSWORD, `Use at most ${MAX_PASSWORD} characters.`),
  /** The password now: needed to change one (lib/api/account-security.ts). */
  current_password: z.string().max(MAX_PASSWORD).optional(),
}).strict();

/**
 * Sets or changes the signed-in member's password. Refused for a login
 * another app made (login_owned false): that app manages its password. Set
 * through the member's own session, so the project's own password rules
 * (strength, recent sign-in) apply. Changing one needs the current password,
 * except right after a reset link; setting the first one (a Google-only
 * account) needs a recent sign-in. Other sessions are signed out and the
 * address is told. Answers the new sign-in view.
 *
 * Session only, never over the API: an agent never changes a person's password.
 */
export async function PUT(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, authUserId, sessionClient }) => {
    const body = await readWorkspaceBody(request, passwordSchema);
    await assertAccountChange(service, { memberId, authUserId }, 'set_password');
    const login = await loginFacts(service, authUserId);
    await confirmItIsYou({ sessionClient, email: login.email, hasPassword: login.hasPassword, currentPassword: body.current_password });
    const { error } = await sessionClient.auth.updateUser({ password: body.password });
    if (error) throw new ApiError(error.status && error.status < 500 ? 422 : 500, 'VALIDATION_ERROR', error.message || 'Could not set the password. Try again.', { fields: { password: error.message } });
    await signOutOtherSessions(sessionClient);
    if (login.hasPassword) await sendAccountNotice({ to: login.email, change: 'password' });
    return accountSignInView(service, { memberId, authUserId });
  }, { noStore: true });
}
