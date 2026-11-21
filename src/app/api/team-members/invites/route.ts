import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { InviteError, listPendingInvites } from '@/lib/team/invite';

/** The team members who have not signed in yet, for Resend invite and Copy invite link. */
export async function GET() {
  const auth = await requireSessionAccess({ permission: 'team.manage' });
  if (auth.error) return auth.error;
  try {
    return NextResponse.json({ data: { pending: await listPendingInvites(auth.data.service) } });
  } catch (error) {
    const status = error instanceof InviteError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not read invites' }, { status });
  }
}
