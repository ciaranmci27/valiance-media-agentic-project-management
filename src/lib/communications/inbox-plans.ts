/**
 * What a person does with triage plans in the Inbox: accept a proposal
 * (applied as theirs, optionally edited), dismiss it, undo an applied item or
 * a whole plan, resolve a reply owed. Each checks the person can triage the
 * conversation's inbox, like every other Inbox action.
 */
import { assertCanTriage, assertId, InboxError, loadReadableThread, type InboxContext } from './inbox-service';
import { comms } from './db';
import { acceptItem, dismissItem, inboxAgentName, loadPlanItem, PlanError, syncWaitingNotification, undoItem, undoPlan, type PlanActor } from './plans';
import type { PlanItemRequest } from './plan-schemas';

type Row = Record<string, unknown>;

function actorOf(ctx: InboxContext): PlanActor {
  return { db: ctx.service, memberId: ctx.memberId, access: ctx.access, channel: 'app', asPerson: true };
}

/** The plan's own errors as the Inbox's. */
async function inboxErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PlanError) throw new InboxError(error.statusCode, error.message);
    throw error;
  }
}

async function readableItem(ctx: InboxContext, itemId: string) {
  assertCanTriage(ctx.access);
  const { item, message } = await inboxErrors(() => loadPlanItem(ctx.service, assertId(itemId, 'item id')));
  await loadReadableThread(ctx, message.thread_id);
  return { item, message };
}

/** Fields a person may change on a proposal before accepting it. */
export interface AcceptEdits {
  project_id?: string;
  task_id?: string;
  title?: string;
  due_date?: string | null;
}

export async function acceptPlanItem(ctx: InboxContext, itemId: string, edits: AcceptEdits = {}): Promise<Row> {
  const { message } = await readableItem(ctx, itemId);
  const agentName = await inboxAgentName(ctx.service, message.inbox_id);
  return inboxErrors(() => acceptItem(actorOf(ctx), itemId, edits as Partial<PlanItemRequest>, agentName));
}

export async function dismissPlanItem(ctx: InboxContext, itemId: string): Promise<{ dismissed: true }> {
  const { message } = await readableItem(ctx, itemId);
  const agentName = await inboxAgentName(ctx.service, message.inbox_id);
  await inboxErrors(() => dismissItem(actorOf(ctx), itemId, agentName));
  return { dismissed: true };
}

export async function undoPlanItem(ctx: InboxContext, itemId: string): Promise<Row> {
  const { message } = await readableItem(ctx, itemId);
  const result = await inboxErrors(() => undoItem(actorOf(ctx), itemId));
  await syncWaitingNotification(ctx.service, message, await inboxAgentName(ctx.service, message.inbox_id));
  return result;
}

export async function undoWholePlan(ctx: InboxContext, planId: string): Promise<{ items: Row[] }> {
  assertCanTriage(ctx.access);
  const id = assertId(planId, 'plan id');
  const { data: plan, error } = await comms(ctx.service).from('plans').select('id, message_id, conversation_id, mode').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!plan || (plan as Row).mode !== 'live') throw new InboxError(404, 'Plan not found');
  await loadReadableThread(ctx, (plan as Row).conversation_id as string);
  return { items: await inboxErrors(() => undoPlan(actorOf(ctx), id)) };
}

export async function resolveReplyPoint(ctx: InboxContext, pointId: string): Promise<{ resolved: true }> {
  assertCanTriage(ctx.access);
  const id = assertId(pointId, 'reply id');
  const { data: point, error } = await comms(ctx.service).from('reply_points').select('id, conversation_id, message_id, state').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!point) throw new InboxError(404, 'Not found');
  await loadReadableThread(ctx, (point as Row).conversation_id as string);
  const { error: updateError } = await comms(ctx.service).from('reply_points')
    .update({ state: 'resolved', resolved_by: ctx.memberId, resolved_at: new Date().toISOString() }).eq('id', id);
  if (updateError) throw updateError;
  if ((point as Row).message_id) {
    const { data: message } = await comms(ctx.service).from('messages').select('id, thread_id, inbox_id, subject').eq('id', (point as Row).message_id as string).maybeSingle();
    if (message) await syncWaitingNotification(ctx.service, message as never, await inboxAgentName(ctx.service, (message as Row).inbox_id as string));
  }
  return { resolved: true };
}
