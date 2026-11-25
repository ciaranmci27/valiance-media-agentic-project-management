import { ApiError } from '@/lib/api/errors';
import { accountSignInView, assertAccountChange } from '@/lib/api/sign-in';
import { workspaceRoute } from '@/lib/api/workspace-route';

export const dynamic = 'force-dynamic';

/**
 * Unlinks Google from the signed-in member's login, only while they keep
 * another way in this workspace accepts (a password, with passwords
 * allowed), and never on a login another app made. Done through their own
 * session, as Supabase requires. Linking starts at POST /api/auth/google.
 */
export async function DELETE(request: Request) {
  return workspaceRoute(request, async ({ service, memberId, authUserId, sessionClient }) => {
    await assertAccountChange(service, { memberId, authUserId }, 'unlink_google');
    const { data, error } = await sessionClient.auth.getUserIdentities();
    if (error) throw new ApiError(500, 'INTERNAL_ERROR', error.message || 'Could not read your sign-in. Try again.');
    const google = data?.identities.find((identity) => identity.provider === 'google');
    if (google) {
      const { error: unlinkError } = await sessionClient.auth.unlinkIdentity(google);
      if (unlinkError) throw new ApiError(409, 'CONFLICT', unlinkError.message || 'Could not unlink Google. Try again.');
    }
    return accountSignInView(service, { memberId, authUserId });
  }, { noStore: true });
}
