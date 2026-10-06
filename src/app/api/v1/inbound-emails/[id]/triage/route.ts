import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError, forbidden, notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';
import { accessAllowsProject } from '@/lib/api/access';
import { emailTaskHumanOnly, translateEmailTaskGuard } from '@/lib/api/task-guards';
import { formatEventTitle } from '@/lib/agent-events';
import { isGoneError, loadAccessibleMessage, type AccessibleMessage } from '@/lib/inbound-email/agent-access';
import { triageSchema, type TriageRequest } from '@/lib/inbound-email/schemas';

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

/** The same request, however its optional fields and links are spelled, hashes the same. */
function requestHash(body: TriageRequest): string {
  const links = [...new Set(body.links.map((link) => `${link.task_id.toLowerCase()}:${link.relation}`))].sort();
  return createHash('sha256').update(JSON.stringify([
    body.outcome,
    body.urgent,
    body.summary,
    body.question_for_ciaran ?? null,
    body.suggested_reply ?? null,
    body.project_id?.toLowerCase() ?? null,
    links,
  ])).digest('hex');
}

interface Recorded {
  triage: { id: string };
  status: string;
  thread: { id: string; project_id: string | null; project_source: string | null };
  replayed: boolean;
}

/** A retry of a key already used on this email: the first triage, unchanged. */
async function priorTriage(supabase: SupabaseClient, message: AccessibleMessage, key: string, hash: string): Promise<Recorded | null> {
  const { data: prior, error } = await supabase.from('email_triage').select('*')
    .eq('message_id', message.id).eq('idempotency_key', key).maybeSingle();
  if (error) throw error;
  if (!prior) return null;
  const { request_hash: priorHash, ...triage } = prior as { id: string; request_hash: string | null };
  if (priorHash !== hash) throw idempotencyConflict(triage.id);
  const { data: thread, error: threadError } = await supabase.from('email_threads')
    .select('id, project_id, project_source').eq('id', message.thread_id).single();
  if (threadError) throw isGoneError(threadError) ? notFound('Email') : threadError;
  return { triage, status: message.status, thread, replayed: true };
}

/**
 * Records a triage (history is kept; the newest wins) and sets the email's
 * status: needs_ciaran when the outcome is needs_ciaran or the sender is
 * untrusted, otherwise handled. project_id is taken only while the thread
 * has no project, and only from the mapping candidates when there are any;
 * it sets the thread's project as inferred (chosen among the candidates) or
 * guessed (the email had none). It never creates a contact or
 * domain mapping. links must name tasks in that project; an email-sourced
 * task that is already ai_ready cannot be linked as created, nor by its own
 * creator (rule 3). A project chosen now must be active (not completed,
 * archived or archived_at). With an idempotency_key already used on this
 * email, the same body returns the first triage (200, nothing recorded, no
 * second activity) and a different body is 409. Nothing here sends email.
 */
export const POST = withApi<TriageRequest, { id: string }>(async ({ supabase, params, body, teamMemberId, apiKeyId, access }) => {
  const message = await loadAccessibleMessage(supabase, teamMemberId, params.id);
  const key = body.idempotency_key ?? null;
  const hash = key ? requestHash(body) : null;
  if (key && hash) {
    const replay = await priorTriage(supabase, message, key, hash);
    if (replay) return success(replay);
  }

  const [{ data: thread, error: threadError }, { data: row, error: rowError }, { data: candidateRows, error: candidateError }] = await Promise.all([
    supabase.from('email_threads').select('id, project_id, project_source').eq('id', message.thread_id).single(),
    supabase.from('email_messages').select('auth').eq('id', message.id).single(),
    supabase.from('email_message_candidates').select('project_id').eq('message_id', message.id),
  ]);
  // Deleted while this request ran: the same 404 as an id that never existed.
  if (threadError) throw isGoneError(threadError) ? notFound('Email') : threadError;
  if (rowError) throw isGoneError(rowError) ? notFound('Email') : rowError;
  if (candidateError) throw candidateError;
  const candidates = [...new Set(((candidateRows ?? []) as { project_id: string }[]).map((c) => c.project_id))];

  // The project: the thread's, or the one chosen now for a thread without one.
  let chosenProject: string | null = null;
  if (body.project_id) {
    if (thread.project_id && thread.project_id !== body.project_id) {
      throw new ApiError(409, 'CONFLICT', 'This thread already belongs to a project; project_id cannot change it', {
        reason: 'thread_project_set',
        project_id: thread.project_id,
        project_source: thread.project_source,
      });
    }
    if (!thread.project_id) {
      if (candidates.length > 0 && !candidates.includes(body.project_id)) {
        throw unprocessable('project_id must be one of the candidate projects', { candidate_project_ids: candidates });
      }
      const { data: project, error } = await supabase.from('projects').select('id, status, archived_at').eq('id', body.project_id).maybeSingle();
      if (error) throw error;
      if (!project) throw unprocessable('project_id does not name a project');
      if (!accessAllowsProject(access, body.project_id, 'api')) {
        throw forbidden('Project scope denied', { reason: 'project_scope', grant_on: 'project_membership', project_id: body.project_id });
      }
      if (project.status !== 'active' || project.archived_at) {
        throw unprocessable('This project is not active, so email cannot be filed to it. Choose an active project, or leave project_id out and flag it for Ciaran.', {
          reason: 'project_inactive',
          project_id: body.project_id,
          status: project.status,
          archived: !!project.archived_at,
        });
      }
      chosenProject = body.project_id;
    }
  }
  const effectiveProject = thread.project_id ?? chosenProject;

  // Links: real tasks in that project, and rule 3.
  const links = body.links ?? [];
  if (links.length > 0) {
    if (!effectiveProject) {
      throw unprocessable('Links need a project: this thread has none, so pass project_id');
    }
    const taskIds = [...new Set(links.map((link) => link.task_id))];
    const { data: tasks, error } = await supabase.from('tasks').select('id, project_id, ai_readiness, created_by').in('id', taskIds);
    if (error) throw error;
    const byId = new Map(((tasks ?? []) as { id: string; project_id: string; ai_readiness: string | null; created_by: string | null }[])
      .map((task) => [task.id, task]));
    for (const link of links) {
      const task = byId.get(link.task_id);
      if (!task || task.project_id !== effectiveProject) {
        throw unprocessable('Each link must name an existing task in the email\'s project', { task_id: link.task_id, project_id: effectiveProject });
      }
      if (task.ai_readiness === 'ai_ready' && (link.relation === 'created' || task.created_by === teamMemberId)) {
        throw emailTaskHumanOnly();
      }
    }
  }

  const trust = ((row.auth ?? {}) as { trust?: string }).trust;
  const status = body.outcome === 'needs_ciaran' || trust === 'untrusted' ? 'needs_ciaran' : 'handled';
  const { data, error } = await supabase.rpc('email_record_triage', {
    p_message_id: message.id,
    p_member_id: teamMemberId,
    p_triage: {
      outcome: body.outcome,
      urgent: body.urgent,
      summary: body.summary,
      question_for_ciaran: body.question_for_ciaran ?? null,
      suggested_reply: body.suggested_reply ?? null,
    },
    p_links: links,
    p_project_id: chosenProject,
    p_status: status,
    p_idempotency_key: key,
    p_request_hash: hash,
  });
  if (error) {
    const text = error.message ?? '';
    if (text.includes('EMAIL_THREAD_PROJECT_SET')) {
      throw new ApiError(409, 'CONFLICT', 'This thread already belongs to a project; project_id cannot change it', { reason: 'thread_project_set' });
    }
    if (text.includes('EMAIL_IDEMPOTENCY_CONFLICT')) throw idempotencyConflict();
    if (isGoneError(error)) throw notFound('Email');
    // A linked task or the chosen project was deleted after the checks above.
    if (error.code === '23503') {
      throw unprocessable('A task or project named in this triage no longer exists', { reason: 'reference_deleted' });
    }
    throw translateEmailTaskGuard(error);
  }
  const recorded = data as Recorded;
  // A concurrent retry of the same key recorded it first: nothing new happened.
  if (recorded.replayed) return success(recorded);

  if (access.role === 'agent') {
    const payload = { message_id: message.id, thread_id: message.thread_id, outcome: body.outcome, urgent: body.urgent, links: links.length };
    afterResponse('email.triaged activity', async () => {
      const { error: activityError } = await supabase.from('agent_activities').insert({
        agent_id: teamMemberId,
        project_id: recorded.thread.project_id,
        activity_type: 'email.triaged',
        title: formatEventTitle('email.triaged', payload),
        description: '',
        reference_type: null,
        reference_id: null,
        metadata: payload,
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
