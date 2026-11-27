/**
 * A meeting's suggestions, settled in one go. From a meeting the agent only
 * suggests (plan items waiting for an OK); a person then:
 *
 * - "Add all": accepts every waiting suggestion of the meeting, one by one
 *   through the same accept path as the Add button (acceptPlanItem), so each
 *   is applied as theirs. Questions are left for an answer. A second call
 *   (or one running at the same time) finds nothing waiting, or loses the
 *   claim on each item, and adds nothing twice. Undo is the existing per-item
 *   undo, newest first.
 * - "Nothing to do": skips every waiting suggestion and question (dismissed,
 *   as theirs), marks the messages handled and reviewed, and records who
 *   said so on communications.meetings. Nothing is created, trashed or
 *   closed (not even a "Reply to" reminder, as Mark handled would). It returns what it changed, so Undo can put exactly that back.
 *
 * Only what the thread shows counts: the newest live plan of each message.
 * Email is refused: an email thread settles suggestions one at a time and
 * has no meeting row to record a dismissal on.
 */
import { z } from 'zod';
import { comms } from '../db';
import { assertId, InboxError, loadTriageableThread, many, markThreadHandled, one, type InboxContext } from '../inbox-service';
import { acceptPlanItem } from '../inbox-plans';
import type { MeetingAddAllResult, MeetingDismissResult, MeetingDismissUndo, MeetingHandledMessage } from '../inbox-types';
import { inboxAgentName, syncWaitingNotification, type PlanMessage } from '../plans';

type Row = Record<string, unknown>;

/** The receipt "Nothing to do" answered, sent back to undo it (the app and the API). */
export const meetingDismissUndoSchema = z.object({
  skipped: z.array(z.string()).max(500),
  handled: z.array(z.object({
    id: z.string(),
    status: z.enum(['new', 'needs_human', 'handled']),
    unreviewed: z.boolean(),
  })).max(500),
});

async function meetingThread(ctx: InboxContext, threadId: string) {
  const thread = await loadTriageableThread(ctx, threadId);
  if (thread.channel !== 'meeting') {
    throw new InboxError(409, 'Only a meeting settles its suggestions all at once. For an email, add or skip each one.');
  }
  return thread;
}

/** The waiting items of the newest live plan of each message, in the order the thread lists them. */
async function waitingItems(ctx: InboxContext, threadId: string): Promise<{ id: string; type: string; payload: Row }[]> {
  const plans = await many<{ id: string; message_id: string; created_at: string }>(comms(ctx.service).from('plans')
    .select('id, message_id, created_at').eq('conversation_id', threadId).eq('mode', 'live').order('created_at', { ascending: false }));
  const newest = new Map<string, { id: string; created_at: string }>();
  for (const plan of plans) if (!newest.has(plan.message_id)) newest.set(plan.message_id, plan);
  if (!newest.size) return [];
  const order = new Map([...newest.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((plan, index) => [plan.id, index]));
  const items = await many<{ id: string; plan_id: string; position: number; type: string; payload: Row }>(comms(ctx.service).from('plan_items')
    .select('id, plan_id, position, type, payload').in('plan_id', [...order.keys()]).eq('state', 'pending'));
  return items.sort((a, b) => (order.get(a.plan_id)! - order.get(b.plan_id)!) || a.position - b.position);
}

/** What a suggestion is, in a few words, for a failure line. */
function itemName(item: { type: string; payload: Row }): string {
  const title = item.payload?.title;
  return typeof title === 'string' && title ? title : item.type.replace('_', ' ');
}

/** Add all: every waiting suggestion of the meeting, accepted as the person's. */
export async function addAllSuggestions(ctx: InboxContext, threadId: string): Promise<MeetingAddAllResult> {
  const thread = await meetingThread(ctx, threadId);
  const items = (await waitingItems(ctx, thread.id)).filter((item) => item.type !== 'ask');
  const added: string[] = [];
  const failed: MeetingAddAllResult['failed'] = [];
  for (const item of items) {
    try {
      await acceptPlanItem(ctx, item.id);
      added.push(item.id);
    } catch (error) {
      // Settled meanwhile (another Add, Add all or Skip claimed it first): not a failure.
      if (error instanceof InboxError && error.status === 409) continue;
      // One that cannot go through (a task gone since, out of reach) waits on; the rest still go.
      if (!(error instanceof InboxError)) console.error('[inbox] add all: a suggestion failed:', error);
      failed.push({ id: item.id, label: itemName(item), error: error instanceof InboxError ? error.message : 'It did not go through' });
    }
  }
  return { added, failed };
}

/** Nothing to do: skip what waits, mark the messages handled, record the dismissal. */
export async function dismissMeeting(ctx: InboxContext, threadId: string): Promise<MeetingDismissResult> {
  const thread = await meetingThread(ctx, threadId);
  const now = new Date().toISOString();
  const waiting = await waitingItems(ctx, thread.id);
  const skipped = waiting.length
    ? await many<{ id: string }>(comms(ctx.service).from('plan_items')
        .update({ state: 'dismissed', resolved_by: ctx.memberId, resolved_at: now })
        .in('id', waiting.map((item) => item.id)).eq('state', 'pending').select('id'))
    : [];
  // What the messages were, so Undo puts back exactly what this changed.
  const messages = await many<PlanMessage & Row & { status: string; reviewed_at: string | null }>(comms(ctx.service).from('messages')
    .select('id, thread_id, inbox_id, subject, status, reviewed_at').eq('thread_id', thread.id).neq('status', 'receiving'));
  const handled: MeetingHandledMessage[] = messages
    .filter((m) => m.status === 'new' || m.status === 'needs_human' || (m.status === 'handled' && !m.reviewed_at))
    .map((m) => ({ id: m.id, status: m.status as MeetingHandledMessage['status'], unreviewed: !m.reviewed_at }));
  // Only the messages: Nothing to do closes no reminder, so its Undo has nothing else to reopen.
  await markThreadHandled(ctx, thread.id, { closeReplyReminders: false });
  const marked = await one<{ dismissed_at: string }>(comms(ctx.service).from('meetings')
    .update({ dismissed_at: now, dismissed_by: ctx.memberId }).eq('conversation_id', thread.id).select('dismissed_at').maybeSingle());
  await syncNotifications(ctx, thread.inbox_id, messages);
  const me = await one<{ name: string }>(ctx.service.from('team_members').select('name').eq('id', ctx.memberId).maybeSingle());
  return {
    skipped: skipped.map((row) => row.id),
    handled,
    dismissed: { at: marked?.dismissed_at ?? now, by: { id: ctx.memberId, name: me?.name ?? 'You' } },
  };
}

/**
 * Undo "Nothing to do": the suggestions it skipped wait again, the messages
 * it handled go back to how they were, and the mark clears. Only this
 * meeting's items and messages, and only while they are still as it left
 * them (skipped, handled by this person).
 */
export async function undoMeetingDismissal(ctx: InboxContext, threadId: string, undo: MeetingDismissUndo): Promise<{ cleared: boolean }> {
  const thread = await meetingThread(ctx, threadId);
  const itemIds = [...new Set(undo.skipped)].map((id) => assertId(id, 'item id'));
  const handled = undo.handled.map((m) => {
    if (!['new', 'needs_human', 'handled'].includes(m.status)) throw new InboxError(422, 'A message can only go back to New, Needs you or Handled');
    return { ...m, id: assertId(m.id, 'message id') };
  });
  if (itemIds.length) {
    const ours = await many<{ id: string }>(comms(ctx.service).from('plan_items').select('id').in('id', itemIds).eq('conversation_id', thread.id));
    if (ours.length !== itemIds.length) throw new InboxError(422, 'Those suggestions are not on this meeting');
  }
  if (handled.length) {
    const ours = await many<{ id: string }>(comms(ctx.service).from('messages').select('id').in('id', handled.map((m) => m.id)).eq('thread_id', thread.id));
    if (ours.length !== handled.length) throw new InboxError(422, 'Those messages are not on this meeting');
  }
  if (itemIds.length) {
    const { error } = await comms(ctx.service).from('plan_items').update({ state: 'pending', resolved_by: null, resolved_at: null })
      .in('id', itemIds).eq('state', 'dismissed').eq('resolved_by', ctx.memberId);
    if (error) throw error;
  }
  for (const message of handled) {
    const { error } = await comms(ctx.service).from('messages')
      .update({ status: message.status, ...(message.unreviewed ? { reviewed_at: null, reviewed_by: null } : {}) })
      .eq('id', message.id).eq('status', 'handled').eq('reviewed_by', ctx.memberId);
    if (error) throw error;
  }
  const rows = await many<{ conversation_id: string }>(comms(ctx.service).from('meetings')
    .update({ dismissed_at: null, dismissed_by: null }).eq('conversation_id', thread.id).not('dismissed_at', 'is', null).select('conversation_id'));
  const messages = await many<PlanMessage & Row>(comms(ctx.service).from('messages').select('id, thread_id, inbox_id, subject').eq('thread_id', thread.id));
  await syncNotifications(ctx, thread.inbox_id, messages);
  return { cleared: rows.length > 0 };
}

/** The "needs you" notifications follow what waits. Bookkeeping only: the change itself stands. */
async function syncNotifications(ctx: InboxContext, inboxId: string, messages: PlanMessage[]) {
  try {
    const agentName = await inboxAgentName(ctx.service, inboxId);
    for (const message of messages) await syncWaitingNotification(ctx.service, message, agentName);
  } catch (bookkeeping) {
    console.error('[inbox] meeting suggestions: notification bookkeeping failed:', bookkeeping);
  }
}
