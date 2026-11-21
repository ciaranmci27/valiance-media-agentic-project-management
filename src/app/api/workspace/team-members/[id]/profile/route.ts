import { NextResponse } from 'next/server';
import { requireSessionAccess } from '@/lib/api/access';
import { assembleTeamProfile, loadProfileActivityPage } from '@/lib/team/profile';

/**
 * A team member's profile under the viewer's rights (see lib/team/profile).
 * With `?before=<cursor>` it answers the next page of their activity only.
 * Someone the viewer may not see is a 404, never a 403, so the answer does
 * not say whether they exist.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { id } = await params;
  const { access, service, client } = auth.data;
  const notFound = () => NextResponse.json({ error: 'Team member not found' }, { status: 404 });

  try {
    const before = new URL(request.url).searchParams.get('before');
    if (before !== null) {
      const page = await loadProfileActivityPage({ service, reader: client, access, targetId: id, before });
      return page ? NextResponse.json({ data: page }) : notFound();
    }
    const profile = await assembleTeamProfile({ service, reader: client, access, targetId: id });
    return profile ? NextResponse.json({ data: profile }) : notFound();
  } catch (error) {
    console.error('[team profile]', error);
    return NextResponse.json({ error: 'Could not load the profile' }, { status: 500 });
  }
}
