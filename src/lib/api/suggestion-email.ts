import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccessChannel, AccessContext } from '@/lib/access-control';
import { accessAllowsProject } from './access';
import { ApiError } from './errors';
import { comms } from '@/lib/communications/db';
import { readableInboxIdsFor } from '@/lib/communications/inbox-visibility';

/**
 * A task an agent made from an email becomes a suggestion when its rules
 * need approval (the suggestion keeps the email in metadata.message_id).
 * Once it is approved, the email is linked to the new task as created, and
 * the task's project filed on the conversation: what the agent's create
 * would have done. A person's approval files it as theirs (in scope by
 * their say); an agent approver's only where the email's scope allows, and
 * otherwise the link is refused (EMAIL_PROJECT_OUT_OF_SCOPE) while the
 * approval stands. The server does it (the browser is never
 * granted pm.link_message_task), and only for the person who approved it,
 * while they can open the task and read the email's inbox.
 *
 * Each access refusal is an answer, not an error (reason says why nothing
 * was linked); a refusal from the database, such as the scope, is thrown,
 * and the approve routes log it, so an approval never fails for want of
 * the link.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SuggestionEmailLink =
  | { linked: true; message_id: string; task_id: string }
  | { linked: false; reason: 'not_found' | 'no_email' | 'not_approved' | 'not_approver' | 'task_out_of_reach' | 'email_gone' | 'inbox_not_readable' };

export async function linkApprovedSuggestionEmail(
  service: SupabaseClient,
  input: { suggestionId: string; memberId: string; access: AccessContext; channel: AccessChannel },
): Promise<SuggestionEmailLink> {
  if (!UUID.test(input.suggestionId)) return { linked: false, reason: 'not_found' };
  const { data: suggestion, error } = await service.from('task_suggestions')
    .select('id, status, reviewed_by, converted_task_id, metadata').eq('id', input.suggestionId).maybeSingle();
  if (error) throw error;
  if (!suggestion) return { linked: false, reason: 'not_found' };
  const row = suggestion as { status: string; reviewed_by: string | null; converted_task_id: string | null; metadata: Record<string, unknown> | null };
  const messageId = row.metadata?.message_id;
  if (typeof messageId !== 'string' || !UUID.test(messageId)) return { linked: false, reason: 'no_email' };
  if (row.status !== 'approved' || !row.converted_task_id) return { linked: false, reason: 'not_approved' };
  if (row.reviewed_by !== input.memberId) return { linked: false, reason: 'not_approver' };

  const { data: task, error: taskError } = await service.from('tasks')
    .select('id, project_id').eq('id', row.converted_task_id).is('deleted_at', null).maybeSingle();
  if (taskError) throw taskError;
  const live = task as { id: string; project_id: string } | null;
  if (!live || !accessAllowsProject(input.access, live.project_id, input.channel)) return { linked: false, reason: 'task_out_of_reach' };

  const { data: message, error: messageError } = await comms(service).from('messages')
    .select('id, inbox_id').eq('id', messageId).neq('status', 'receiving').maybeSingle();
  if (messageError) throw messageError;
  const email = message as { id: string; inbox_id: string } | null;
  if (!email) return { linked: false, reason: 'email_gone' };
  const readable = await readableInboxIdsFor(service, input.memberId, input.access, input.channel);
  if (!readable.includes(email.inbox_id)) return { linked: false, reason: 'inbox_not_readable' };

  const { error: linkError } = await comms(service).rpc('link_message_task', {
    // A person files the project as theirs; an agent approver only within the email's scope (else EMAIL_PROJECT_OUT_OF_SCOPE).
    p_message_id: email.id, p_task_id: live.id, p_relation: 'created', p_member_id: input.memberId, p_as_person: input.access.role !== 'agent',
  });
  if (linkError) throw linkError;
  return { linked: true, message_id: email.id, task_id: live.id };
}

/**
 * A suggestion made over the API that names an email (metadata.message_id)
 * must name one the key's member reads, since approving it links that email:
 * 422 message_not_readable otherwise (an id that is not an email, or one in
 * an inbox out of reach, alike). A suggestion naming none is not checked.
 */
export async function assertSuggestionEmailReadable(
  service: SupabaseClient,
  input: { memberId: string; access: AccessContext; metadata: unknown },
): Promise<void> {
  const messageId = input.metadata && typeof input.metadata === 'object' ? (input.metadata as Record<string, unknown>).message_id : undefined;
  if (messageId === undefined || messageId === null) return;
  const refused = () => new ApiError(422, 'VALIDATION_ERROR', 'metadata.message_id must name an email this key can read', {
    reason: 'message_not_readable', field: 'metadata.message_id',
  });
  if (typeof messageId !== 'string' || !UUID.test(messageId)) throw refused();
  const { data, error } = await comms(service).from('messages').select('inbox_id').eq('id', messageId).neq('status', 'receiving').maybeSingle();
  if (error) throw error;
  const inboxId = (data as { inbox_id: string } | null)?.inbox_id;
  if (!inboxId || !(await readableInboxIdsFor(service, input.memberId, input.access, 'api')).includes(inboxId)) throw refused();
}
