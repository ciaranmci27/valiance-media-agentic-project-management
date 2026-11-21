import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The first account on a fresh install: the setup wizard's "Create your
 * account" step, before anyone can sign in. A database with nobody on the
 * team has no Owner yet, so every visit goes to that step; the first account
 * made there becomes the Owner (the signup trigger, serialized by a lock so
 * two at once cannot both win). Once anyone is on the team the step is gone
 * for good: an Owner can never be the last to leave.
 */

export const CREATE_ACCOUNT_PATH = '/welcome/create-account';
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72;

export class FirstOwnerError extends Error {
  constructor(public status: number, message: string, public field?: 'name' | 'email' | 'password') {
    super(message);
  }
}

export const ALREADY_OWNED = 'This workspace already has an Owner. Sign in instead.';

// A team never goes back to empty, so "someone is on it" is remembered for
// the life of this server instance and the check stops costing a query.
let teamKnown = false;

/** For tests: forget what this instance has seen. */
export function resetFirstOwnerCache(): void {
  teamKnown = false;
}

/** True while nobody is on the team; null when the database could not say (callers then carry on as usual). */
export async function needsFirstOwner(service: SupabaseClient): Promise<boolean | null> {
  if (teamKnown) return false;
  const { count, error } = await service.from('team_members').select('id', { count: 'exact', head: true });
  if (error || count === null) return null;
  if (count > 0) {
    teamKnown = true;
    return false;
  }
  return true;
}

export interface FirstOwnerInput {
  name: string;
  email: string;
  password: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The fields as they would be saved, or the first problem with them. */
export function checkFirstOwnerInput(raw: { name?: unknown; email?: unknown; password?: unknown }): FirstOwnerInput {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (!name) throw new FirstOwnerError(422, 'Enter your name.', 'name');
  if (name.length > 100) throw new FirstOwnerError(422, 'Use at most 100 characters.', 'name');
  if (!EMAIL.test(email)) throw new FirstOwnerError(422, 'Enter a valid email address.', 'email');
  if (password.length < MIN_PASSWORD) throw new FirstOwnerError(422, `Use at least ${MIN_PASSWORD} characters.`, 'password');
  if (password.length > MAX_PASSWORD) throw new FirstOwnerError(422, `Use at most ${MAX_PASSWORD} characters.`, 'password');
  return { name, email, password };
}

/**
 * Makes the Owner account and returns the email to sign in with. The account
 * is confirmed at once (no email needed: sending may not be set up yet) and
 * marked as the wizard's (user_metadata first_owner: anyone could set it,
 * harmlessly, since the mark can only get an account refused).
 * The signup trigger makes it the Owner, or refuses it outright if anyone
 * joined the team in the meantime: then the whole sign-up rolls back,
 * nothing is left behind, and this answers 409. So once createUser succeeds
 * the account is the Owner, with the name given, and there is nothing to
 * read back or undo.
 */
export async function createFirstOwner(service: SupabaseClient, raw: { name?: unknown; email?: unknown; password?: unknown }): Promise<{ email: string }> {
  const input = checkFirstOwnerInput(raw);
  const needs = await needsFirstOwner(service);
  if (needs === null) throw new FirstOwnerError(503, 'Could not reach the database. Check its settings and try again.');
  if (!needs) throw new FirstOwnerError(409, ALREADY_OWNED);

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    // In the row the signup trigger sees (app_metadata is written after it).
    user_metadata: { display_name: input.name, first_owner: true },
  });
  if (createError || !created?.user) {
    const message = createError?.message?.toLowerCase() ?? '';
    if (message.includes('already been registered') || message.includes('already exists')) {
      throw new FirstOwnerError(409, 'An account with this email already exists. Sign in instead.', 'email');
    }
    if (message.includes('password')) throw new FirstOwnerError(422, createError!.message, 'password');
    // The trigger refusing (someone else was first) reaches here as a generic
    // database error: ask again, now that it would know.
    if ((await needsFirstOwner(service)) === false) throw new FirstOwnerError(409, ALREADY_OWNED);
    throw new FirstOwnerError(500, createError?.message || 'Could not create the account. Try again.');
  }

  teamKnown = true;
  return { email: input.email };
}
