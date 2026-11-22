import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { AccessContext } from '@/lib/access-control';
import { canChangeSignInEmail, canInviteRole } from './invite-rules';

/**
 * Inviting people to the workspace. The inviter gives a name, an email and a
 * role; the person gets an account with no usable password and a one-time
 * link to choose their own (/welcome/set-password: 7 days, stored hashed in
 * team_invites), emailed through the
 * workspace's SMTP account when one is set up. The link always comes back
 * to the inviter too, so they can pass it on when email is not set up.
 *
 * The older call that sends a password still works for API callers: that
 * person signs in with the password typed for them and gets no link.
 *
 * Only an Owner invites (or re-invites) an Owner or an Admin.
 */

export const SET_PASSWORD_PATH = '/welcome/set-password';

export const inviteSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').optional(),
  role: z.enum(['owner', 'admin', 'member', 'guest', 'agent']),
});
export type InviteInput = z.infer<typeof inviteSchema>;
type Role = InviteInput['role'];

export class InviteError extends Error {
  constructor(public status: number, message: string, public details?: Record<string, string[] | undefined>) {
    super(message);
  }
}

export { canChangeSignInEmail, canInviteRole };

/** How long an invite link works. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The stored form of a token: its sha256, hex. The token itself is only ever in the link. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 32 random bytes, base64url: 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * A fresh set-your-password link for a team member: their unused invites are
 * deleted, so only this link works, and the new one lasts 7 days. Opening
 * the link spends nothing; the token is used only when the person submits
 * a password (redeemInvite).
 */
export async function issueInvite(
  service: SupabaseClient,
  input: { memberId: string; createdBy: string | null; appUrl: string; now?: Date },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = input.now ?? new Date();
  const cleared = await service.from('team_invites').delete().eq('member_id', input.memberId).is('used_at', null);
  if (cleared.error) throw new InviteError(500, cleared.error.message);
  const { error } = await service.from('team_invites').insert({
    member_id: input.memberId,
    token_hash: hashInviteToken(token),
    created_by: input.createdBy,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
  });
  if (error) throw new InviteError(500, error.message);
  const url = new URL(SET_PASSWORD_PATH, input.appUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

/** Expired, used, unknown, or for someone who can no longer use it: all one answer, on purpose. */
export class InviteExpiredError extends InviteError {
  constructor() {
    super(410, 'This link has expired');
  }
}

interface LiveInvite {
  invite: { id: string; member_id: string };
  member: { id: string; auth_user_id: string; name: string; email: string | null };
  authEmail: string | null;
}

/** The invite behind a token, if it can still be used. Reads only; spends nothing. */
async function liveInvite(service: SupabaseClient, token: unknown, now: Date): Promise<LiveInvite> {
  if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) throw new InviteExpiredError();
  const hash = hashInviteToken(token);
  const { data: invite, error } = await service
    .from('team_invites')
    .select('id, member_id, token_hash, expires_at, used_at')
    .eq('token_hash', hash)
    .maybeSingle();
  if (error) throw new InviteError(500, error.message);
  // Looked up by its hash, then compared in constant time as well.
  const stored = Buffer.from(String(invite?.token_hash ?? ''), 'hex');
  const given = Buffer.from(hash, 'hex');
  if (!invite || stored.length !== given.length || !timingSafeEqual(stored, given)) throw new InviteExpiredError();
  if (invite.used_at || new Date(invite.expires_at).getTime() <= now.getTime()) throw new InviteExpiredError();

  const { data: member } = await service
    .from('team_members')
    .select('id, auth_user_id, name, email, status')
    .eq('id', invite.member_id)
    .maybeSingle();
  if (!member?.auth_user_id || member.status !== 'active') throw new InviteExpiredError();
  const { data: user, error: userError } = await service.auth.admin.getUserById(member.auth_user_id);
  if (userError || !user?.user) throw new InviteExpiredError();
  // Someone who has signed in already has a password: the link is no longer theirs to use.
  if (user.user.last_sign_in_at) throw new InviteExpiredError();
  return { invite, member, authEmail: user.user.email ?? null };
}

/** Who a link is for, to greet them on the page. Spends nothing (mail scanners open links). */
export async function peekInvite(service: SupabaseClient, token: unknown, now = new Date()): Promise<{ name: string }> {
  const { member } = await liveInvite(service, token, now);
  return { name: member.name };
}

/**
 * Sets the person's password from their invite link, once. The invite is
 * claimed before the password is set, so two submits cannot both use it; a
 * password Supabase refuses hands the claim back for another try. Returns
 * the email to sign in with.
 */
export async function redeemInvite(
  service: SupabaseClient,
  input: { token: unknown; password: string; now?: Date },
): Promise<{ email: string }> {
  const now = input.now ?? new Date();
  const { invite, member, authEmail } = await liveInvite(service, input.token, now);
  const { data: owned } = await service.from('team_members').select('login_owned').eq('id', member.id).maybeSingle();
  if ((owned as { login_owned?: boolean } | null)?.login_owned === false) throw new InviteError(409, NOT_OUR_LOGIN);
  const { data: claimed, error: claimError } = await service
    .from('team_invites')
    .update({ used_at: now.toISOString() })
    .eq('id', invite.id)
    .is('used_at', null)
    .select('id');
  if (claimError) throw new InviteError(500, claimError.message);
  if (!claimed?.length) throw new InviteExpiredError();

  const { error } = await service.auth.admin.updateUserById(member.auth_user_id, { password: input.password });
  if (error) {
    await service.from('team_invites').update({ used_at: null }).eq('id', invite.id);
    throw new InviteError(error.status && error.status < 500 ? 422 : 500, error.message || 'Could not set the password');
  }
  const email = authEmail ?? member.email;
  if (!email) throw new InviteError(500, 'This account has no email to sign in with');
  return { email };
}

export interface MailMessage { to: string; subject: string; html: string; text: string }
export type InviteMailer = (message: MailMessage) => Promise<{ success: boolean; error?: string }>;

export type EmailStatus = 'sent' | 'not_configured' | 'failed' | 'skipped';
export interface InviteDelivery {
  link: string;
  emailed: boolean;
  emailStatus: EmailStatus;
  emailError?: string;
}

interface DeliveryOptions {
  service: SupabaseClient;
  appUrl: string;
  inviterName: string | null;
  mailer?: InviteMailer;
}

/** Whether invitation emails can go out: an SMTP account exists. */
export async function emailConfigured(service: SupabaseClient): Promise<boolean> {
  const { data, error } = await service.from('smtp_accounts').select('id').limit(1);
  return !error && (data?.length ?? 0) > 0;
}

const defaultMailer: InviteMailer = async (message) => {
  const { sendTransactional } = await import('@/lib/email/send-mail');
  return sendTransactional(message);
};

async function deliver(
  options: DeliveryOptions & { access: AccessContext },
  person: { memberId: string; name: string; email: string; role: Role },
  send: boolean,
): Promise<InviteDelivery> {
  const link = await issueInvite(options.service, { memberId: person.memberId, createdBy: options.access.member_id, appUrl: options.appUrl });
  // An agent's address is rarely a real inbox: it gets the link, not an email.
  if (!send || person.role === 'agent') return { link, emailed: false, emailStatus: 'skipped' };
  if (!(await emailConfigured(options.service))) return { link, emailed: false, emailStatus: 'not_configured' };

  const [{ getBrand }, { buildInviteEmail }] = await Promise.all([
    import('@/lib/brand/server'),
    import('@/lib/email/templates/team/invite'),
  ]);
  const roleLabel = person.role.charAt(0).toUpperCase() + person.role.slice(1);
  const email = buildInviteEmail({ brand: await getBrand(), name: person.name, inviterName: options.inviterName, roleLabel, link });
  const result = await (options.mailer ?? defaultMailer)({ to: person.email, ...email });
  return result.success
    ? { link, emailed: true, emailStatus: 'sent' }
    : { link, emailed: false, emailStatus: 'failed', emailError: result.error || 'The email could not be sent' };
}

type MemberRow = Record<string, unknown> & { id: string };

/**
 * Makes (or, on an install that still has the sign-up trigger, finds and
 * updates) the team member for a login, through the server-only
 * pm.add_team_member. Members are never made by a sign-up.
 */
async function addMember(service: SupabaseClient, args: { authUserId: string; email: string; name: string; role: Role; loginOwned: boolean }): Promise<MemberRow> {
  const { data, error } = await service.rpc('add_team_member', {
    p_auth_user_id: args.authUserId,
    p_email: args.email,
    p_name: args.name,
    p_role: args.role,
    p_login_owned: args.loginOwned,
  });
  const row = (Array.isArray(data) ? data[0] : data) as MemberRow | null;
  if (error || !row?.id) throw new InviteError(500, error?.message || 'Could not add the team member');
  return row;
}

/** A login PM did not make (another app's user): PM never changes its email, password or links. */
export const NOT_OUR_LOGIN = 'This person signs in with an account from another app, so it is managed there.';

/** The email has a login on this project that was never confirmed: never linked. */
export const UNCONFIRMED_LOGIN = 'This email already has an account in another app here, but it has not been confirmed. Ask them to confirm their email in that app, then invite them again.';

export interface InviteResult {
  member: Record<string, unknown> & { id: string };
  /** Null on the older password path: that person signs in with the password given. */
  invite: InviteDelivery | null;
}

export async function inviteMember(options: DeliveryOptions & {
  access: AccessContext;
  input: InviteInput;
}): Promise<InviteResult> {
  const { service, access, input } = options;
  if (!canInviteRole(access.role, input.role)) {
    throw new InviteError(403, 'Only an Owner can invite an Owner, an Admin or an agent');
  }

  const { data: created, error: createError } = await service.auth.admin.createUser({
    email: input.email,
    ...(input.password ? { password: input.password } : {}),
    email_confirm: true,
    user_metadata: { display_name: input.name },
  });
  if (createError) {
    const message = createError.message?.toLowerCase() ?? '';
    if (message.includes('already been registered') || message.includes('already exists')) {
      return addExistingLogin(options);
    }
    if (message.includes('password')) throw new InviteError(422, createError.message);
    throw new InviteError(500, createError.message || 'Failed to create user');
  }
  if (!created?.user) throw new InviteError(500, 'Failed to create user');

  const member = await addMember(service, { authUserId: created.user.id, email: input.email, name: input.name, role: input.role, loginOwned: true });

  if (input.password) return { member, invite: null };
  try {
    return { member, invite: await deliver(options, { memberId: member.id, name: input.name, email: input.email, role: input.role }, true) };
  } catch (error) {
    // The person exists either way; a failed link can be made again from the Team page.
    return {
      member,
      invite: { link: '', emailed: false, emailStatus: 'failed', emailError: error instanceof Error ? error.message : 'Could not make the invite link' },
    };
  }
}

/**
 * The email already has a login in this Supabase project (another app's
 * user, on a shared project): it becomes a member with its own PM role,
 * marked as a login PM did not make, and is told to sign in with it. No
 * password is set and no set-password link is made.
 */
async function addExistingLogin(options: DeliveryOptions & { access: AccessContext; input: InviteInput }): Promise<InviteResult> {
  const { service, input } = options;
  const { data: anyLogin, error } = await service.rpc('login_for_email', { p_email: input.email });
  if (error || typeof anyLogin !== 'string') throw new InviteError(409, 'A user with this email already exists');
  const { data: existing } = await service.from('team_members').select('id').eq('auth_user_id', anyLogin).maybeSingle();
  if (existing) throw new InviteError(409, 'This person is already on the team');
  // Only a confirmed login is linked: an unconfirmed one may be someone else's
  // sign-up (in another app on this project) under this person's address.
  const { data: authUserId, error: confirmedError } = await service.rpc('login_for_email', { p_email: input.email, p_confirmed_only: true });
  if (confirmedError) throw new InviteError(500, 'Could not look up the existing account. Try again.');
  if (typeof authUserId !== 'string') throw new InviteError(409, UNCONFIRMED_LOGIN);
  if (input.password) throw new InviteError(409, 'This email already has an account. Invite them without a password: they sign in with the one they have.');
  const member = await addMember(service, { authUserId, email: input.email, name: input.name, role: input.role, loginOwned: false });

  const link = `${options.appUrl.replace(/\/$/, '')}/login`;
  if (input.role === 'agent') return { member, invite: { link, emailed: false, emailStatus: 'skipped' } };
  if (!(await emailConfigured(service))) return { member, invite: { link, emailed: false, emailStatus: 'not_configured' } };
  const [{ getBrand }, { buildInviteEmail }] = await Promise.all([
    import('@/lib/brand/server'),
    import('@/lib/email/templates/team/invite'),
  ]);
  const roleLabel = input.role.charAt(0).toUpperCase() + input.role.slice(1);
  const email = buildInviteEmail({ brand: await getBrand(), name: input.name, inviterName: options.inviterName, roleLabel, link, existingAccount: true });
  const result = await (options.mailer ?? defaultMailer)({ to: input.email, ...email });
  return {
    member,
    invite: result.success
      ? { link, emailed: true, emailStatus: 'sent' }
      : { link, emailed: false, emailStatus: 'failed', emailError: result.error || 'The email could not be sent' },
  };
}

/**
 * A fresh link for someone who has not signed in yet, emailed when `send`
 * (Resend invite) or only returned (Copy invite link). The new link replaces
 * any earlier one.
 */
export async function reissueInvite(options: DeliveryOptions & {
  access: AccessContext;
  memberId: string;
  send: boolean;
}): Promise<InviteDelivery> {
  const { service, access, memberId } = options;
  const { data: member, error } = await service
    .from('team_members')
    .select('id, auth_user_id, name, email, role, status, login_owned')
    .eq('id', memberId)
    .maybeSingle();
  if (error) throw new InviteError(500, error.message);
  if (!member) throw new InviteError(404, 'Team member not found');
  if (member.login_owned === false) throw new InviteError(409, NOT_OUR_LOGIN);
  if (!canInviteRole(access.role, member.role)) throw new InviteError(403, 'Only an Owner can invite an Owner, an Admin or an agent');
  if (!member.auth_user_id || !member.email) throw new InviteError(422, 'This person has no sign-in account');
  if (member.status !== 'active') throw new InviteError(422, 'Reactivate this person before inviting them again');

  const { data: user, error: userError } = await service.auth.admin.getUserById(member.auth_user_id);
  if (userError || !user?.user) throw new InviteError(500, userError?.message || 'Could not read the account');
  if (user.user.last_sign_in_at) throw new InviteError(409, `${member.name} has already signed in`);

  return deliver(options, { memberId: member.id, name: member.name, email: member.email, role: member.role }, options.send);
}

/**
 * Team members who have never signed in, so their invite may still be
 * pending: active people (not agents) whose account has no sign-in yet.
 */
export async function listPendingInvites(service: SupabaseClient): Promise<string[]> {
  const neverSignedIn = new Set<string>();
  const perPage = 1000;
  for (let page = 1; page < 50; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage });
    if (error) throw new InviteError(500, error.message);
    const users = data?.users ?? [];
    for (const user of users) if (!user.last_sign_in_at) neverSignedIn.add(user.id);
    if (users.length < perPage) break;
  }
  if (neverSignedIn.size === 0) return [];
  const { data, error } = await service.from('team_members').select('id, auth_user_id, role, status');
  if (error) throw new InviteError(500, error.message);
  return (data ?? [])
    .filter((row) => row.auth_user_id && neverSignedIn.has(row.auth_user_id) && row.role !== 'agent' && row.status === 'active')
    .map((row) => row.id as string);
}

/** Where links point: the configured app URL, else the address this request came to. */
export function appUrlFor(requestOrigin: string): string {
  return process.env.NEXT_PUBLIC_APP_URL || requestOrigin;
}
