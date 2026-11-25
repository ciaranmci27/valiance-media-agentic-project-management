import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  accountChangeRefusal, DEFAULT_SIGN_IN_METHODS, OWNER_LINK_GOOGLE_FIRST, OWNER_SET_PASSWORD_FIRST, parseSignInMethods, SIGN_IN_METHODS, strandedSummary,
  type AccountChange, type AccountFacts, type AccountSignInView, type GoogleProviderState, type SignInMethods, type SignInReach, type StrandedSummary,
} from '@/lib/sign-in';
import { resolveMemberAccess } from './access';
import { ApiError } from './errors';

/**
 * Sign-in methods on the server: the workspace setting
 * (business_settings.sign_in_methods), whether Google is on in Supabase, the
 * roster gate every Google sign-in passes, and the facts behind a member's
 * own sign-in (Settings > Account). Rules are in src/lib/sign-in.ts.
 */

const missingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (['42703', 'PGRST204', '42P01', 'PGRST205'].includes(error.code ?? '') || /does not exist|schema cache/i.test(error.message ?? ''));

export interface SignInMethodsState {
  methods: SignInMethods;
  /** The migration has run (the column is there). Before it, the default applies. */
  ready: boolean;
}

export async function readSignInMethods(service: SupabaseClient): Promise<SignInMethodsState> {
  const { data, error } = await service.from('business_settings').select('sign_in_methods').limit(1).maybeSingle();
  if (error) {
    if (missingColumn(error)) return { methods: DEFAULT_SIGN_IN_METHODS, ready: false };
    throw error;
  }
  return { methods: parseSignInMethods((data as { sign_in_methods?: unknown } | null)?.sign_in_methods), ready: true };
}

/** For the signed-out pages: the setting, or the default when it cannot be read. */
export async function signInMethodsOrDefault(service: SupabaseClient): Promise<SignInMethods> {
  try {
    return (await readSignInMethods(service)).methods;
  } catch {
    return DEFAULT_SIGN_IN_METHODS;
  }
}

export const LINK_GOOGLE_FIRST = OWNER_LINK_GOOGLE_FIRST;
export const SET_PASSWORD_FIRST_OWNER = OWNER_SET_PASSWORD_FIRST;

/**
 * Owner only (the route checks the role): change how people sign in. The
 * Owner must keep a way in themselves: Google only needs their own Google
 * linked, and email and password only needs a password of their own. Others
 * left with no way in are shown before saving, not refused
 * (strandedByMethods). Written as the Owner, so the audit log says who.
 */
export async function setSignInMethods(service: SupabaseClient, owner: { authUserId: string }, methods: SignInMethods): Promise<SignInMethodsState> {
  if (methods !== 'both') {
    const own = await loginFacts(service, owner.authUserId);
    if (methods === 'google' && !own.googleLinked) throw new ApiError(409, 'CONFLICT', LINK_GOOGLE_FIRST, { reason: 'link_google_first' });
    if (methods === 'password' && !own.hasPassword) throw new ApiError(409, 'CONFLICT', SET_PASSWORD_FIRST_OWNER, { reason: 'set_password_first' });
  }
  const { data: row, error: readError } = await service.from('business_settings').select('id').limit(1).maybeSingle();
  if (readError) throw readError;
  if (!row) throw new ApiError(409, 'CONFLICT', 'The workspace settings row is missing. Finish setup first.');
  const { error } = await service.from('business_settings').update({ sign_in_methods: methods }).eq('id', (row as { id: string }).id);
  if (error) {
    if (missingColumn(error)) throw new ApiError(409, 'MIGRATION_REQUIRED', 'Run the latest database migration first.', { reason: 'migration_required' });
    throw error;
  }
  return readSignInMethods(service);
}

/**
 * For each choice, the people it would leave with no way in: active people on
 * the team who have signed in, from their logins (pm.member_sign_in_reach:
 * a password, Google linked). Null before the migration.
 */
export async function strandedByMethods(service: SupabaseClient): Promise<Record<SignInMethods, StrandedSummary> | null> {
  const { data, error } = await service.rpc('member_sign_in_reach');
  if (error) {
    if (missingColumn(error) || error.code === 'PGRST202' || error.code === '42883') return null;
    throw error;
  }
  const people = ((data ?? []) as SignInReach[]).map((row) => ({ name: row.name, has_password: row.has_password === true, has_google: row.has_google === true }));
  return Object.fromEntries(SIGN_IN_METHODS.map((methods) => [methods, strandedSummary(people, methods)])) as Record<SignInMethods, StrandedSummary>;
}

// ── Is Google on in Supabase? ───────────────────────────────────────────

const PROVIDER_TTL_MS = 60_000;
let providerCache: { at: number; state: GoogleProviderState } | null = null;

/** For tests: forget the cached answer. */
export function resetGoogleProviderCache(): void {
  providerCache = null;
}

/**
 * Whether the Google provider is on in the Supabase project, from its public
 * auth settings (the same answer any browser gets with the public key).
 * Cached for a minute; unknown when it cannot be read, and then the app
 * carries on as if it were on.
 */
export async function googleProviderState(env: Record<string, string | undefined> = process.env): Promise<GoogleProviderState> {
  if (providerCache && Date.now() - providerCache.at < PROVIDER_TTL_MS) return providerCache.state;
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anon) return 'unknown';
  let state: GoogleProviderState = 'unknown';
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/settings`, { headers: { apikey: anon }, cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (response.ok) {
      const body = await response.json() as { external?: Record<string, unknown> };
      if (body.external && typeof body.external === 'object') state = body.external.google === true ? 'on' : 'off';
    }
  } catch {
    state = 'unknown';
  }
  providerCache = { at: Date.now(), state };
  return state;
}

// ── The roster gate ─────────────────────────────────────────────────────

/**
 * The member a login signs in as, or null when it may not use the app: only
 * an active team_members row counts, read the way every signed-in request
 * reads it (resolveMemberAccess). A Google sign-in passes here before it gets
 * in; nobody is ever added to the team by signing in.
 */
export async function activeMemberId(service: SupabaseClient, authUserId: string): Promise<string | null> {
  const { data, error } = await service.from('team_members').select('id').eq('auth_user_id', authUserId).maybeSingle();
  if (error || !data) return null;
  const memberId = (data as { id: string }).id;
  const access = await resolveMemberAccess(service, memberId);
  return access?.status === 'active' ? memberId : null;
}

// ── A login's facts ─────────────────────────────────────────────────────

/** The Google identity on a Supabase user, with the email Google gave, or null. */
export function googleIdentityOf(user: Pick<User, 'identities'> | null | undefined): { id: string; email: string | null } | null {
  const identity = user?.identities?.find((item) => item.provider === 'google');
  if (!identity) return null;
  const email = typeof identity.identity_data?.email === 'string' ? identity.identity_data.email : null;
  return { id: identity.identity_id ?? identity.id, email };
}

export interface LoginFacts {
  email: string | null;
  hasPassword: boolean;
  googleLinked: boolean;
  googleEmail: string | null;
}

export async function loginFacts(service: SupabaseClient, authUserId: string): Promise<LoginFacts> {
  const [{ data: userData, error: userError }, { data: hasPassword, error: passwordError }] = await Promise.all([
    service.auth.admin.getUserById(authUserId),
    service.rpc('login_has_password', { p_user: authUserId }),
  ]);
  if (userError || !userData?.user) throw new ApiError(500, 'INTERNAL_ERROR', 'Could not read your account. Try again.');
  if (passwordError) {
    if (missingColumn(passwordError) || passwordError.code === 'PGRST202' || passwordError.code === '42883') {
      throw new ApiError(409, 'MIGRATION_REQUIRED', 'Run the latest database migration first.', { reason: 'migration_required' });
    }
    throw passwordError;
  }
  const google = googleIdentityOf(userData.user);
  return { email: userData.user.email ?? null, hasPassword: hasPassword === true, googleLinked: !!google, googleEmail: google?.email ?? null };
}

/** The facts the rules need for this member: their login, whether PM made it, and the workspace setting. */
export async function accountFacts(service: SupabaseClient, member: { memberId: string; authUserId: string }): Promise<{ facts: AccountFacts; login: LoginFacts }> {
  const [login, methods, owned] = await Promise.all([
    loginFacts(service, member.authUserId),
    readSignInMethods(service),
    service.from('team_members').select('login_owned').eq('id', member.memberId).maybeSingle(),
  ]);
  if (owned.error) throw owned.error;
  const loginOwned = (owned.data as { login_owned?: boolean } | null)?.login_owned !== false;
  return { facts: { loginOwned, hasPassword: login.hasPassword, googleLinked: login.googleLinked, methods: methods.methods }, login };
}

const CHANGES: AccountChange[] = ['set_password', 'change_email', 'link_google', 'unlink_google'];

export async function accountSignInView(service: SupabaseClient, member: { memberId: string; authUserId: string }): Promise<AccountSignInView> {
  const [{ facts, login }, provider] = await Promise.all([accountFacts(service, member), googleProviderState()]);
  return {
    methods: facts.methods,
    google_provider: provider,
    email: login.email,
    login_owned: facts.loginOwned,
    has_password: facts.hasPassword,
    google: { linked: facts.googleLinked, email: login.googleEmail },
    refusals: Object.fromEntries(CHANGES.map((change) => [change, accountChangeRefusal(facts, change)])) as AccountSignInView['refusals'],
  };
}

/** 409 with the rule's words unless the change is allowed. */
export async function assertAccountChange(service: SupabaseClient, member: { memberId: string; authUserId: string }, change: AccountChange): Promise<AccountFacts> {
  const { facts } = await accountFacts(service, member);
  const refusal = accountChangeRefusal(facts, change);
  if (refusal) throw new ApiError(409, 'CONFLICT', refusal, { reason: change });
  return facts;
}

// ── The Google photo ────────────────────────────────────────────────────

/**
 * The photo Google gave for this login: user_metadata.avatar_url, else
 * picture, else the Google identity's own. Only an https address counts.
 */
export function googlePhotoOf(user: Pick<User, 'user_metadata' | 'identities'> | null | undefined): string | null {
  const identity = user?.identities?.find((item) => item.provider === 'google')?.identity_data ?? {};
  const candidates = [user?.user_metadata?.avatar_url, user?.user_metadata?.picture, identity.avatar_url, identity.picture];
  for (const value of candidates) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length <= 2048 && /^https:\/\/[^\s]+$/i.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Gives a member the Google photo only while they have no avatar at all
 * (team_members.avatar is ''). The emptiness check is in the same UPDATE, so
 * a photo the member set is never replaced, whatever it is, even if it
 * happens to be the Google address. Answers whether it filled one.
 */
export async function fillAvatarFromGoogle(service: SupabaseClient, memberId: string, user: Pick<User, 'user_metadata' | 'identities'>): Promise<boolean> {
  const photo = googlePhotoOf(user);
  if (!photo) return false;
  const { data, error } = await service.from('team_members').update({ avatar: photo }).eq('id', memberId).eq('avatar', '').select('id');
  if (error) return false;
  return (data ?? []).length > 0;
}

/**
 * A Google sign-in coming in (the callback, after any invite or first-owner
 * step): the roster gate, then the Google photo into an empty avatar.
 * Answers the member it signs in as, or null to refuse.
 */
export async function admitGoogleLogin(service: SupabaseClient, user: Pick<User, 'id' | 'user_metadata' | 'identities'>): Promise<string | null> {
  const memberId = await activeMemberId(service, user.id);
  if (memberId) await fillAvatarFromGoogle(service, memberId, user);
  return memberId;
}
