import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSessionAccess } from '@/lib/api/access';
import { autoProvisionOnJoin } from '@/lib/api/personal-agents';
import { appUrlFor, inviteMember, inviteSchema, InviteError, type InviteInput } from '@/lib/team/invite';

/**
 * Adds someone to the team. Without a password (the app's own form) the
 * person gets a set-your-password link, emailed when SMTP is set up and
 * always returned as `invite.link`. With a password (older API callers) the
 * account signs in with it and `invite` is null. The body is the member row
 * either way, plus `invite`, and `assistants`: the personal agents an
 * enabled assistant setup for their role made for them on joining.
 */
export async function POST(req: NextRequest) {
  const auth = await requireSessionAccess({ permission: 'team.manage', memberColumns: 'name' });
  if (auth.error) return auth.error;
  const { access, service, memberRow } = auth.data;

  let input: InviteInput;
  try {
    input = inviteSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const { member, invite } = await inviteMember({
      service,
      access,
      input,
      appUrl: appUrlFor(req.nextUrl.origin),
      inviterName: typeof memberRow?.name === 'string' ? memberRow.name : null,
    });
    // A person whose role has an assistant setup gets their personal agent now (never fails the invite).
    const assistants = input.role === 'agent' ? [] : await autoProvisionOnJoin(service, member.id, access.member_id);
    return NextResponse.json({ ...member, invite, assistants }, { status: 201 });
  } catch (error) {
    if (error instanceof InviteError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to invite' }, { status: 500 });
  }
}
