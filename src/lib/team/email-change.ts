import type { SupabaseClient } from '@supabase/supabase-js';
import { canChangeSignInEmail } from '@/lib/team/invite-rules';
import { NOT_OUR_LOGIN } from '@/lib/team/invite';
import { sendAccountNotice } from '@/lib/api/account-security';
import { loginFacts, type LoginFacts } from '@/lib/api/sign-in';

/**
 * Changing someone's sign-in email: the one writer behind Team and Settings
 * > Account (/api/team-members/update-email) and the API
 * (/api/v1/me/email, /api/v1/team-members/{id}/email). The email decides who
 * can reset the password, so only the person or an Owner changes it, never
 * an Owner's by anyone else, and your own needs proof it is you (the caller
 * passes proveSelf: a current password, or in the app a fresh sign-in). The
 * old address hears about it, so a takeover never goes unseen.
 */

export class EmailChangeError extends Error {
  constructor(public status: number, message: string, public reason: string) {
    super(message);
  }
}

export interface EmailChangeInput {
  /** Who asks: their member id, role and whether they hold team.manage on the request's channel. */
  actor: { memberId: string; role: string; managesTeam: boolean };
  targetId: string;
  newEmail: string;
  /** Throws unless the person proved it is them (only called for your own email). */
  proveSelf: (login: LoginFacts) => Promise<void>;
}

export async function changeSignInEmail(service: SupabaseClient, input: EmailChangeInput): Promise<Record<string, unknown>> {
  const isSelf = input.actor.memberId === input.targetId;
  if (!isSelf && !input.actor.managesTeam) throw new EmailChangeError(403, 'Only team managers can change another member email', 'team_manage');

  const { data: targetMember } = await service
    .from('team_members')
    .select('id, auth_user_id, email, role, login_owned')
    .eq('id', input.targetId)
    .single();
  if (!targetMember) throw new EmailChangeError(404, 'Team member not found', 'not_found');
  if (targetMember.role === 'owner' && !isSelf) throw new EmailChangeError(403, 'The Owner account cannot be modified by another member', 'owner_protected');
  // Anyone else could take the account over, and its personal inbox with it.
  if (!canChangeSignInEmail(input.actor.role, isSelf)) throw new EmailChangeError(403, 'Only the person or an Owner can change a sign-in email', 'owner_only');
  if (!targetMember.auth_user_id) throw new EmailChangeError(400, 'This team member has no linked auth account', 'no_login');
  // A login PM did not make (another app's user) is changed only in that app.
  if (targetMember.login_owned === false) throw new EmailChangeError(409, NOT_OUR_LOGIN, 'not_our_login');

  // Your own sign-in email needs proof it is you, not just a borrowed session or key.
  if (isSelf) await input.proveSelf(await loginFacts(service, targetMember.auth_user_id));

  const { data: existing } = await service
    .from('team_members')
    .select('id')
    .eq('email', input.newEmail)
    .neq('id', input.targetId)
    .maybeSingle();
  if (existing) throw new EmailChangeError(409, 'A team member with this email already exists', 'email_taken');

  // The auth email changes at once, with no confirmation step.
  const { error: authUpdateError } = await service.auth.admin.updateUserById(targetMember.auth_user_id, { email: input.newEmail, email_confirm: true });
  if (authUpdateError) {
    const message = authUpdateError.message?.toLowerCase() ?? '';
    if (message.includes('already been registered') || message.includes('already exists')) {
      throw new EmailChangeError(409, 'An auth account with this email already exists', 'email_taken');
    }
    console.error('[update-email] auth update failed', authUpdateError);
    throw new EmailChangeError(500, 'Could not change the email. Try again.', 'auth_failed');
  }

  const { data: updated, error: updateError } = await service
    .from('team_members')
    .update({ email: input.newEmail })
    .eq('id', input.targetId)
    .select('*')
    .single();
  if (updateError) throw new EmailChangeError(500, 'Auth email updated but team member record failed to update', 'member_failed');

  // The old address hears about it, so a takeover never goes unseen.
  const { data: actor } = isSelf ? { data: null } : await service.from('team_members').select('name').eq('id', input.actor.memberId).maybeSingle();
  await sendAccountNotice({ to: targetMember.email, change: 'email', newEmail: input.newEmail, byOther: isSelf ? null : ((actor as { name?: string } | null)?.name ?? 'An Owner') });
  return updated as Record<string, unknown>;
}
