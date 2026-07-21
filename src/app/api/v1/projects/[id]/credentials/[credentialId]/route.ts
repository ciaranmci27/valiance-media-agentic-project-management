import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateCredentialSchema, payloadFromBody } from '@/lib/schemas/credentials';
import { forbidden, notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { encrypt, decrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { fetchCredentialWithEncryptedData, patchProjectCredential, removeProjectCredential } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';
import { z } from 'zod';
import { apiKeyAllows } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, params, access, scopes, teamMemberId }) => {
  const { id, credentialId } = params as any;

  const { data } = await supabase
    .from('project_credentials')
    .select('id, project_id, label, category, submitted_by_client, submitted_by_name, created_by, created_at, updated_at')
    .eq('id', credentialId)
    .eq('project_id', id)
    .maybeSingle();

  if (!data) throw notFound('Credential');
  if (!apiKeyAllows(access, scopes, 'credentials.manage')) {
    const { data: grant } = await supabase
      .from('project_credential_members')
      .select('credential_id')
      .eq('credential_id', credentialId)
      .eq('member_id', teamMemberId)
      .maybeSingle();
    if (!grant) throw forbidden('Credential has not been shared with this team member');
  }
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id, credentialId } = params as any;
  const entry = body as z.infer<typeof updateCredentialSchema>;

  const { data: existing } = await supabase
    .from('project_credentials')
    .select('id, project_id, label, category, submitted_by_client, submitted_by_name, created_by, created_at, updated_at')
    .eq('id', credentialId)
    .eq('project_id', id)
    .maybeSingle();
  if (!existing) throw notFound('Credential');

  const updates: Record<string, any> = {};
  if (entry.label !== undefined) updates.label = entry.label;
  if (entry.category !== undefined) updates.category = entry.category;

  const providedFields = payloadFromBody(entry);
  const hasSecretFields = Object.keys(providedFields).length > 0;

  if (!hasSecretFields && Object.keys(updates).length === 0) {
    return success(existing);
  }

  if (hasSecretFields) {
    if (!isEncryptionConfigured()) {
      throw badRequest('Encryption not configured. Set PROJECT_CREDENTIALS_ENCRYPTION_KEY in your environment.');
    }
    const full = await fetchCredentialWithEncryptedData(supabase, credentialId, id);
    const current = await decrypt<CredentialPayload>(full.encrypted_data, full.iv);
    // Keys not present in the request are preserved
    const merged: CredentialPayload = { ...current, ...providedFields };
    const { encrypted_data, iv } = await encrypt(merged);
    updates.encrypted_data = encrypted_data;
    updates.iv = iv;
  }

  const updated = await patchProjectCredential(supabase, credentialId, updates);

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${id}/credentials/${credentialId}`,
    entityType: 'credential',
    entityId: credentialId,
    apiKeyId,
    teamMemberId,
    requestBody: { label: entry.label, category: entry.category },
    beforeSnapshot: existing,
    afterSnapshot: updated,
    statusCode: 200,
  });

  return success(updated);
}, { schema: updateCredentialSchema });

export const DELETE = withApi(async ({ supabase, params, apiKeyId, teamMemberId }) => {
  const { id, credentialId } = params as any;

  const { data: existing } = await supabase
    .from('project_credentials')
    .select('id, label')
    .eq('id', credentialId)
    .eq('project_id', id)
    .maybeSingle();
  if (!existing) throw notFound('Credential');

  await removeProjectCredential(supabase, credentialId);

  logAudit(supabase, {
    method: 'DELETE',
    endpoint: `/api/v1/projects/${id}/credentials/${credentialId}`,
    entityType: 'credential',
    entityId: credentialId,
    apiKeyId,
    teamMemberId,
    beforeSnapshot: existing,
    statusCode: 200,
  });

  return success({ deleted: true });
});
