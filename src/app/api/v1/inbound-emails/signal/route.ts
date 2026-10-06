import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/inbound-email/agent-access';

export const dynamic = 'force-dynamic';

/**
 * For the host dispatcher's one-a-minute poll: new mail waiting and triage
 * waiting for the batched summary, across the member's inboxes (or one).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId }) => {
  const inboxIds = await inboxScope(supabase, teamMemberId, searchParams.get('inbox_id'));
  if (inboxIds.length === 0) return success({ new_count: 0, newest_received_at: null, unsummarized_count: 0 });
  const { data, error } = await supabase.rpc('email_signal', { p_inbox_ids: inboxIds });
  if (error) throw error;
  const signal = (data ?? {}) as { new_count?: number | string; newest_received_at?: string | null; unsummarized_count?: number | string };
  return success({
    new_count: Number(signal.new_count ?? 0),
    newest_received_at: signal.newest_received_at ?? null,
    unsummarized_count: Number(signal.unsummarized_count ?? 0),
  });
}, { permission: 'inbound_email.signal' });
