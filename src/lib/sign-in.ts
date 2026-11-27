import { NOT_OUR_LOGIN } from '@/lib/team/invite-rules';

/**
 * How people sign in: email and password, Google, or both. An Owner picks it
 * in Settings > Workspace (business_settings.sign_in_methods). The default is
 * both, and the sign-in page shows Google only while the Google provider is
 * really on in Supabase, so an install without it sees email and password as
 * before. Either way, only an active team member gets in: a Google sign-in
 * never adds anyone to the team. The setting decides what the sign-in and
 * invite pages offer; it is not checked on every request.
 *
 * The rules here are pure, shared by the sign-in page, the settings screens
 * and the server (src/lib/api/sign-in.ts).
 */

export const SIGN_IN_METHODS = ['password', 'google', 'both'] as const;
export type SignInMethods = (typeof SIGN_IN_METHODS)[number];

/** Existing installs and fresh ones: both, with Google shown only while it is on in Supabase. */
export const DEFAULT_SIGN_IN_METHODS: SignInMethods = 'both';

export const SIGN_IN_METHOD_LABELS: Record<SignInMethods, string> = {
  password: 'Email and password',
  google: 'Google only',
  both: 'Email and password, or Google',
};

/** A stored value as a known setting; anything else reads as the default. */
export function parseSignInMethods(value: unknown): SignInMethods {
  return (SIGN_IN_METHODS as readonly unknown[]).includes(value) ? (value as SignInMethods) : DEFAULT_SIGN_IN_METHODS;
}

export const allowsPassword = (methods: SignInMethods) => methods !== 'google';
export const allowsGoogle = (methods: SignInMethods) => methods !== 'password';

/** Whether Google sign-in is turned on in the Supabase project (auth settings), or unknown when it could not be read. */
export type GoogleProviderState = 'on' | 'off' | 'unknown';

/**
 * What the sign-in page shows. Google only while the setting allows it and
 * the provider is known to be on in Supabase, so there is never a Google
 * button that cannot work; the password form whenever the setting allows
 * it, and also when Google cannot be offered, so the page never shows no
 * way in at all.
 */
export function signInChoices(methods: SignInMethods, provider: GoogleProviderState): { password: boolean; google: boolean } {
  const google = allowsGoogle(methods) && provider === 'on';
  return { google, password: allowsPassword(methods) || !google };
}

// ── Who a change of methods would leave out ─────────────────────────────

/** One person on the team and the ways their login can sign in. */
export interface SignInReach {
  name: string;
  has_password: boolean;
  has_google: boolean;
}

/** How many names a warning lists before it gives only the count. */
export const STRANDED_NAME_LIMIT = 5;

export interface StrandedSummary {
  count: number;
  /** The first few, by name; all of them while there are only a few. */
  names: string[];
}

/** Whether this person could still sign in with these methods. */
export function canSignInWith(person: Pick<SignInReach, 'has_password' | 'has_google'>, methods: SignInMethods): boolean {
  return (allowsPassword(methods) && person.has_password) || (allowsGoogle(methods) && person.has_google);
}

/** The people these methods would leave with no way in. */
export function strandedSummary(people: SignInReach[], methods: SignInMethods): StrandedSummary {
  const left = people.filter((person) => !canSignInWith(person, methods));
  return { count: left.length, names: left.slice(0, STRANDED_NAME_LIMIT).map((person) => person.name) };
}

/** One plain line: who would have no way in, named while there are only a few. */
export function strandedLine(summary: StrandedSummary, methods: SignInMethods): string | null {
  if (summary.count === 0) return null;
  const why = methods === 'password'
    ? 'they joined with Google and have no password'
    : methods === 'google' ? 'they have no Google account linked' : 'they have neither a password nor Google';
  if (summary.count <= STRANDED_NAME_LIMIT) {
    const count = summary.count === 1 ? '1 person' : `${summary.count} people`;
    return `${count} would have no way in (${summary.names.join(', ')}): ${why}.`;
  }
  return `${summary.count} people would have no way in, including ${summary.names.join(', ')}: ${why}.`;
}

/** Why an Owner may not choose these methods yet: they would lock themselves out. */
export const OWNER_LINK_GOOGLE_FIRST = 'Link Google to your own account first (Settings > Account), so you can still sign in.';
export const OWNER_SET_PASSWORD_FIRST = 'Set a password for your own account first (Settings > Account), so you can still sign in.';

/** Why a Google choice cannot be picked yet: Google is off in Supabase. */
export const GOOGLE_PROVIDER_OFF = 'Google is off in Supabase. Turn it on in Authentication > Providers > Google, and add the redirect address below to Authentication > URL Configuration.';

/**
 * Why an Owner cannot pick these methods right now, or null when they can:
 * a Google choice while Google is off in Supabase, or a choice that would
 * lock the Owner out (Google only without their own Google, email and
 * password only without their own password).
 */
export function methodUnavailable(
  methods: SignInMethods,
  facts: { provider: GoogleProviderState; ownGoogle: boolean; ownPassword: boolean },
): string | null {
  if (allowsGoogle(methods) && facts.provider === 'off') return GOOGLE_PROVIDER_OFF;
  if (methods === 'google' && !facts.ownGoogle) return OWNER_LINK_GOOGLE_FIRST;
  if (methods === 'password' && !facts.ownPassword) return OWNER_SET_PASSWORD_FIRST;
  return null;
}

/** Settings > Workspace: the setting, Google in Supabase, and who each choice would leave out (Owner only, else null). */
export interface SignInMethodsView {
  ready: boolean;
  methods: SignInMethods;
  google_provider: GoogleProviderState;
  stranded: Record<SignInMethods, StrandedSummary> | null;
}

// ── A member's own sign-in ──────────────────────────────────────────────

/** What decides which changes a member may make to their own sign-in. */
export interface AccountFacts {
  /** False for a login another app made (team_members.login_owned): PM never changes its email or password. */
  loginOwned: boolean;
  hasPassword: boolean;
  googleLinked: boolean;
  methods: SignInMethods;
}

export type AccountChange = 'set_password' | 'change_email' | 'link_google' | 'unlink_google';

export const GOOGLE_OFF = 'Google sign-in is off for this workspace. An Owner can turn it on in Settings > Workspace.';
export const GOOGLE_ALREADY_LINKED = 'Google is already linked to your account.';
export const GOOGLE_NOT_LINKED = 'No Google account is linked.';
export const SET_PASSWORD_FIRST = 'Set a password first, so you can still sign in without Google.';
export const GOOGLE_ONLY_WORKSPACE = 'This workspace signs in with Google only, so unlinking Google would leave you no way in.';

/**
 * Why a change to a member's own sign-in is refused, or null when it may go
 * ahead. A member always keeps at least one way in that this workspace
 * accepts. A login another app made keeps its email, password and Google
 * link as that app set them; linking an extra Google identity to it is fine.
 */
export function accountChangeRefusal(facts: AccountFacts, change: AccountChange): string | null {
  switch (change) {
    case 'set_password':
    case 'change_email':
      return facts.loginOwned ? null : NOT_OUR_LOGIN;
    case 'link_google':
      if (!allowsGoogle(facts.methods)) return GOOGLE_OFF;
      return facts.googleLinked ? GOOGLE_ALREADY_LINKED : null;
    case 'unlink_google':
      if (!facts.googleLinked) return GOOGLE_NOT_LINKED;
      // The other app may sign them in with Google only: its link stays.
      if (!facts.loginOwned) return NOT_OUR_LOGIN;
      if (!facts.hasPassword) return SET_PASSWORD_FIRST;
      if (!allowsPassword(facts.methods)) return GOOGLE_ONLY_WORKSPACE;
      return null;
  }
}

/** A member's sign-in, as Settings > Account shows it. */
export interface AccountSignInView {
  /** The workspace setting and whether Google is on in Supabase, so the screen offers only what works. */
  methods: SignInMethods;
  google_provider: GoogleProviderState;
  email: string | null;
  login_owned: boolean;
  has_password: boolean;
  google: { linked: boolean; email: string | null };
  /** Why each change is refused, or null when it is allowed. */
  refusals: Record<AccountChange, string | null>;
}

// ── Forgot password ─────────────────────────────────────────────────────

/** The one answer to a reset request, whoever asks: it never says whether an account exists. */
export const RESET_SENT = 'If that email can sign in here, we sent a link. Open it to choose a new password.';

/** Where the reset link lands, after Supabase sends it back through the callback. */
export const RESET_PASSWORD_PATH = '/welcome/reset-password';

/** The words for a login another app made, shown once the reset link has proved the inbox is theirs. */
export const RESET_MANAGED_ELSEWHERE = 'This account comes from another app, so its password is changed there. Sign in with Google if your workspace offers it, or use that app\'s password reset.';

/**
 * What the reset page shows once the link signed the person in: the new
 * password form, or (for a login another app made) where to go instead, or
 * nothing for someone who is not on the team.
 */
export function resetPageOutcome(view: Pick<AccountSignInView, 'refusals'> | null): 'form' | 'managed_elsewhere' | 'no_access' {
  if (!view) return 'no_access';
  return view.refusals.set_password ? 'managed_elsewhere' : 'form';
}

/** What the reset page says when the link's short window passed before the person saved. */
export const RESET_TIMED_OUT = 'This link has timed out. Ask for a new one.';

/**
 * A new password saved from the reset page is refused when the link no
 * longer counts as proof. The person forgot their password, so the page never
 * asks for it: it says the link timed out and offers a new one.
 */
export function resetSaveRefusal(reason: string | null | undefined): 'timed_out' | null {
  return reason === 'current_password_required' || reason === 'fresh_sign_in_required' ? 'timed_out' : null;
}

// ── Google round trips ──────────────────────────────────────────────────

/** What a Google round trip is for, said to the server before leaving for Google (POST /api/auth/google). */
export type GoogleIntentKind = 'sign-in' | 'link' | 'invite' | 'first-owner';

/** Where Google sends people back. The only address to allow in Supabase. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/**
 * Outcomes the callback sends back as a code (never free text or an email
 * in the address), and the words each page shows for it.
 */
export const SIGN_IN_ERRORS = {
  no_access: 'This account is not on the team. Ask an Owner to invite you, then sign in again.',
  google_off: GOOGLE_OFF,
  google_failed: 'Google sign-in did not finish. Try again.',
  google_in_use: 'That Google account is already linked to another login. Sign in with it, or pick a different Google account.',
  invite_email: 'That Google account has a different email from your invite. Continue with the Google account for the address you were invited at.',
  invite_expired: 'This invite link has expired. Ask the person who invited you to send a new one.',
  invite_other_login: 'That email already has a separate login here, so it cannot accept this invite. Ask the person who invited you for help.',
  owner_taken: 'This workspace already has an Owner. Sign in instead.',
  owner_code: 'Enter the setup code from your host, then continue with Google again.',
  owner_failed: 'Could not make you the Owner. Try again.',
} as const;
export type SignInErrorCode = keyof typeof SIGN_IN_ERRORS;

export function signInErrorMessage(code: string | null | undefined): string | null {
  return code && Object.prototype.hasOwnProperty.call(SIGN_IN_ERRORS, code) ? SIGN_IN_ERRORS[code as SignInErrorCode] : null;
}
