import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { logAudit } from '@/lib/api/audit';
import { conflict } from '@/lib/api/errors';

const createRateSchema = z.object({
  hourly_rate: z.number().min(0),
  effective_at: z.string().datetime({ offset: true }),
});

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('project_hourly_rates')
    .select('*')
    .eq('project_id', params.id)
    .order('effective_at', { ascending: false });

  if (error) throw error;
  return success(data || []);
}, { permission: 'billing.manage' });

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { data, error } = await supabase
    .from('project_hourly_rates')
    .insert({ project_id: params.id, ...(body as z.infer<typeof createRateSchema>) })
    .select()
    .single();

  if (error?.code === '23505') throw conflict('A rate already starts at that effective timestamp');
  if (error) throw error;
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/projects/${params.id}/hourly-rates`,
    entityType: 'project_hourly_rate',
    entityId: data.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: data,
    statusCode: 201,
  });
  return created(data);
}, { schema: createRateSchema, permission: 'billing.manage' });
