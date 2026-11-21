import { NextRequest, NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { foreignOrigin } from '@/lib/api/owner-route';
import { appUrlFor, InviteError, reissueInvite } from '@/lib/team/invite';

/**
 * A fresh set-your-password link for someone who has not signed in yet.
 * `{ send: true }` emails it (Resend invite); `{ send: false }` only returns
 * it (Copy invite link). Either way the new link replaces the old one.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (foreignOrigin(req)) return NextResponse.json({ error: 'Cross-site request refused' }, { status: 403 });
  const auth = await requireSessionAccess({ permission: 'team.manage', memberColumns: 'name' });
  if (auth.error) return auth.error;
  const { access, service, memberRow } = auth.data;
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as { send?: unknown };

  try {
    const invite = await reissueInvite({
      service,
      access,
      memberId: id,
      send: body?.send === true,
      appUrl: appUrlFor(req.nextUrl.origin),
      inviterName: typeof memberRow?.name === 'string' ? memberRow.name : null,
    });
    return NextResponse.json({ data: invite });
  } catch (error) {
    if (error instanceof InviteError) return NextResponse.json({ error: error.message }, { status: error.status });
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not make the invite link' }, { status: 500 });
  }
}
