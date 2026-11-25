import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { decodeGoogleIntent, GOOGLE_INTENT_COOKIE, type GoogleIntent } from '@/lib/api/google-intent';
import { admitGoogleLogin, googleIdentityOf, signInMethodsOrDefault } from '@/lib/api/sign-in';
import { ALREADY_OWNED, claimFirstOwnerWithGoogle, CREATE_ACCOUNT_PATH, FirstOwnerError } from '@/lib/setup/first-owner';
import { WELCOME_PATH } from '@/lib/setup/gate';
import { allowsGoogle, RESET_PASSWORD_PATH, type SignInErrorCode } from '@/lib/sign-in';
import { GoogleInviteError, acceptInviteWithGoogle, SET_PASSWORD_PATH } from '@/lib/team/invite';

export const dynamic = 'force-dynamic';

/**
 * Where Google sends people back (PKCE: Supabase hands over a code, swapped
 * here for a session). What the round trip was for comes from the cookie
 * POST /api/auth/google set (src/lib/api/google-intent.ts); none means a
 * plain sign-in.
 *
 * Membership stays the gate: whatever the intent, the login gets in only
 * with an active team_members row, and nobody is added by signing in, except
 * the first Owner of a fresh install through its own checks. A refused login
 * is signed out of this browser only (scope local), so its sessions in other
 * apps on a shared project carry on. Errors go back as a code, never as text
 * or an email in the address.
 */

function failurePath(intent: GoogleIntent, code: SignInErrorCode): string {
  switch (intent.kind) {
    case 'link': return `/settings/account?google=${code}`;
    case 'invite': return `${SET_PASSWORD_PATH}?token=${encodeURIComponent(intent.token)}&error=${code}`;
    case 'first-owner': return `${CREATE_ACCOUNT_PATH}?error=${code}`;
    default: return `/login?error=${code}`;
  }
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const cookieStore = await cookies();
  const intent = decodeGoogleIntent(cookieStore.get(GOOGLE_INTENT_COOKIE)?.value);
  // Read once: a second visit to this address is a plain sign-in.
  if (cookieStore.get(GOOGLE_INTENT_COOKIE)) cookieStore.set(GOOGLE_INTENT_COOKIE, '', { path: '/', maxAge: 0 });
  const go = (path: string) => NextResponse.redirect(new URL(path, origin));

  const code = searchParams.get('code');
  if (!code && !searchParams.has('error') && !searchParams.has('error_code')) {
    // Back from a password reset email: its tokens (or its error) ride after
    // the #, which never reaches the server and which the browser keeps
    // through this redirect, so the reset page reads them.
    return go(RESET_PASSWORD_PATH);
  }
  if (!code) {
    // Google or Supabase said no (cancelled, or that Google account already belongs to another login).
    const said = `${searchParams.get('error_code') ?? ''} ${searchParams.get('error_description') ?? ''}`;
    return go(failurePath(intent, /identity_already_exists|already linked|already been linked/i.test(said) ? 'google_in_use' : 'google_failed'));
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data?.user) return go(failurePath(intent, 'google_failed'));
  const user = data.user;
  const service = getServiceClient();
  const signOut = () => supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
  const refuse = async (failure: SignInErrorCode, as: GoogleIntent = intent) => {
    await signOut();
    return go(failurePath(as, failure));
  };

  /** Past the roster gate: the Google photo fills an empty avatar, then in. */
  const enter = async (path: string) => {
    if (!(await admitGoogleLogin(service, user))) return refuse('no_access', { kind: 'sign-in', next: null });
    return go(path);
  };

  switch (intent.kind) {
    case 'link':
      // Supabase linked Google to the signed-in login before sending them
      // here. The intent cookie could be made up, so Google must be allowed.
      if (!allowsGoogle(await signInMethodsOrDefault(service))) return refuse('google_off');
      return enter('/settings/account?google=linked');

    case 'first-owner':
      try {
        await claimFirstOwnerWithGoogle(service, { user, name: intent.name, setupCode: intent.setupCode, startedAt: intent.startedAt });
      } catch (claimError) {
        if (!(claimError instanceof FirstOwnerError)) console.error('[auth] first owner with Google failed:', claimError);
        const failure: SignInErrorCode = claimError instanceof FirstOwnerError
          ? claimError.message === ALREADY_OWNED ? 'owner_taken' : claimError.field === 'setup_code' ? 'owner_code' : 'owner_failed'
          : 'owner_failed';
        return refuse(failure);
      }
      return enter(WELCOME_PATH);

    case 'invite': {
      if (!allowsGoogle(await signInMethodsOrDefault(service))) return refuse('google_off');
      try {
        await acceptInviteWithGoogle(service, { token: intent.token, userId: user.id, googleEmail: googleIdentityOf(user)?.email ?? null });
      } catch (inviteError) {
        if (inviteError instanceof GoogleInviteError) return refuse(inviteError.code);
        console.error('[auth] invite with Google failed:', inviteError);
        return refuse('google_failed');
      }
      return enter('/dashboard');
    }

    default:
      if (!allowsGoogle(await signInMethodsOrDefault(service))) return refuse('google_off');
      return enter(intent.next ?? '/dashboard');
  }
}
