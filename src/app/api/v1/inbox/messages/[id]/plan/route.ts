import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { notFound } from '@/lib/api/errors';
import { logAudit } from '@/lib/api/audit';
import { afterResponse } from '@/lib/api/after-response';
import { formatEventTitle } from '@/lib/agent-events';
import { isGoneError, loadAccessibleMessage } from '@/lib/communications/agent-access';
import { comms } from '@/lib/communications/db';
import { planSchema, type PlanRequest } from '@/lib/communications/plan-schemas';
import { submitPlan } from '@/lib/communications/plans';

export const dynamic = 'force-dynamic';

/**
 * A triage plan for one message: a summary and its items. Every item is
 * checked first (one bad item rejects the plan: 422 with each problem, nothing
 * written), then the policy decides each: apply, apply unsure, propose (waits
 * for a person, who is notified) or reject, with its reason. In live mode the
 * app applies what may apply, records the triage the Inbox and the summary
 * feed read, and sets the message's status; in shadow mode it only records
 * the decisions. The same idempotency_key with the same body replays (and
 * finishes an interrupted plan); with another body it is 409.
 */
export const POST = withApi<PlanRequest, { id: string }>(async ({ supabase, params, body, teamMemberId, apiKeyId, access, scopes }) => {
  const accessible = await loadAccessibleMessage(supabase, teamMemberId, access, params.id);
  const { data: row, error } = await comms(supabase).from('messages').select('subject').eq('id', accessible.id).single();
  if (error) throw isGoneError(error) ? notFound('Email') : error;
  const message = { id: accessible.id, thread_id: accessible.thread_id, inbox_id: accessible.inbox_id, subject: (row as { subject: string | null }).subject };
  const { data: member } = await supabase.from('team_members').select('name').eq('id', teamMemberId).maybeSingle();
  const agentName = ((member as { name?: string } | null)?.name ?? '').split(/\s+/)[0];

  const result = await submitPlan({ db: supabase, memberId: teamMemberId, access, channel: 'api', scopes, asPerson: false }, message, body, agentName);
  if (result.replayed) return success(result);

  if (access.role === 'agent' && result.plan.mode === 'live') {
    const count = (state: string) => result.items.filter((item) => item.state === state).length;
    const projectIds = [...new Set(result.items.map((item) => item.project_id as string | null).filter((id): id is string => !!id))];
    const payload = { message_id: message.id, thread_id: message.thread_id, outcome: 'plan', urgent: body.urgent, links: result.items.filter((i) => i.type === 'link_task' || i.type === 'create_task').length };
    afterResponse('email.triaged activity', async () => {
      const { error: activityError } = await supabase.from('agent_activities').insert({
        agent_id: teamMemberId,
        project_id: projectIds.length === 1 ? projectIds[0] : null,
        activity_type: 'email.triaged',
        title: formatEventTitle('email.triaged', payload),
        description: '',
        reference_type: null,
        reference_id: null,
        metadata: {
          ...payload, channel: 'email', plan_id: result.plan.id, project_ids: projectIds,
          applied: count('done'), proposed: count('pending'), failed: count('failed'), rejected: count('skipped'),
        },
      });
      if (activityError) throw activityError;
    });
  }
  logAudit(supabase, {
    method: 'POST',
    endpoint: `/api/v1/inbox/messages/${message.id}/plan`,
    entityType: 'email_triage',
    entityId: result.plan.id as string,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: result,
    statusCode: 201,
  });
  return created(result);
}, { schema: planSchema, permission: 'inbound_email.triage' });
