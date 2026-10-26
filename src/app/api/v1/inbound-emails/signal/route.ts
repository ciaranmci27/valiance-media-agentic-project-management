import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/communications/agent-access';
import { comms } from '@/lib/communications/db';
import { inboxModes, planSignal } from '@/lib/communications/triage-context';

export const dynamic = 'force-dynamic';

/**
 * For the host dispatcher's one-a-minute poll: new mail waiting, triage
 * waiting for the batched summary, and reply drafts people asked for,
 * across the member's inboxes (or one). new_count covers the inboxes the old
 * triage runs (legacy and shadow); plans_new_count the plan inboxes' mail
 * ready to plan, and shadow_pending_count what a shadow triage has left.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  if (inboxIds.length === 0) {
    return success({ new_count: 0, newest_received_at: null, unsummarized_count: 0, drafts_requested: 0, plans_new_count: 0, shadow_pending_count: 0 });
  }
  const modes = await inboxModes(supabase, inboxIds);
  const legacy = inboxIds.filter((id) => (modes.get(id) ?? 'legacy') !== 'plans');
  const [all, old, plans] = await Promise.all([
    comms(supabase).rpc('signal', { p_inbox_ids: inboxIds }),
    legacy.length === inboxIds.length ? Promise.resolve(null) : comms(supabase).rpc('signal', { p_inbox_ids: legacy }),
    planSignal(supabase, inboxIds),
  ]);
  if (all.error) throw all.error;
  if (old?.error) throw old.error;
  type Signal = { new_count?: number | string; newest_received_at?: string | null; unsummarized_count?: number | string; drafts_requested?: number | string };
  const signal = (all.data ?? {}) as Signal;
  const oldSignal = (old ? old.data ?? {} : signal) as Signal;
  return success({
    new_count: Number(oldSignal.new_count ?? 0),
    newest_received_at: oldSignal.newest_received_at ?? null,
    unsummarized_count: Number(signal.unsummarized_count ?? 0),
    drafts_requested: Number(signal.drafts_requested ?? 0),
    ...plans,
  });
}, { permission: 'inbound_email.signal' });
