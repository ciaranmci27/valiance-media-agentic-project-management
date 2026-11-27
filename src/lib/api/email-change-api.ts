import { z } from 'zod';
import { ApiError } from './errors';
import { changeProof, passwordMatches } from './account-security';
import type { LoginFacts } from './sign-in';
import { EmailChangeError } from '@/lib/team/email-change';

/** A sign-in email change over the API: its body, its proof and its refusals as ApiErrors. */

export const newEmail = z.string().trim().toLowerCase().email('Invalid email address').max(320);

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 500: 'INTERNAL_ERROR' };

export function emailChangeRefusal(error: unknown): unknown {
  return error instanceof EmailChangeError
    ? new ApiError(error.status, CODES[error.status] ?? 'INTERNAL_ERROR', error.message, { reason: error.reason })
    : error;
}

/**
 * Proof it is you, over the API: your current password (a key has no
 * sign-in of its own to count as fresh). An account with no password
 * (Google only) changes its email in the app, after signing in again.
 */
export async function provePasswordOverApi(login: LoginFacts, currentPassword: string | undefined): Promise<void> {
  if (!login.hasPassword) {
    throw new ApiError(403, 'FORBIDDEN', 'Your account signs in without a password, so change your email in the app (Settings > Account) after signing in again.', { reason: 'fresh_sign_in_required' });
  }
  const passwordOk = currentPassword && login.email ? await passwordMatches(login.email, currentPassword) : undefined;
  const proof = changeProof({ hasPassword: true, signIn: null, passwordOk });
  if (proof === 'ok') return;
  throw new ApiError(403, 'FORBIDDEN', proof === 'wrong_password' ? 'That is not your current password.' : 'Send your current password to change your sign-in email.', {
    reason: proof, fields: { current_password: proof === 'wrong_password' ? 'That is not your current password.' : 'Required' },
  });
}
