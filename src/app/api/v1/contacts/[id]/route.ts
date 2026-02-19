import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';

export const GET = withApi(async ({ supabase, params }) => {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', (params as any).id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Contact');
  return success(data);
});

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { data, error } = await supabase
    .from('contacts')
    .update(body)
    .eq('id', (params as any).id)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw notFound('Contact');
  return success(data);
}, { schema: updateContactSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { error } = await supabase
    .from('contacts')
    .delete()
    .eq('id', (params as any).id);

  if (error) throw error;
  return success({ deleted: true });
});
