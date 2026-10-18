import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { accessAllowsProject } from '@/lib/api/access';

export const dynamic = 'force-dynamic';

const relayedSchema = z.object({
  invoice_ids: z.array(z.string().uuid()).min(1).max(100),
}).strict();

/**
 * Marks invoice drafts as passed on by the PM agent, so the next check does
 * not repeat them. Ids outside the key's projects are ignored and reported.
 */
export const POST = withApi<{ invoice_ids: string[] }>(async ({ supabase, body, access }) => {
  const { data, error } = await supabase
    .from('billing_draft_notices')
    .select('invoice_id, project_id')
    .in('invoice_id', body.invoice_ids);
  if (error) throw error;
  const allowed = (data ?? []).filter((row) => accessAllowsProject(access, row.project_id as string, 'api')).map((row) => row.invoice_id as string);
  if (allowed.length > 0) {
    const { error: updateError } = await supabase
      .from('billing_draft_notices')
      .update({ relayed_at: new Date().toISOString() })
      .in('invoice_id', allowed);
    if (updateError) throw updateError;
  }
  return success({ marked: allowed.length, ignored: body.invoice_ids.filter((id) => !allowed.includes(id)) });
}, { schema: relayedSchema, permission: 'invoices.read' });
