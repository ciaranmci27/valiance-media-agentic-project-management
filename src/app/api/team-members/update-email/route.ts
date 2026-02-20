import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';

const updateEmailSchema = z.object({
  team_member_id: z.string().uuid(),
  new_email: z.string().email('Invalid email address'),
});

export async function POST(req: NextRequest) {
  // 1. Verify caller session
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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

  const service = getServiceClient();

  // 3. Get caller's team member
  const { data: callerMember } = await service
    .from('team_members')
    .select('id, role')
    .eq('auth_user_id', user.id)
    .single();

  if (!callerMember) {
    return NextResponse.json({ error: 'Team member not found for your account' }, { status: 404 });
  }

  const isSelf = callerMember.id === body.team_member_id;
  const isAdmin = callerMember.role === 'admin';

  // 4. Permission check: must be self or admin
  if (!isSelf && !isAdmin) {
    return NextResponse.json({ error: 'Forbidden — only admins can change other members\' emails' }, { status: 403 });
  }

  // 5. Get the target team member's auth_user_id
  const { data: targetMember } = await service
    .from('team_members')
    .select('id, auth_user_id, email')
    .eq('id', body.team_member_id)
    .single();

  if (!targetMember) {
    return NextResponse.json({ error: 'Team member not found' }, { status: 404 });
  }

  if (!targetMember.auth_user_id) {
    return NextResponse.json({ error: 'This team member has no linked auth account' }, { status: 400 });
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
