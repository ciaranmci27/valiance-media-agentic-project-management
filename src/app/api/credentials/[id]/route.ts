import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { removeProjectCredential } from '@/lib/supabase/queries';

export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await removeProjectCredential(supabase, id);
    return NextResponse.json({ success: true, deleted: true });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
