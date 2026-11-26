import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { InboxReplyDraft } from './inbox-types';
import { InboxError, loadTriageableThread, many, one, type InboxContext } from './inbox-service';
import { comms } from '@/lib/communications/db';
import { inboxDecisionRecipients, primaryPersonHandler } from './inbox-handlers';
import { inboxOwnerOf } from './inbox-visibility';

/**
 * Reply drafts on request. A person asks for one on a thread (optionally
 * saying what to say); the agent's next run writes it against the newest
 * email; the person reads it in the thread and copies it into their own
 * mail. Nothing is ever sent from here. One request waits per thread: asking
 * again while one waits returns that one, unless it has waited longer than
 * DRAFT_STALE_MINUTES: then it is closed as unanswered and a new one starts.
 */

export const DRAFT_STALE_MINUTES = 30;

export const requestDraftSchema = z.object({
  instructions: z.string().trim().max(2000).default(''),
}).strict();
export type RequestDraftRequest = z.infer<typeof requestDraftSchema>;

export const DRAFT_COLUMNS = 'id, thread_id, message_id, status, instructions, body, failure, requested_by, drafted_by, created_at, completed_at, copied_at';

type DraftRow = {
  id: string; thread_id: string; message_id: string; status: InboxReplyDraft['status']; instructions: string; body: string | null;
  failure: string | null; requested_by: string | null; drafted_by: string | null; created_at: string; completed_at: string | null;
  copied_at: string | null;
};

export async function presentDrafts(service: SupabaseClient, rows: DraftRow[]): Promise<InboxReplyDraft[]> {
  const ids = [...new Set(rows.flatMap((row) => [row.requested_by, row.drafted_by]).filter((id): id is string => !!id))];
  const people = ids.length ? await many<{ id: string; name: string }>(service.from('team_members').select('id, name').in('id', ids)) : [];
  const who = (id: string | null) => {
    const person = id ? people.find((row) => row.id === id) : null;
    return person ? { id: person.id, name: person.name } : null;
  };
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    instructions: row.instructions,
    body: row.body,
    failure: row.failure,
    requested_by: who(row.requested_by),
    drafted_by: who(row.drafted_by),
    created_at: row.created_at,
    completed_at: row.completed_at,
    copied_at: row.copied_at ?? null,
  }));
}

/** The thread's newest draft, waiting or done. */
export async function latestDraft(ctx: InboxContext, threadId: string): Promise<InboxReplyDraft | null> {
  const row = await one<DraftRow & Record<string, unknown>>(comms(ctx.service).from('reply_drafts').select(DRAFT_COLUMNS)
    .eq('thread_id', threadId).order('created_at', { ascending: false }).limit(1).maybeSingle());
  return row ? (await presentDrafts(ctx.service, [row]))[0] : null;
}

export const draftCopiedSchema = z.object({ draft_id: z.string().uuid() }).strict();

/**
 * A person copied a ready draft. The first copy is the one kept: copied, and
 * then the thread marked handled, the draft is taken as (roughly) the reply
 * that went out. Copying again changes nothing.
 */
export async function markDraftCopied(ctx: InboxContext, threadId: string, draftId: string): Promise<InboxReplyDraft> {
  const thread = await loadTriageableThread(ctx, threadId);
  const { error } = await comms(ctx.service).from('reply_drafts').update({ copied_at: new Date().toISOString() })
    .eq('id', draftId).eq('thread_id', thread.id).eq('status', 'ready').is('copied_at', null);
  if (error) throw error;
  const row = await one<DraftRow & Record<string, unknown>>(comms(ctx.service).from('reply_drafts').select(DRAFT_COLUMNS)
    .eq('id', draftId).eq('thread_id', thread.id).maybeSingle());
  if (!row) throw new InboxError(404, 'Draft not found');
  if (row.status !== 'ready') throw new InboxError(409, 'Only a written draft can be copied');
  return (await presentDrafts(ctx.service, [row]))[0];
}

export async function requestReplyDraft(ctx: InboxContext, threadId: string, request: RequestDraftRequest): Promise<InboxReplyDraft> {
  const thread = await loadTriageableThread(ctx, threadId);
  const { data: inbox, error: inboxError } = await comms(ctx.service).from('inboxes').select('handler_member_id').eq('id', thread.inbox_id).maybeSingle();
  if (inboxError) throw inboxError;
  if (!inbox?.handler_member_id) throw new InboxError(409, 'This inbox has no agent to write a draft. Choose one in its settings.');
  const waiting = await one<DraftRow & Record<string, unknown>>(comms(ctx.service).from('reply_drafts').select(DRAFT_COLUMNS)
    .eq('thread_id', thread.id).eq('status', 'requested').order('created_at', { ascending: false }).limit(1).maybeSingle());
  if (waiting) {
    if (Date.now() - Date.parse(waiting.created_at) < DRAFT_STALE_MINUTES * 60_000) return (await presentDrafts(ctx.service, [waiting]))[0];
    // Unanswered too long: closed, so a fresh ask is not stuck behind it.
    const { error } = await comms(ctx.service).from('reply_drafts').update({
      status: 'failed', failure: `No draft came back within ${DRAFT_STALE_MINUTES} minutes.`, completed_at: new Date().toISOString(),
    }).eq('thread_id', thread.id).eq('status', 'requested');
    if (error) throw error;
  }
  const newest = await one<{ id: string }>(comms(ctx.service).from('messages').select('id')
    .eq('thread_id', thread.id).neq('status', 'receiving').order('received_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle());
  if (!newest) throw new InboxError(404, 'This thread has no email to reply to');
  const row = await one<DraftRow & Record<string, unknown>>(comms(ctx.service).from('reply_drafts').insert({
    thread_id: thread.id,
    message_id: newest.id,
    requested_by: ctx.memberId,
    instructions: request.instructions,
  }).select(DRAFT_COLUMNS).single());
  if (!row) throw new InboxError(500, 'Could not ask for a draft');
  return (await presentDrafts(ctx.service, [row]))[0];
}

/**
 * Who a ready draft is for, to copy and send: the inbox's primary handler
 * when that is a person; when an agent handles the inbox, its decision
 * recipient (a member, or a group's active members); else the workspace
 * Owners (a personal inbox: its owner). The person who asked for the draft
 * is told too (once, when they are among those already). Never the agent
 * that wrote it.
 */
export async function draftRecipientIds(service: SupabaseClient, inboxId: string, drafterId: string | null, requesterId: string | null = null): Promise<string[]> {
  const person = await primaryPersonHandler(service, inboxId);
  let ids = person ? [person] : await inboxDecisionRecipients(service, inboxId);
  if (!ids) {
    const owner = await inboxOwnerOf(service, inboxId);
    ids = owner
      ? [owner]
      : (await many<{ id: string }>(service.from('team_members').select('id').eq('role', 'owner').eq('status', 'active'))).map((row) => row.id);
  }
  if (requesterId && !ids.includes(requesterId)) {
    const requester = await one<{ role: string; status: string }>(service.from('team_members').select('role, status').eq('id', requesterId).maybeSingle());
    if (requester && requester.role !== 'agent' && requester.status === 'active') ids = [...ids, requesterId];
  }
  return [...new Set(ids)].filter((id) => id !== drafterId);
}

/** The bell for a ready draft, one per draft, on the email it answers. Returns how many were told. */
export async function notifyDraftReady(service: SupabaseClient, draft: { id: string; thread_id: string; message_id: string; requested_by?: string | null }, inboxId: string, drafterId: string | null): Promise<number> {
  const recipients = await draftRecipientIds(service, inboxId, drafterId, draft.requested_by ?? null);
  if (!recipients.length) return 0;
  const [message, drafter] = await Promise.all([
    one<{ subject: string | null }>(comms(service).from('messages').select('subject').eq('id', draft.message_id).maybeSingle()),
    drafterId ? one<{ name: string | null }>(service.from('team_members').select('name').eq('id', drafterId).maybeSingle()) : Promise.resolve(null),
  ]);
  const name = (drafter?.name ?? '').split(/\s+/)[0];
  for (const person of recipients) {
    const { error } = await service.rpc('upsert_notification', {
      p_user_id: person,
      p_title: `Reply draft ready: "${(message?.subject || 'an email').slice(0, 80)}"`,
      p_message: `${name || 'Your agent'} wrote a reply for you to copy and send.`,
      p_link: `/inbox?thread=${draft.thread_id}&message=${draft.message_id}`,
      p_entity_type: 'question',
      p_entity_id: draft.id,
    });
    if (error) throw error;
  }
  return recipients.length;
}
