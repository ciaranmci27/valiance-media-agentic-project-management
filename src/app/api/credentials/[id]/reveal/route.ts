import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { fetchCredentialWithEncryptedData } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 503 });
  }

  try {
    const credential = await fetchCredentialWithEncryptedData(supabase, id);
    const payload = await decrypt<CredentialPayload>(credential.encrypted_data, credential.iv);
    return NextResponse.json({ success: true, data: payload });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
