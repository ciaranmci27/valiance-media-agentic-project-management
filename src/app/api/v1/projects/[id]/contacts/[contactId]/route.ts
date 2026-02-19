import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { updateProjectContactSchema } from '@/lib/schemas';
import { notFound } from '@/lib/api/errors';
import { updateProjectContact, removeProjectContact } from '@/lib/supabase/queries';

export const PATCH = withApi(async ({ supabase, params, body }) => {
  const { id, contactId } = params as any;
  const pc = await updateProjectContact(supabase, contactId, id, body as any);
  return success(pc);
}, { schema: updateProjectContactSchema });

export const DELETE = withApi(async ({ supabase, params }) => {
  const { contactId } = params as any;
  await removeProjectContact(supabase, contactId);
  return success({ deleted: true });
});
