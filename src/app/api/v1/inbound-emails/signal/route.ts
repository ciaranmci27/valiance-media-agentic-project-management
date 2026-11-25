import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { inboxScope } from '@/lib/communications/agent-access';
import { handledParam, narrowToHandled } from '@/lib/communications/inbox-handlers';
import { comms } from '@/lib/communications/db';
import { inboxModes, planSignal } from '@/lib/communications/triage-context';

export const dynamic = 'force-dynamic';

/**
 * For the host dispatcher's one-a-minute poll: new mail waiting, triage
 * worth a line in the batched summary (something done, or waiting on a
 * person), reply drafts people asked for and questions still waiting, across
 * the member's inboxes (or one). new_count covers the inboxes the old
 * triage runs (legacy and shadow); plans_new_count the messages ready to
 * plan (plan inboxes' mail, and every meeting) and plans_newest_received_at
 * the newest of them, which wake the plan triage as new_count wakes the old;
 * plans_newest_queued_at the newest time any of them joined the queue, by
 * arriving or by going back to New (sent back, answered: requeued_at), so a
 * dispatcher waking on a newer time also wakes for an old message sent back;
 * shadow_pending_count what a shadow triage has left. handled=me counts only
 * the inboxes the key's member handles (as itself or through a group).
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const inboxIds = await narrowToHandled(supabase, teamMemberId, await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id')), handledParam(searchParams));
  if (inboxIds.length === 0) {
    return success({ new_count: 0, newest_received_at: null, unsummarized_count: 0, drafts_requested: 0, waiting_count: 0, plans_new_count: 0, plans_newest_received_at: null, plans_newest_queued_at: null, shadow_pending_count: 0 });
  }
  const modes = await inboxModes(supabase, inboxIds);
  const legacy = inboxIds.filter((id) => (modes.get(id) ?? 'legacy') !== 'plans');
  const [all, old, plans, meetings] = await Promise.all([
    comms(supabase).rpc('signal', { p_inbox_ids: inboxIds }),
    legacy.length === inboxIds.length ? Promise.resolve(null) : comms(supabase).rpc('signal', { p_inbox_ids: legacy }),
    planSignal(supabase, inboxIds),
    // A meeting is planned (plans_new_count), never worked by the old triage.
    legacy.length
      ? comms(supabase).from('messages').select('id', { count: 'exact', head: true }).in('inbox_id', legacy).eq('status', 'new').eq('channel', 'meeting')
      : Promise.resolve({ count: 0, error: null }),
  ]);
  if (all.error) throw all.error;
  if (old?.error) throw old.error;
  if (meetings.error) throw meetings.error;
  type Signal = { new_count?: number | string; newest_received_at?: string | null; unsummarized_count?: number | string; drafts_requested?: number | string; waiting_count?: number | string };
  const signal = (all.data ?? {}) as Signal;
  const oldSignal = (old ? old.data ?? {} : signal) as Signal;
  return success({
    new_count: Math.max(0, Number(oldSignal.new_count ?? 0) - (meetings.count ?? 0)),
    newest_received_at: oldSignal.newest_received_at ?? null,
    unsummarized_count: Number(signal.unsummarized_count ?? 0),
    drafts_requested: Number(signal.drafts_requested ?? 0),
    waiting_count: Number(signal.waiting_count ?? 0),
    ...plans,
  });
}, { permission: 'inbound_email.signal' });
