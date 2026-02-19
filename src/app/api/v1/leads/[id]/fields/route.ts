import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { upsertLeadFieldsSchema } from '@/lib/schemas';
import { upsertLeadField } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;

  const { data, error } = await supabase
    .from('lead_fields')
    .select('*')
    .eq('lead_id', id)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return success(data || []);
});

export const PUT = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const { fields } = body as any;

  const results = [];
  for (const field of fields) {
    const result = await upsertLeadField(supabase, id, field.field_key, field.value);
    results.push(result);
  }

  return success(results);
}, { schema: upsertLeadFieldsSchema });
