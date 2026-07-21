import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { paginated, success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { parsePagination } from '@/lib/api/pagination';
import { logAudit } from '@/lib/api/audit';
import { previewCommunication, sendCommunication, type RenderContext } from '@/lib/email/client-notifications';
import { CLIENT_COMM_TYPES, type ClientCommType } from '@/lib/types';

const postSchema = z.object({
  action: z.enum(['preview', 'send']),
  type: z.enum(CLIENT_COMM_TYPES as unknown as [string, ...string[]]),
  slot_overrides: z.record(z.string(), z.string()).optional(),
  context: z.object({
    thresholdPct: z.number().optional(),
    milestone: z.number().optional(),
    oldBudget: z.number().optional(),
    newBudget: z.number().optional(),
  }).optional(),
  recipients: z.object({
    to: z.array(z.string().email()).optional(),
    cc: z.array(z.string().email()).optional(),
    bcc: z.array(z.string().email()).optional(),
  }).optional(),
});

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { page, limit, offset } = parsePagination(searchParams);
  const status = searchParams.get('status');
  let query = supabase
    .from('client_communications')
    .select('*, contact:contacts(id, name, email)', { count: 'exact' })
    .eq('project_id', params.id);
  if (status && status !== 'all') query = query.eq('status', status);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: 'communications.read' });

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const input = body as z.infer<typeof postSchema>;
  const type = input.type as ClientCommType;
  const overrides = input.slot_overrides || {};
  const context: RenderContext = input.context || {};

  if (input.action === 'preview') {
    const preview = await previewCommunication(params.id, type, overrides, context, input.recipients);
    if ('error' in preview) throw badRequest(preview.error);
    return success(preview);
  }

  const result = await sendCommunication(params.id, type, {
    slotOverrides: overrides,
    triggeredBy: teamMemberId,
    context,
    recipients: input.recipients,
  });
  if (!result.success) throw badRequest(result.error || 'Send failed');

  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/communications`,
    entityType: 'client_communication',
    entityId: result.communicationId,
    apiKeyId,
    teamMemberId,
    requestBody: { action: input.action, type: input.type, recipients: input.recipients },
    statusCode: 200,
  });
  return success({ sent: true, communication_id: result.communicationId });
}, { schema: postSchema, permission: 'communications.manage' });
