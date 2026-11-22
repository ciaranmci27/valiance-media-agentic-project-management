import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { canChangeSignInEmail } from '@/lib/team/invite-rules';
import { NOT_OUR_LOGIN } from '@/lib/team/invite';

const updateEmailSchema = z.object({
  team_member_id: z.string().uuid(),
  new_email: z.string().email('Invalid email address'),
});

export async function POST(req: NextRequest) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;

  // 2. Validate body
  let body: z.infer<typeof updateEmailSchema>;
  try {
    body = updateEmailSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { access, memberId, service } = auth.data;
  const isSelf = memberId === body.team_member_id;
  const canManageTeam = accessAllows(access, 'team.manage', 'app');

  // 4. Permission check: must be self or admin
  if (!isSelf && !canManageTeam) {
    return NextResponse.json({ error: 'Only team managers can change another member email' }, { status: 403 });
  }

  // 5. Get the target team member's auth_user_id
  const { data: targetMember } = await service
    .from('team_members')
    .select('id, auth_user_id, email, role, login_owned')
    .eq('id', body.team_member_id)
    .single();

  if (!targetMember) {
    return NextResponse.json({ error: 'Team member not found' }, { status: 404 });
  }
  if (targetMember.role === 'owner' && !isSelf) {
    return NextResponse.json({ error: 'The Owner account cannot be modified by another member' }, { status: 403 });
  }
  // A sign-in email decides who can reset the password, so only the person
  // or an Owner changes it (anyone else could take the account over, and its
  // personal inbox with it).
  if (!canChangeSignInEmail(access.role, isSelf)) {
    return NextResponse.json({ error: 'Only the person or an Owner can change a sign-in email' }, { status: 403 });
  }

  if (!targetMember.auth_user_id) {
    return NextResponse.json({ error: 'This team member has no linked auth account' }, { status: 400 });
  }
  // A login PM did not make (another app's user) is changed only in that app.
  if (targetMember.login_owned === false) {
    return NextResponse.json({ error: NOT_OUR_LOGIN }, { status: 409 });
  }

  // 6. Check for duplicate email
  const { data: existing } = await service
    .from('team_members')
    .select('id')
    .eq('email', body.new_email)
    .neq('id', body.team_member_id)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ error: 'A team member with this email already exists' }, { status: 409 });
  }

  // 7. Update auth email via admin API (immediate, no confirmation required)
  const { error: authUpdateError } = await service.auth.admin.updateUserById(
    targetMember.auth_user_id,
    { email: body.new_email, email_confirm: true }
  );

  if (authUpdateError) {
    if (authUpdateError.message?.toLowerCase().includes('already been registered') ||
        authUpdateError.message?.toLowerCase().includes('already exists')) {
      return NextResponse.json({ error: 'An auth account with this email already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: authUpdateError.message || 'Failed to update auth email' }, { status: 500 });
  }

  // 8. Update team_members table
  const { data: updated, error: updateError } = await service
    .from('team_members')
    .update({ email: body.new_email })
    .eq('id', body.team_member_id)
    .select('*')
    .single();

  if (updateError) {
    return NextResponse.json({ error: 'Auth email updated but team member record failed to update' }, { status: 500 });
  }

  return NextResponse.json(updated);
}
