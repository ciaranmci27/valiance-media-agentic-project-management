import { withApi } from '@/lib/api/middleware';
import { success, paginated } from '@/lib/api/response';
import { upsertLeadFieldsSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { upsertLeadField } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);

  const { data, count, error } = await supabase
    .from('lead_fields')
    .select('*', { count: 'exact' })
    .eq('lead_id', id)
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const PUT = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;

  const { data: lead } = await supabase.from('leads').select('id').eq('id', id).maybeSingle();
  if (!lead) throw notFound('Lead');

  const { fields } = body as any;

  const results = [];
  for (const field of fields) {
    const result = await upsertLeadField(supabase, id, field.field_key, field.value);
    results.push(result);
  }

  logAudit(supabase, { method: 'PUT', endpoint: `/api/v1/leads/${id}/fields`, entityType: 'lead_field', entityId: id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: results, statusCode: 200 });
  return success(results);
}, { schema: upsertLeadFieldsSchema });
