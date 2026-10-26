import { withApi } from '@/lib/api/middleware';
import { success } from '@/lib/api/response';
import { badRequest } from '@/lib/api/errors';
import { inboxScope } from '@/lib/communications/agent-access';
import { DRAFT_COLUMNS } from '@/lib/communications/inbox-drafts';
import { comms } from '@/lib/communications/db';

export const dynamic = 'force-dynamic';

const STATUSES = ['requested', 'ready', 'failed'] as const;

interface DraftRow {
  id: string; status: string; thread_id: string; message_id: string; instructions: string; body: string | null;
  failure: string | null; requested_by: string | null; created_at: string; completed_at: string | null;
}

/**
 * Reply drafts people asked for, in the key's inboxes, oldest first
 * (default status requested). Each names the email to answer
 * (message_id, its thread and subject) and what the person wants said.
 * Read the email with GET /api/v1/inbound-emails/:message_id first.
 */
export const GET = withApi(async ({ supabase, searchParams, teamMemberId, access }) => {
  const status = searchParams.get('status') ?? 'requested';
  if (!(STATUSES as readonly string[]).includes(status)) throw badRequest('status must be requested, ready or failed');
  const inboxIds = await inboxScope(supabase, teamMemberId, access, searchParams.get('inbox_id'));
  if (inboxIds.length === 0) return success([]);
  // Scoped to the key's inboxes before any cap: the drafts on its threads only.
  const drafts: DraftRow[] = [];
  const newestFirst = status !== 'requested';
  for (let from = 0; drafts.length < 50; from += 500) {
    const { data, error } = await comms(supabase).from('reply_drafts').select(DRAFT_COLUMNS).eq('status', status)
      .order('created_at', { ascending: !newestFirst }).range(from, from + 499);
    if (error) throw error;
    const page = (data ?? []) as DraftRow[];
    if (page.length === 0) break;
    const { data: owned, error: ownedError } = await comms(supabase).from('messages').select('id')
      .in('id', [...new Set(page.map((draft) => draft.message_id))]).in('inbox_id', inboxIds);
    if (ownedError) throw ownedError;
    const mine = new Set(((owned ?? []) as { id: string }[]).map((row) => row.id));
    drafts.push(...page.filter((draft) => mine.has(draft.message_id)));
    if (page.length < 500) break;
  }
  if (drafts.length === 0) return success([]);
  const [{ data: messages, error: messageError }, { data: people, error: peopleError }] = await Promise.all([
    comms(supabase).from('messages').select('id, inbox_id, subject').in('id', [...new Set(drafts.map((draft) => draft.message_id))]),
    supabase.from('team_members').select('id, name').in('id', [...new Set(drafts.map((draft) => draft.requested_by).filter((id): id is string => !!id))]),
  ]);
  if (messageError) throw messageError;
  if (peopleError) throw peopleError;
  const messageById = new Map(((messages ?? []) as { id: string; inbox_id: string; subject: string }[]).map((message) => [message.id, message]));
  const nameById = new Map(((people ?? []) as { id: string; name: string }[]).map((person) => [person.id, person.name]));
  return success(drafts
    .slice(0, 50)
    .map((draft) => ({
      id: draft.id,
      status: draft.status,
      thread_id: draft.thread_id,
      conversation_id: draft.thread_id,
      message_id: draft.message_id,
      subject: messageById.get(draft.message_id)?.subject ?? '',
      instructions: draft.instructions,
      requested_by: draft.requested_by ? nameById.get(draft.requested_by) ?? null : null,
      body: draft.body,
      failure: draft.failure,
      created_at: draft.created_at,
      completed_at: draft.completed_at,
    })));
}, { permission: 'inbound_email.read' });
