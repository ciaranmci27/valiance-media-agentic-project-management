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

/** The team_members row the new-user trigger makes, waited for briefly. */
async function memberForAuthUser(service: SupabaseClient, authUserId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await service.from('team_members').select('*').eq('auth_user_id', authUserId).maybeSingle();
    if (data) return data as Record<string, unknown> & { id: string };
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return null;
}

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
      throw new InviteError(409, 'A user with this email already exists');
    }
    if (message.includes('password')) throw new InviteError(422, createError.message);
    throw new InviteError(500, createError.message || 'Failed to create user');
  }
  if (!created?.user) throw new InviteError(500, 'Failed to create user');

  const row = await memberForAuthUser(service, created.user.id);
  if (!row) {
    throw new InviteError(500, 'User created but team member row was not auto-generated. Check the handle_new_user trigger.');
  }
  const { data: patched } = await service
    .from('team_members')
    .update({ name: input.name, role: input.role })
    .eq('id', row.id)
    .select('*')
    .single();
  const member = (patched as InviteResult['member'] | null) ?? { ...row, name: input.name, role: input.role };

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
    .select('id, auth_user_id, name, email, role, status')
    .eq('id', memberId)
    .maybeSingle();
  if (error) throw new InviteError(500, error.message);
  if (!member) throw new InviteError(404, 'Team member not found');
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
