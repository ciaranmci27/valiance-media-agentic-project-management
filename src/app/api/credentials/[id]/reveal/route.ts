import { NextRequest, NextResponse } from 'next/server';
import { decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { fetchCredentialWithEncryptedData } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;

  if (!isEncryptionConfigured()) {
    return NextResponse.json({ error: 'Encryption not configured' }, { status: 503 });
  }

  try {
    const credential = await fetchCredentialWithEncryptedData(service, id);
    const managesCredentials = accessAllows(access, 'credentials.manage', 'app');
    if (!managesCredentials) {
      if (!accessAllows(access, 'credentials.reveal_shared', 'app') || !accessAllowsProject(access, credential.project_id)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const { data: grant } = await service
        .from('project_credential_members')
        .select('credential_id')
        .eq('credential_id', id)
        .eq('member_id', memberId)
        .maybeSingle();
      if (!grant) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const payload = await decrypt<CredentialPayload>(credential.encrypted_data, credential.iv);
    return NextResponse.json({ success: true, data: payload });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
