import { NextRequest, NextResponse } from 'next/server';
import { decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { fetchCredentialWithEncryptedData } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';
import { accessAllows, accessAllowsProject, requireSessionAccess } from '@/lib/api/access';
import { insertAuditRows } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';

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
    // Every reveal is recorded, in the app as over the API (security review finding 13). The secret never is.
    afterResponse('credential reveal audit', async () => {
      const { error } = await insertAuditRows(service, {
        method: 'GET',
        endpoint: `/api/credentials/${id}/reveal`,
        entity_type: 'credential_reveal',
        entity_id: id,
        api_key_id: null,
        team_member_id: memberId,
        status_code: 200,
        via: 'app',
      });
      if (error) throw error;
    });
    return NextResponse.json({ success: true, data: payload });
  } catch {
    return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
  }
}
