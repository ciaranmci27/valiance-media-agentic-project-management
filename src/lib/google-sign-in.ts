'use client';

import { createClient } from '@/lib/supabase/client';
import { AUTH_CALLBACK_PATH, type GoogleIntentKind } from '@/lib/sign-in';

/**
 * Leaves for Google from the browser: first tells the server what the round
 * trip is for (POST /api/auth/google, which checks what it can and keeps it
 * in a cookie), then hands over to Supabase (PKCE). Google always comes back
 * to /auth/callback, the one address allowed in Supabase. On success the
 * browser is already on its way; otherwise this answers the problem.
 */
export async function continueWithGoogle(
  intent: GoogleIntentKind,
  fields: Record<string, string | undefined> = {},
): Promise<{ error: string; field?: string } | null> {
  try {
    const response = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, ...fields }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { error: payload.error || 'Something went wrong. Try again.', ...(payload.field ? { field: payload.field } : {}) };
  } catch {
    return { error: 'Could not reach the server. Check your connection and try again.' };
  }
  const supabase = createClient();
  const options = { redirectTo: `${window.location.origin}${AUTH_CALLBACK_PATH}` };
  const { error } = intent === 'link'
    ? await supabase.auth.linkIdentity({ provider: 'google', options })
    : await supabase.auth.signInWithOAuth({ provider: 'google', options });
  return error ? { error: error.message || 'Google sign-in did not start. Try again.' } : null;
}
