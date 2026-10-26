import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/communications/agent-access';
import { comms } from '@/lib/communications/db';

export const dynamic = 'force-dynamic';

/**
 * For the host dispatcher's one-a-minute poll: new mail waiting, triage
 * waiting for the batched summary, and reply drafts people asked for,
 * across the member's inboxes (or one).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  if (inboxIds.length === 0) return success({ new_count: 0, newest_received_at: null, unsummarized_count: 0, drafts_requested: 0 });
  const { data, error } = await comms(supabase).rpc('signal', { p_inbox_ids: inboxIds });
  if (error) throw error;
  const signal = (data ?? {}) as { new_count?: number | string; newest_received_at?: string | null; unsummarized_count?: number | string; drafts_requested?: number | string };
  return success({
    new_count: Number(signal.new_count ?? 0),
    newest_received_at: signal.newest_received_at ?? null,
    unsummarized_count: Number(signal.unsummarized_count ?? 0),
    drafts_requested: Number(signal.drafts_requested ?? 0),
  });
}, { permission: 'inbound_email.signal' });
