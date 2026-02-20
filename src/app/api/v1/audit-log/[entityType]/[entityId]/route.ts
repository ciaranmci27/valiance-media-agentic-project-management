import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { fetchAuditLogForEntity } from '@/lib/supabase/queries';

export const GET = withApi<unknown, { entityType: string; entityId: string }>(async ({ supabase, params }) => {
  const entries = await fetchAuditLogForEntity(supabase, params.entityType, params.entityId);
  return success(entries);
});
