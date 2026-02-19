import { withApi } from '@/lib/api/middleware';
import { success, created } from '@/lib/api/response';
import { addLeadContactSchema } from '@/lib/schemas';
import { addLeadContact } from '@/lib/supabase/queries';

export const GET = withApi(async ({ supabase, params }) => {
  const { id } = params as any;

  const { data, error } = await supabase
    .from('lead_contacts')
    .select('*, contact:contacts(*)')
    .eq('lead_id', id)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return success(data || []);
});

export const POST = withApi(async ({ supabase, params, body }) => {
  const { id } = params as any;
  const { contact_id, role, custom_role, is_primary_client } = body as any;
  const lc = await addLeadContact(supabase, id, contact_id, role, custom_role, is_primary_client);
  return created(lc);
}, { schema: addLeadContactSchema });
