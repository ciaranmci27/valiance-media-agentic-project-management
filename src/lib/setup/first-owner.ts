import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The first account on a fresh install: the setup wizard's "Create your
 * account" step, before anyone can sign in. A database with nobody on the
 * team has no Owner yet, so every visit goes to that step; the first account
 * made there becomes the Owner (pm.add_team_member, serialized by a lock so
 * two at once cannot both win). Once anyone is on the team the step is gone
 * for good: an Owner can never be the last to leave.
 *
 * On a Supabase project that already has logins (the app installed beside a
 * company's other apps), anyone with one of those logins, or anyone who can
 * sign up there, could otherwise claim Owner while the team is empty. So
 * there the step also needs the setup code the host holds (PM_SETUP_CODE),
 * and someone with an existing login may claim with it (password checked):
 * that login stays the other app's (login_owned false).
 *
 * The Owner may claim with Google instead: the setup code is checked first
 * (startFirstOwnerGoogle), then Google signs them in, then the claim binds to
 * that signed-in Google user and checks the code again
 * (claimFirstOwnerWithGoogle). The code rule is the same one: needed while
 * the project has other logins.
 */

export const CREATE_ACCOUNT_PATH = '/welcome/create-account';
export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 72;

export class FirstOwnerError extends Error {
  constructor(public status: number, message: string, public field?: 'name' | 'email' | 'password' | 'setup_code') {
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
  /** The host's PM_SETUP_CODE, needed where the project already has logins. */
  setupCode: string;
}

export const SETUP_CODE_ENV = 'PM_SETUP_CODE';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The name as it would be saved, or the problem with it. */
export function checkFirstOwnerName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new FirstOwnerError(422, 'Enter your name.', 'name');
  if (name.length > 100) throw new FirstOwnerError(422, 'Use at most 100 characters.', 'name');
  return name;
}

/** The fields as they would be saved, or the first problem with them. */
export function checkFirstOwnerInput(raw: { name?: unknown; email?: unknown; password?: unknown; setup_code?: unknown }): FirstOwnerInput {
  const name = checkFirstOwnerName(raw.name);
  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  const password = typeof raw.password === 'string' ? raw.password : '';
  if (!EMAIL.test(email)) throw new FirstOwnerError(422, 'Enter a valid email address.', 'email');
  if (password.length < MIN_PASSWORD) throw new FirstOwnerError(422, `Use at least ${MIN_PASSWORD} characters.`, 'password');
  if (password.length > MAX_PASSWORD) throw new FirstOwnerError(422, `Use at most ${MAX_PASSWORD} characters.`, 'password');
  const setupCode = typeof raw.setup_code === 'string' ? raw.setup_code.trim() : '';
  return { name, email, password, setupCode };
}

/** Constant-time comparison, so the code cannot be guessed a character at a time. */
function sameCode(given: string, expected: string): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * The setup code rule, for every way of claiming: on a project that already
 * has other logins, the host's PM_SETUP_CODE must be set and match.
 */
function requireSetupCode(env: Record<string, string | undefined>, given: string): void {
  const expected = env[SETUP_CODE_ENV]?.trim() ?? '';
  if (!expected) {
    throw new FirstOwnerError(409, `This Supabase project already has accounts, from other apps or from an earlier sign-in attempt. To claim the Owner account, add a setup code to your host as ${SETUP_CODE_ENV} (any long random text), redeploy, then enter it here.`, 'setup_code');
  }
  if (!sameCode(given, expected)) throw new FirstOwnerError(403, 'Enter the setup code from your host.', 'setup_code');
}

export interface FirstOwnerDeps {
  env?: Record<string, string | undefined>;
  /** Signs in with the email and password, to prove an existing login is theirs. */
  verifyPassword?: (email: string, password: string) => Promise<boolean>;
}

async function defaultVerifyPassword(email: string, password: string): Promise<boolean> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return false;
  const { createPmClient } = await import('@/lib/supabase/pm-client');
  const client = createPmClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (data?.session) await client.auth.signOut().catch(() => undefined);
  return !error && !!data?.user;
}

async function addOwner(service: SupabaseClient, authUserId: string, input: Pick<FirstOwnerInput, 'name' | 'email'>, loginOwned: boolean): Promise<void> {
  const { error } = await service.rpc('add_team_member', {
    p_auth_user_id: authUserId, p_email: input.email, p_name: input.name, p_role: 'owner', p_login_owned: loginOwned, p_first_owner: true,
  });
  if (!error) return;
  if (/already has an Owner/i.test(error.message ?? '') || error.code === 'P0001') throw new FirstOwnerError(409, ALREADY_OWNED);
  throw new FirstOwnerError(500, error.message || 'Could not make you the Owner. Try again.');
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
export async function createFirstOwner(
  service: SupabaseClient,
  raw: { name?: unknown; email?: unknown; password?: unknown; setup_code?: unknown },
  deps: FirstOwnerDeps = {},
): Promise<{ email: string }> {
  const env = deps.env ?? process.env;
  const input = checkFirstOwnerInput(raw);
  const needs = await needsFirstOwner(service);
  if (needs === null) throw new FirstOwnerError(503, 'Could not reach the database. Check its settings and try again.');
  if (!needs) throw new FirstOwnerError(409, ALREADY_OWNED);

  // A project that already has logins (other apps): the host's setup code first.
  const { data: loginsExist, error: loginsError } = await service.rpc('logins_exist');
  if (loginsError) throw new FirstOwnerError(503, 'Could not reach the database. Check its settings and try again.');
  if (loginsExist === true) {
    requireSetupCode(env, input.setupCode);
    // Someone who already has a login here claims with it, password checked.
    const { data: existing } = await service.rpc('login_for_email', { p_email: input.email });
    if (typeof existing === 'string') {
      if (!(await (deps.verifyPassword ?? defaultVerifyPassword)(input.email, input.password))) {
        throw new FirstOwnerError(403, 'That email already has an account here. Enter its password to claim the Owner account with it.', 'password');
      }
      await addOwner(service, existing, input, false);
      teamKnown = true;
      return { email: input.email };
    }
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: input.email,
    password: input.password,
    email_confirm: true,
    // Installs from before 2.0 still have the sign-up trigger: this mark (in
    // the row it sees) makes it refuse a second Owner. Fresh installs ignore it.
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

  try {
    await addOwner(service, created.user.id, input, true);
  } catch (error) {
    // Someone else became the Owner first: the login just made is not needed.
    await service.auth.admin.deleteUser(created.user.id).catch(() => undefined);
    throw error;
  }
  teamKnown = true;
  return { email: input.email };
}

// ── Claiming with Google ────────────────────────────────────────────────

const DB_UNREACHABLE = 'Could not reach the database. Check its settings and try again.';

/**
 * Before leaving for Google: the name, that nobody owns the workspace yet,
 * and the setup code where the project already has logins, by the same
 * rule as the password path. Answers what the claim needs after Google.
 */
export async function startFirstOwnerGoogle(
  service: SupabaseClient,
  raw: { name?: unknown; setup_code?: unknown },
  deps: Pick<FirstOwnerDeps, 'env'> = {},
): Promise<{ name: string; setupCode: string }> {
  const env = deps.env ?? process.env;
  const name = checkFirstOwnerName(raw.name);
  const setupCode = typeof raw.setup_code === 'string' ? raw.setup_code.trim() : '';
  const needs = await needsFirstOwner(service);
  if (needs === null) throw new FirstOwnerError(503, DB_UNREACHABLE);
  if (!needs) throw new FirstOwnerError(409, ALREADY_OWNED);
  const { data: loginsExist, error } = await service.rpc('logins_exist');
  if (error) throw new FirstOwnerError(503, DB_UNREACHABLE);
  if (loginsExist === true) requireSetupCode(env, setupCode);
  return { name, setupCode };
}

/** How long after leaving for Google a login still counts as one this claim made. */
const GOOGLE_ROUND_TRIP_MS = 15 * 60 * 1000;

/**
 * After Google signed them in: binds the Owner to that signed-in Google
 * user. The code is checked again here, against the project's other logins
 * (the Google sign-in itself may just have made this one), so skipping the
 * first step gets nothing. A login made during this round trip is the
 * app's own (login_owned true); one that existed before is another app's.
 * Google stays on for sign-in afterwards (both methods), or the new Owner
 * could not sign in again.
 */
export async function claimFirstOwnerWithGoogle(
  service: SupabaseClient,
  input: { user: { id: string; email?: string | null; created_at?: string | null }; name: unknown; setupCode: unknown; startedAt: number; now?: number },
  deps: Pick<FirstOwnerDeps, 'env'> = {},
): Promise<{ email: string }> {
  const env = deps.env ?? process.env;
  const now = input.now ?? Date.now();
  const name = checkFirstOwnerName(input.name);
  const email = (input.user.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new FirstOwnerError(422, 'Google did not share an email address.', 'email');
  const needs = await needsFirstOwner(service);
  if (needs === null) throw new FirstOwnerError(503, DB_UNREACHABLE);
  if (!needs) throw new FirstOwnerError(409, ALREADY_OWNED);
  const { data: others, error } = await service.rpc('other_logins_exist', { p_user: input.user.id });
  if (error) throw new FirstOwnerError(503, DB_UNREACHABLE);
  if (others === true) requireSetupCode(env, typeof input.setupCode === 'string' ? input.setupCode.trim() : '');
  const createdAt = input.user.created_at ? Date.parse(input.user.created_at) : NaN;
  const fresh = Number.isFinite(input.startedAt) && now - input.startedAt <= GOOGLE_ROUND_TRIP_MS
    && Number.isFinite(createdAt) && createdAt >= input.startedAt - 5000;
  // Google stays on first: an Owner made with Google could not sign in again
  // on a password-only workspace. If the claim then fails, it goes back.
  const previous = await keepGoogleOn(service);
  try {
    await addOwner(service, input.user.id, { name, email }, fresh);
  } catch (error) {
    if (previous !== null) await service.from('business_settings').update({ sign_in_methods: previous }).eq('sign_in_methods', 'both');
    throw error;
  }
  teamKnown = true;
  return { email };
}

const GOOGLE_STAYS_ON = 'Could not keep Google sign-in on for you. Try again.';

/** Sets the sign-in methods to both, answering what they were (null if already both). Fails the claim if it cannot. */
async function keepGoogleOn(service: SupabaseClient): Promise<string | null> {
  const { data: row, error: readError } = await service.from('business_settings').select('id, sign_in_methods').limit(1).maybeSingle();
  if (readError) throw new FirstOwnerError(500, GOOGLE_STAYS_ON);
  const current = (row as { id: string; sign_in_methods?: string } | null);
  if (current?.sign_in_methods === 'both') return null;
  const { error } = current
    ? await service.from('business_settings').update({ sign_in_methods: 'both' }).eq('id', current.id)
    : await service.from('business_settings').insert({ sign_in_methods: 'both' });
  if (error) throw new FirstOwnerError(500, GOOGLE_STAYS_ON);
  return current?.sign_in_methods ?? 'password';
}
