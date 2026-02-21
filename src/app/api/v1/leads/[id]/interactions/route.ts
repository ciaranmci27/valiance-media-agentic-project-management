import { withApi } from '@/lib/api/middleware';
import { paginated, created } from '@/lib/api/response';
import { createLeadInteractionSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { insertLeadInteraction } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { parsePagination } from '@/lib/api/pagination';

export const GET = withApi(async ({ supabase, params, searchParams }) => {
  const { id } = params as any;
  const { page, limit, offset } = parsePagination(searchParams);
  const type = searchParams.get('type');
  const completed = searchParams.get('completed');

  let query = supabase
    .from('lead_interactions')
    .select('*', { count: 'exact' })
    .eq('lead_id', id);

  if (type) query = query.eq('type', type);
  if (completed === 'true' || completed === 'false') {
    query = query.eq('completed', completed === 'true');
  }

  const { data, count, error } = await query
    .order('occurred_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
});

export const POST = withApi(async ({ supabase, params, body, apiKeyId, teamMemberId }) => {
  const { id } = params as any;

  const { data: lead } = await supabase.from('leads').select('id').eq('id', id).maybeSingle();
  if (!lead) throw notFound('Lead');

  const interaction = await insertLeadInteraction(supabase, { ...body as any, lead_id: id, created_by: teamMemberId || null });
  logAudit(supabase, { method: 'POST', endpoint: `/api/v1/leads/${id}/interactions`, entityType: 'lead_interaction', entityId: interaction.id, apiKeyId, teamMemberId, requestBody: body, afterSnapshot: interaction, statusCode: 201 });
  return created(interaction);
}, { schema: createLeadInteractionSchema });
