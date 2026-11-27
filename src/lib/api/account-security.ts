import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './errors';

/**
 * Changing how you sign in (your own email or password) needs proof that it
 * is you, not just a session someone borrowed (deep security review of
 * 2.0.50, finding 7):
 *
 * - An account with a password types its current password.
 * - Right after a reset or invite link (a session that signed in by link in
 *   the last FRESH_SIGN_IN_MINUTES), the link is the proof: that is how a
 *   person who forgot their password sets a new one.
 * - An account without a password (Google only) signs in again first; a
 *   sign-in in the last FRESH_SIGN_IN_MINUTES counts.
 *
 * After the change, other sessions are signed out and the old address gets a
 * notice, so a takeover never goes unseen.
 */

export const FRESH_SIGN_IN_MINUTES = 10;

/** Sign-ins that came from a link sent to the address itself. */
const LINK_METHODS = new Set(['recovery', 'otp', 'magiclink', 'invite', 'email/signup', 'email_change']);

export interface SessionSignIn {
  method: string;
  /** Seconds since the epoch. */
  at: number;
}

/** The session's most recent sign-in, from its token's amr claim, or null. */
export function latestSignIn(claims: { amr?: unknown } | null | undefined): SessionSignIn | null {
  const amr = Array.isArray(claims?.amr) ? claims.amr : [];
  let latest: SessionSignIn | null = null;
  for (const entry of amr) {
    const method = typeof entry?.method === 'string' ? entry.method : null;
    const at = Number(entry?.timestamp);
    if (!method || !Number.isFinite(at)) continue;
    if (!latest || at > latest.at) latest = { method, at };
  }
  return latest;
}

export type ChangeProof = 'ok' | 'wrong_password' | 'current_password_required' | 'fresh_sign_in_required';

/** The rule in one place: may this change go ahead, and if not, what is missing. */
export function changeProof(input: { hasPassword: boolean; signIn: SessionSignIn | null; passwordOk?: boolean; now?: number }): ChangeProof {
  if (input.passwordOk === true) return 'ok';
  if (input.passwordOk === false) return 'wrong_password';
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const fresh = !!input.signIn && now - input.signIn.at <= FRESH_SIGN_IN_MINUTES * 60 && input.signIn.at <= now + 60;
  if (fresh && LINK_METHODS.has(input.signIn!.method)) return 'ok';
  if (!input.hasPassword) return fresh ? 'ok' : 'fresh_sign_in_required';
  return 'current_password_required';
}

export const PROOF_WORDS: Record<Exclude<ChangeProof, 'ok'>, string> = {
  wrong_password: 'That is not your current password.',
  current_password_required: 'Enter your current password to make this change.',
  fresh_sign_in_required: `For your safety, sign out and sign in again, then make this change within ${FRESH_SIGN_IN_MINUTES} minutes.`,
};

/** How the signed-in session last signed in, read from its own token. */
export async function readSessionSignIn(sessionClient: SupabaseClient): Promise<SessionSignIn | null> {
  try {
    const { data } = await sessionClient.auth.getClaims();
    return latestSignIn((data?.claims as { amr?: unknown } | undefined) ?? null);
  } catch {
    return null;
  }
}

/**
 * Whether this is the account's password: a sign-in on a throwaway client
 * that keeps nothing, and that session is ended at once.
 */
export async function passwordMatches(email: string, password: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon || !email || !password) return false;
  const probe = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { data, error } = await probe.auth.signInWithPassword({ email, password });
  if (error || !data.session) return false;
  await probe.auth.signOut({ scope: 'local' }).catch(() => undefined);
  return true;
}

/** Throws 403 with the plain reason unless the person proved it is them. */
export async function confirmItIsYou(input: {
  sessionClient: SupabaseClient;
  email: string | null;
  hasPassword: boolean;
  currentPassword?: string | null;
}): Promise<void> {
  const signIn = await readSessionSignIn(input.sessionClient);
  const passwordOk = input.currentPassword
    ? (input.hasPassword && !!input.email ? await passwordMatches(input.email, input.currentPassword) : false)
    : undefined;
  const proof = changeProof({ hasPassword: input.hasPassword, signIn, passwordOk });
  if (proof === 'ok') return;
  throw new ApiError(403, 'FORBIDDEN', PROOF_WORDS[proof], {
    reason: proof,
    ...(proof === 'fresh_sign_in_required' ? {} : { fields: { current_password: PROOF_WORDS[proof] } }),
  });
}

/** Signs out every other session of this login; the one making the change stays. */
export async function signOutOtherSessions(sessionClient: SupabaseClient): Promise<void> {
  try {
    await sessionClient.auth.signOut({ scope: 'others' });
  } catch (error) {
    console.error('[account] could not sign out other sessions', error);
  }
}

/**
 * Tells the address a change is about. Sent to the old address for an email
 * change. Never blocks the change: with no mail set up, it is logged.
 */
export async function sendAccountNotice(input: {
  to: string | null;
  change: 'email' | 'password';
  newEmail?: string;
  byOther?: string | null;
}): Promise<void> {
  if (!input.to) return;
  try {
    const [{ sendTransactional }, { buildNotificationEmail }, { getBrand }] = await Promise.all([
      import('@/lib/email/send-mail'),
      import('@/lib/email/templates/team/notification'),
      import('@/lib/brand/server'),
    ]);
    const brand = await getBrand();
    const title = input.change === 'email' ? 'Your sign-in email was changed' : 'Your password was changed';
    const message = input.change === 'email'
      ? `${input.byOther ? `${input.byOther} changed the email you sign in with` : 'The email you sign in with was changed'} to ${input.newEmail}. If this was you, there is nothing to do. If not, ask an Owner of your workspace to change it back right away.`
      : 'Your password was changed and your other devices were signed out. If this was you, there is nothing to do. If not, reset your password from the sign-in page and tell an Owner of your workspace.';
    const { html, text } = buildNotificationEmail({ brand, title, message });
    const result = await sendTransactional({ to: input.to, subject: title, html, text });
    if (!result.success) console.error('[account] notice not sent:', result.error);
  } catch (error) {
    console.error('[account] notice not sent', error);
  }
}
