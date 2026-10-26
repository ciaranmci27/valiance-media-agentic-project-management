import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { InboxReplyDraft } from './inbox-types';
import { InboxError, assertCanTriage, loadReadableThread, many, one, type InboxContext } from './inbox-service';
import { comms } from '@/lib/communications/db';

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

export const DRAFT_COLUMNS = 'id, thread_id, message_id, status, instructions, body, failure, requested_by, drafted_by, created_at, completed_at';

type DraftRow = {
  id: string; thread_id: string; message_id: string; status: InboxReplyDraft['status']; instructions: string; body: string | null;
  failure: string | null; requested_by: string | null; drafted_by: string | null; created_at: string; completed_at: string | null;
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
  }));
}

/** The thread's newest draft, waiting or done. */
export async function latestDraft(ctx: InboxContext, threadId: string): Promise<InboxReplyDraft | null> {
  const row = await one<DraftRow & Record<string, unknown>>(comms(ctx.service).from('reply_drafts').select(DRAFT_COLUMNS)
    .eq('thread_id', threadId).order('created_at', { ascending: false }).limit(1).maybeSingle());
  return row ? (await presentDrafts(ctx.service, [row]))[0] : null;
}

export async function requestReplyDraft(ctx: InboxContext, threadId: string, request: RequestDraftRequest): Promise<InboxReplyDraft> {
  assertCanTriage(ctx.access);
  const thread = await loadReadableThread(ctx, threadId);
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
