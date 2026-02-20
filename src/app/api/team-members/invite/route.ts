import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';

const inviteSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['admin', 'member', 'guest', 'agent']),
});

export async function POST(req: NextRequest) {
  // 1. Verify caller session
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Verify caller is admin
  const service = getServiceClient();
  const { data: callerMember } = await service
    .from('team_members')
    .select('role')
    .eq('auth_user_id', user.id)
    .single();

  if (!callerMember || callerMember.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden – admin role required' }, { status: 403 });
  }

  // 3. Validate body
  let body: z.infer<typeof inviteSchema>;
  try {
    body = inviteSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 4. Create auth user via Admin API
  const { data: newAuthUser, error: createError } = await service.auth.admin.createUser({
    email: body.email,
    password: body.password,
    email_confirm: true,
    user_metadata: { display_name: body.name },
  });

  if (createError) {
    if (createError.message?.toLowerCase().includes('already been registered') ||
        createError.message?.toLowerCase().includes('already exists')) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
    }
    if (createError.message?.toLowerCase().includes('password')) {
      return NextResponse.json({ error: createError.message }, { status: 422 });
    }
    return NextResponse.json({ error: createError.message || 'Failed to create user' }, { status: 500 });
  }

  if (!newAuthUser?.user) {
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }

  // 5. Wait briefly for the handle_new_user trigger then fetch the team_members row
  let teamMember = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data } = await service
      .from('team_members')
      .select('*')
      .eq('auth_user_id', newAuthUser.user.id)
      .single();
    if (data) {
      teamMember = data;
      break;
    }
    await new Promise(r => setTimeout(r, 300));
  }

  if (!teamMember) {
    return NextResponse.json({ error: 'User created but team member row was not auto-generated. Check the handle_new_user trigger.' }, { status: 500 });
  }

  // 6. Patch with correct name and role
  const { data: patched, error: patchError } = await service
    .from('team_members')
    .update({ name: body.name, role: body.role })
    .eq('id', teamMember.id)
    .select('*')
    .single();

  if (patchError || !patched) {
    // Return the unpatched row — still usable
    return NextResponse.json({ ...teamMember, name: body.name, role: body.role }, { status: 201 });
  }

  return NextResponse.json(patched, { status: 201 });
}
