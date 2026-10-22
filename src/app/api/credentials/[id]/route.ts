import { NextRequest, NextResponse } from 'next/server';
import { removeProjectCredential } from '@/lib/supabase/queries';
import { requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireSessionAccess({ permission: 'credentials.manage' });
  if (auth.error) return auth.error;

  try {
    // As the signed-in member: the database checks their access to the
    // credential's project, moves it to Trash and writes the audit row.
    await removeProjectCredential(auth.data.client, id);
    return NextResponse.json({ success: true, deleted: true });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
