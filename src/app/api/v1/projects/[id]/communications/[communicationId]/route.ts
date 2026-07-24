import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest, forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { apiKeyAllows } from '@/lib/api/access';
import { approveCommunication, dismissCommunication } from '@/lib/email/client-notifications';

export const runtime = 'nodejs';

const patchSchema = z.object({
  action: z.enum(['approve', 'dismiss']),
  slot_overrides: z.record(z.string(), z.string()).optional(),
  recipients: z.object({
    to: z.array(z.string().email()).optional(),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
  }).optional(),
});

export const PATCH = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId, access, scopes }) => {
  const input = body as z.infer<typeof patchSchema>;
  const { data: before, error: fetchError } = await supabase
    .from('client_communications')
    .select('*')
    .eq('id', params.communicationId)
    .eq('project_id', params.id)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!before) throw notFound('Communication');
  if (
    input.action === 'approve'
    && before.notification_type === 'invoice'
    && !apiKeyAllows(access, scopes, 'invoices.manage')
  ) {
    throw forbidden('Invoice management permission required');
  }

  const result = input.action === 'approve'
    ? await approveCommunication(params.communicationId, teamMemberId, input.slot_overrides, input.recipients)
    : await dismissCommunication(params.communicationId, teamMemberId);
  if (!result.success) throw badRequest(result.error || 'Communication action failed');

  logAudit(supabase, {
    method: 'PATCH',
    endpoint: `/api/v1/projects/${params.id}/communications/${params.communicationId}`,
    entityType: 'client_communication',
    entityId: params.communicationId,
    apiKeyId,
    teamMemberId,
    requestBody: input,
    beforeSnapshot: before,
    statusCode: 200,
  });
  return success({ action: input.action, communication_id: result.communicationId });
}, { schema: patchSchema, permission: 'communications.manage' });
