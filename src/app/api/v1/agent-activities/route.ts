import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createAgentActivitySchema, type LegacyAgentActivity, type TypedAgentEvent } from '@/lib/schemas/agent-activity';
import { formatEventTitle, isAgentEventType } from '@/lib/agent-events';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { parsePagination } from '@/lib/api/pagination';
import { forbidden, badRequest } from '@/lib/api/errors';
import { insertAgentActivity } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';

export const GET = withApi(async ({ supabase, searchParams, access }) => {
  requireAgentsEnabled();

  const { page, limit, offset } = parsePagination(searchParams);
  const agentId = searchParams.get('agent_id');
  const projectId = searchParams.get('project_id');
  const activityType = searchParams.get('activity_type');

  let query = supabase
    .from('agent_activities')
    .select('*', { count: 'exact' });

  if (!access.api_permissions.includes('*') && !access.api_permissions.includes('projects.read_all')) {
    if (access.project_ids.length === 0) return paginated([], { page, limit, total: 0 });
    query = query.in('project_id', access.project_ids);
  }

  if (agentId) query = query.eq('agent_id', agentId);
  if (projectId) query = query.eq('project_id', projectId);
  if (activityType) query = query.eq('activity_type', activityType);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: 'audit.read' });

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access }) => {
  requireAgentsEnabled();

  if (!teamMemberId) {
    throw badRequest('API key must be linked to an agent team member to log activity');
  }

  // Verify the linked team member is an agent
  const { data: member } = await supabase
    .from('team_members')
    .select('id, role')
    .eq('id', teamMemberId)
    .maybeSingle();

  if (!member || member.role !== 'agent') {
    throw forbidden('Only agent team members can log activity');
  }

  const projectId = (body as { project_id?: string | null }).project_id;
  if (projectId && !accessAllowsProject(access, projectId, 'api')) {
    throw forbidden('Project scope denied');
  }

  // Typed events carry no title by design: the server composes the one
  // canonical sentence per type, and the validated payload is stored in
  // metadata where queries can reach it. Legacy shapes pass through
  // unchanged until every plugin speaks the typed contract.
  const parsed = body as z.infer<typeof createAgentActivitySchema>;
  const record = isAgentEventType(parsed.activity_type)
    ? (() => {
        const typed = parsed as TypedAgentEvent;
        const payload = typed.payload as Record<string, unknown>;
        const taskId = typeof payload.task_id === 'string' ? payload.task_id : null;
        return {
          project_id: typed.project_id,
          activity_type: typed.activity_type,
          title: formatEventTitle(typed.activity_type, payload),
          description: '',
          reference_type: taskId ? 'task' : null,
          reference_id: taskId,
          metadata: payload,
        };
      })()
    : (parsed as LegacyAgentActivity);

  // Host publishers and merge scripts retry after ambiguous network failures.
  // Make their natural source identities idempotent at the API door: the
  // pre-check handles the common resend, and the partial unique indexes close
  // the race between concurrent retries (the 23505 catch below).
  const metadata = record.metadata as Record<string, unknown>;
  const identity = !isAgentEventType(parsed.activity_type)
    ? null
    : parsed.activity_type === 'usage.recorded'
      ? { source_usage_id: metadata.source_usage_id }
      : parsed.activity_type === 'pr.merged'
        ? { pr_url: metadata.pr_url }
        : parsed.activity_type === 'turn.completed'
          ? { source_turn_id: metadata.source_turn_id }
          : null;
  const hasIdentity = Boolean(identity && Object.values(identity)[0]);

  const findExisting = async () => {
    const { data: existing, error: existingError } = await supabase
      .from('agent_activities')
      .select('*')
      .eq('agent_id', teamMemberId)
      .eq('activity_type', parsed.activity_type)
      .contains('metadata', identity!)
      .limit(1)
      .maybeSingle();
    if (existingError) throw existingError;
    return existing;
  };

  if (hasIdentity) {
    const existing = await findExisting();
    if (existing) return created(existing);
  }

  let entry;
  try {
    entry = await insertAgentActivity(supabase, {
      ...record,
      agent_id: teamMemberId,
    });
  } catch (error) {
    if (hasIdentity && (error as { code?: string } | null)?.code === '23505') {
      const existing = await findExisting();
      if (existing) return created(existing);
    }
    throw error;
  }

  logAudit(supabase, {
    method: 'POST',
    endpoint: '/api/v1/agent-activities',
    entityType: 'agent_activities',
    entityId: entry.id,
    apiKeyId,
    teamMemberId,
    requestBody: body,
    afterSnapshot: entry,
    statusCode: 201,
  });

  return created(entry);
}, { schema: createAgentActivitySchema, permission: 'agent_activity.write' });
