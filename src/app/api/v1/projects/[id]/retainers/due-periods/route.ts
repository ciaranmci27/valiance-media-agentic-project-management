import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { fetchRetainerDuePeriods } from '@/lib/supabase/queries';

export const dynamic = 'force-dynamic';

/**
 * Retainer periods whose bill date has come and that no invoice covers yet
 * (the app's "Due now" list): retainer_id, period_start, period_end,
 * bill_date, amount (prorated when partial) and full_amount. Draft one with
 * POST .../retainers/{retainerId}/periods.
 */
export const GET = withApi(async ({ supabase, params }) => {
  return success(await fetchRetainerDuePeriods(supabase, params.id));
}, { permission: 'invoices.manage' });
