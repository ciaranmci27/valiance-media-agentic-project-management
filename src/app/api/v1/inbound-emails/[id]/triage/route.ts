import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';
import { accessAllowsProject } from '@/lib/api/access';
import { formatEventTitle } from '@/lib/agent-events';
import { isGoneError, loadAccessibleMessage, type AccessibleMessage } from '@/lib/communications/agent-access';
import { triageSchema, type TriageRequest } from '@/lib/communications/schemas';
import { comms } from '@/lib/communications/db';

export const dynamic = 'force-dynamic';

function unprocessable(message: string, details?: unknown) {
  return new ApiError(422, 'VALIDATION_ERROR', message, details);
}

function idempotencyConflict(triageId?: string) {
  return new ApiError(409, 'CONFLICT', 'This idempotency_key was already used for a different triage of this email', {
    reason: 'idempotency_conflict',
    ...(triageId ? { triage_id: triageId } : {}),
  });
}

/** The projects a triage names, project_ids and the older project_id together, once each, sorted. */
function namedProjects(body: TriageRequest): string[] {
  return [...new Set([...(body.project_ids ?? []), ...(body.project_id ? [body.project_id] : [])].map((id) => id.toLowerCase()))].sort();
}

/**
 * The same request, however its optional fields and links are spelled, hashes
 * the same; one project named either way hashes as the older project_id did,
 * so a retry across versions replays instead of conflicting.
 */
function requestHash(body: TriageRequest): string {
  const links = [...new Set(body.links.map((link) => `${link.task_id.toLowerCase()}:${link.relation}`))].sort();
  const projects = namedProjects(body);
  return createHash('sha256').update(JSON.stringify([
    body.outcome,
    body.urgent,
    body.summary,
    body.question_for_human ?? null,
    body.suggested_reply ?? null,
    projects.length <= 1 ? projects[0] ?? null : projects,
    links,
    body.thread_summary ?? null,
  ])).digest('hex');
}

interface Recorded {
  triage: { id: string; project_ids?: string[] };
  status: string;
  thread: { id: string; project_id: string | null; project_source: string | null; projects?: { project_id: string; source: string }[] };
  replayed: boolean;
}

/** The conversation as a triage response shows it: its strongest project and every project. */
async function conversationJson(supabase: SupabaseClient, conversationId: string): Promise<Recorded['thread']> {
  const { data, error } = await comms(supabase).rpc('conversation_projects_json', { p_conversation_id: conversationId });
  if (error) throw error;
  if (!data) throw notFound('Email');
  return data as Recorded['thread'];
}

/** A retry of a key already used on this email: the first triage, unchanged. */
async function priorTriage(supabase: SupabaseClient, message: AccessibleMessage, key: string, hash: string): Promise<Recorded | null> {
  const { data: prior, error } = await comms(supabase).from('triage').select('*')
    .eq('message_id', message.id).eq('idempotency_key', key).maybeSingle();
  if (error) throw error;
  if (!prior) return null;
  const { request_hash: priorHash, ...triage } = prior as { id: string; request_hash: string | null };
  if (priorHash !== hash) throw idempotencyConflict(triage.id);
  return { triage, status: message.status, thread: await conversationJson(supabase, message.thread_id), replayed: true };
}

/**
 * Records a triage (history is kept; the newest wins) and sets the email's
 * status: needs_human when the outcome is needs_human, or the sender is
 * untrusted and it is not a notification left alone, otherwise handled.
 * A triage files the email on every project it names (project_ids, or the
 * older project_id) and on every linked task's project, each within the
 * email's project scope (communications.scope_source: the conversation's
 * projects, its project addresses, its sender's mappings, and any project
 * taking mail once a verified teammate, verified meeting notes or a person's
 * answer is behind it). The database refuses anything else and writes
 * nothing then (422 project_out_of_scope, with the scope). A project named
 * now must be active unless the conversation is already on it. It never
 * creates a contact or domain mapping. With an idempotency_key already used
 * on this email, the same body returns the first triage (200, nothing
 * recorded, no second activity) and a different body is 409. Nothing here
 * sends email.
 */
export const POST = withApi<TriageRequest, { id: string }>(async ({ supabase, params, body, teamMemberId, apiKeyId, access }) => {
  const message = await loadAccessibleMessage(supabase, teamMemberId, access, params.id);
  const key = body.idempotency_key ?? null;
  const hash = key ? requestHash(body) : null;
  if (key && hash) {
    const replay = await priorTriage(supabase, message, key, hash);
    if (replay) return success(replay);
  }

  const [{ data: row, error: rowError }, { data: filedRows, error: filedError }] = await Promise.all([
    comms(supabase).from('messages').select('auth, kind').eq('id', message.id).single(),
    comms(supabase).from('conversation_projects').select('project_id').eq('conversation_id', message.thread_id),
  ]);
  // Deleted while this request ran: the same 404 as an id that never existed.
  if (rowError) throw isGoneError(rowError) ? notFound('Email') : rowError;
  if (filedError) throw filedError;
  const filed = new Set(((filedRows ?? []) as { project_id: string }[]).map((r) => r.project_id));

  // Named projects: real, open to this key, active unless already filed.
  const named = namedProjects(body);
  if (named.length > 0) {
    const { data: projects, error } = await supabase.from('projects').select('id, status, archived_at').in('id', named).is('deleted_at', null);
    if (error) throw error;
    const byId = new Map(((projects ?? []) as { id: string; status: string; archived_at: string | null }[]).map((p) => [p.id, p]));
    for (const projectId of named) {
      const project = byId.get(projectId);
      if (!project) throw unprocessable('project_id does not name a project', { project_id: projectId });
      if (!accessAllowsProject(access, projectId, 'api')) {
        throw forbidden('Project scope denied', { reason: 'project_scope', grant_on: 'project_membership', project_id: projectId });
      }
      if (!filed.has(projectId) && (project.status !== 'active' || project.archived_at)) {
        throw unprocessable('This project is not active, so email cannot be filed to it. Choose an active project, or leave it out and flag it as needs_human.', {
          reason: 'project_inactive',
          project_id: projectId,
          status: project.status,
          archived: !!project.archived_at,
        });
      }
    }
  }

  // Links: real tasks, each on a project this key may open.
  const links = body.links ?? [];
  if (links.length > 0) {
    const taskIds = [...new Set(links.map((link) => link.task_id))];
    const { data: tasks, error } = await supabase.from('tasks').select('id, project_id, project:projects!inner(id)').in('id', taskIds).is('deleted_at', null).is('project.deleted_at', null);
    if (error) throw error;
    const byId = new Map(((tasks ?? []) as { id: string; project_id: string }[]).map((task) => [task.id, task]));
    for (const link of links) {
      const task = byId.get(link.task_id);
      if (!task) throw unprocessable('Each link must name an existing task', { task_id: link.task_id });
      if (!accessAllowsProject(access, task.project_id, 'api')) {
        throw forbidden('Project scope denied', { reason: 'project_scope', grant_on: 'project_membership', project_id: task.project_id });
      }
    }
  }

  // An unverified sender is never acted on unchecked: a person's email, or
  // any email that touched a task, waits for a person. An unverified
  // notification read and left alone does not.
  const trust = ((row.auth ?? {}) as { trust?: string }).trust;
  const machine = row.kind === 'notification' || row.kind === 'marketing';
  const status = body.outcome === 'needs_human' || (trust === 'untrusted' && (!machine || links.length > 0)) ? 'needs_human' : 'handled';
  const { data, error } = await comms(supabase).rpc('record_triage', {
    p_message_id: message.id,
    p_member_id: teamMemberId,
    p_triage: {
      outcome: body.outcome,
      urgent: body.urgent,
      summary: body.summary,
      question_for_human: body.question_for_human ?? null,
      suggested_reply: body.suggested_reply ?? null,
      thread_summary: body.thread_summary ?? null,
    },
    p_links: links,
    p_project_ids: named,
    p_status: status,
    p_idempotency_key: key,
    p_request_hash: hash,
  });
  if (error) {
    const text = error.message ?? '';
    if (text.includes('EMAIL_PROJECT_OUT_OF_SCOPE')) {
      const { data: scope } = await comms(supabase).rpc('message_scope', { p_message_id: message.id });
      throw unprocessable('This email may not touch that project: file it on a project in its scope, or flag it as needs_human and ask which project.', {
        reason: 'project_out_of_scope',
        project_id: (error as { details?: string }).details ?? null,
        project_scope: scope ?? null,
      });
    }
    if (text.includes('EMAIL_IDEMPOTENCY_CONFLICT')) throw idempotencyConflict();
    if (text.includes('EMAIL_LINK_TASK_NOT_FOUND')) throw unprocessable('Each link must name an existing task', { reason: 'reference_deleted' });
    if (isGoneError(error)) throw notFound('Email');
    // A linked task or a named project was deleted after the checks above.
    if (error.code === '23503') {
      throw unprocessable('A task or project named in this triage no longer exists', { reason: 'reference_deleted' });
    }
    throw error;
  }
  const recorded = data as Recorded;
  // A concurrent retry of the same key recorded it first: nothing new happened.
  if (recorded.replayed) return success(recorded);

  if (access.role === 'agent') {
    const projectIds = recorded.triage.project_ids ?? [];
    const payload = { message_id: message.id, thread_id: message.thread_id, outcome: body.outcome, urgent: body.urgent, links: links.length };
    afterResponse('email.triaged activity', async () => {
      const { error: activityError } = await supabase.from('agent_activities').insert({
        agent_id: teamMemberId,
        // One project lands on that project's feed; several on none, listed in the metadata.
        project_id: projectIds.length === 1 ? projectIds[0] : projectIds.length === 0 ? recorded.thread.project_id : null,
        activity_type: 'email.triaged',
        title: formatEventTitle('email.triaged', payload),
        description: '',
        reference_type: null,
        reference_id: null,
        metadata: { ...payload, channel: 'email', project_ids: projectIds },
      });
      if (activityError) throw activityError;
    });
  }
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/inbound-emails/${message.id}/triage`,
    entityType: 'email_triage',
    entityId: recorded.triage.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: recorded,
    statusCode: 201,
  });
  return created(recorded);
}, { schema: triageSchema, permission: 'inbound_email.triage' });
