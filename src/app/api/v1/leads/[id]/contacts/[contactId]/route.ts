import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateLeadContactSchema } from '@/lib/schemas';
import { updateLeadContact, removeLeadContact } from '@/lib/supabase/queries';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { id, contactId } = params as any;
  const lc = await updateLeadContact(supabase, contactId, id, body as any);
  return success(lc);
}, { schema: updateLeadContactSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { contactId } = params as any;
  await removeLeadContact(supabase, contactId);
  return success({ deleted: true });
});
