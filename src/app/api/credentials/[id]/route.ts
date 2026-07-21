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
    await removeProjectCredential(auth.data.service, id);
    return NextResponse.json({ success: true, deleted: true });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
