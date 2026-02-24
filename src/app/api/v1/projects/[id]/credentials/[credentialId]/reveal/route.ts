import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { fetchCredentialWithEncryptedData } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';

export const GET = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, credentialId } = params as any;

  if (!isEncryptionConfigured()) {
    throw badRequest('Encryption not configured. Set PROJECT_CREDENTIALS_ENCRYPTION_KEY in your environment.');
  }

  const { data: check } = await supabase
    .from('project_credentials')
    .select('id')
    .eq('id', credentialId)
    .eq('project_id', id)
    .maybeSingle();
  if (!check) throw notFound('Credential');

  const credential = await fetchCredentialWithEncryptedData(supabase, credentialId, id);
  const payload = await decrypt<CredentialPayload>(credential.encrypted_data, credential.iv);

  logAudit(supabase, {
    method: 'GET',
    endpoint: `/api/v1/projects/${id}/credentials/${credentialId}/reveal`,
    entityType: 'credential_reveal',
    entityId: credentialId,
    apiKeyId,
    teamMemberId,
    statusCode: 200,
  });

  return success(payload);
});
