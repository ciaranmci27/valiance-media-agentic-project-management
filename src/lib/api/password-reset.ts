import type { SupabaseClient } from '@supabase/supabase-js';
import { AUTH_CALLBACK_PATH, allowsPassword } from '@/lib/sign-in';
import { activeMemberId, signInMethodsOrDefault } from './sign-in';

/**
 * Forgot password. Whoever asks gets the same answer (RESET_SENT), and the
 * work happens after the response, so neither the words, the status nor the
 * time taken says whether an account exists.
 *
 * Supabase sends the reset email (resetPasswordForEmail), only for a
 * confirmed login with an active member row, and only while this workspace
 * offers passwords. The link comes back through /auth/callback, the one
 * address allowed in Supabase, and on to the reset page, which signs the
 * person in from the link and then asks the server what to show. A login
 * another app made also gets the link: once it has proved the inbox is
 * theirs, the page says to use Google or that app's reset, and the password
 * route refuses it (login_owned false), so PM never sets its password.
 *
 * The link uses the implicit flow (tokens after #), not PKCE, so it works on
 * whichever device opens the email, and this request sets no cookie.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ResetDeps {
  /** Asks Supabase to send the reset email. */
  send?: (email: string, redirectTo: string) => Promise<void>;
}

async function supabaseSend(email: string, redirectTo: string): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return;
  const { createPmClient } = await import('@/lib/supabase/pm-client');
  const client = createPmClient(url, anon, { auth: { flowType: 'implicit', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

/** Sends a reset link when this email belongs to someone on the team; otherwise does nothing. Never says which. */
export async function sendPasswordReset(service: SupabaseClient, input: { email: unknown; appUrl: string }, deps: ResetDeps = {}): Promise<boolean> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 320) return false;
  if (!allowsPassword(await signInMethodsOrDefault(service))) return false;
  // A confirmed login only: an unconfirmed one may be someone else's sign-up under this address.
  const { data: login, error } = await service.rpc('login_for_email', { p_email: email, p_confirmed_only: true });
  if (error || typeof login !== 'string') return false;
  if (!(await activeMemberId(service, login))) return false;
  await (deps.send ?? supabaseSend)(email, `${input.appUrl.replace(/\/+$/, '')}${AUTH_CALLBACK_PATH}`);
  return true;
}
