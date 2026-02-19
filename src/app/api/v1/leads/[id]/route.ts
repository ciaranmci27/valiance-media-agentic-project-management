import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { patchLead } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('leads')
    .select('*, lead_members(member_id)')
    .eq('id', (params as any).id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead');

  const lead = {
    ...data,
    member_ids: (data.lead_members || []).map((lm: any) => lm.member_id),
    lead_members: undefined,
  };

  return success(lead);
});

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { member_ids, ...updates } = body as any;
  const lead = await patchLead(supabase, (params as any).id, updates, member_ids);
  return success(lead);
}, { schema: updateLeadSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  // Soft delete: set archived_at
  const { data, error } = await supabase
    .from('leads')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', (params as any).id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Lead');
  return success({ archived: true, archived_at: data.archived_at });
});
