import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createCredentialSchema, payloadFromBody } from '@/lib/schemas/credentials';
import { notFound, badRequest } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';
import { encrypt, isEncryptionConfigured } from '@/lib/api/encryption';
import { insertProjectCredential } from '@/lib/supabase/queries';
import type { CredentialPayload } from '@/lib/types';
import { z } from 'zod';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data: project } = await supabase.from('projects').select('id').eq('id', id).maybeSingle();
  if (!project) throw notFound('Project');

  const { data, count, error } = await supabase
    .from('project_credentials')
    .select('id, project_id, label, category, submitted_by_client, submitted_by_name, created_by, created_at, updated_at', { count: 'exact' })
    .eq('project_id', id)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;
  const entry = body as z.infer<typeof createCredentialSchema>;

  const { data: project } = await supabase.from('projects').select('id').eq('id', id).maybeSingle();
  if (!project) throw notFound('Project');

  if (!isEncryptionConfigured()) {
    throw badRequest('Encryption not configured. Set PROJECT_CREDENTIALS_ENCRYPTION_KEY in your environment.');
  }

  const payload: CredentialPayload = payloadFromBody(entry);
  const { encrypted_data, iv } = await encrypt(payload);

  const credential = await insertProjectCredential(supabase, {
    project_id: id,
    label: entry.label,
    category: entry.category,
    encrypted_data,
    iv,
    created_by: teamMemberId,
  });

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${id}/credentials`,
    entityType: 'credential',
    entityId: credential.id,
    apiKeyId,
    teamMemberId,
    requestBody: { label: entry.label, category: entry.category },
    afterSnapshot: credential,
    statusCode: 201,
  });

  return created(credential);
}, { schema: createCredentialSchema });
