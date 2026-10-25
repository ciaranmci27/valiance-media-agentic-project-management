import { z } from 'zod';
import { withApi } from '@/lib/api/middleware';
import { created, paginated } from '@/lib/api/response';
import { createAgentActivitySchema, type LegacyAgentActivity, type TypedAgentEvent } from '@/lib/schemas/agent-activity';
import { formatEventTitle, HOST_RECORD_EVENT_TYPES, isAgentEventType } from '@/lib/agent-events';
import { requireAgentsEnabled } from '@/lib/api/agents';
import { parsePagination } from '@/lib/api/pagination';
import { forbidden, badRequest } from '@/lib/api/errors';
import { insertAgentActivity } from '@/lib/supabase/queries';
import { logAudit } from '@/lib/api/audit';
import { accessAllowsProject } from '@/lib/api/access';
import { hasPermission } from '@/lib/access-control';
import { isUuid, mergeOutcome, metadataIdentity, sourceKey } from '@/lib/agent-telemetry-ingest';
import type { AgentActivity } from '@/lib/types';

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
  // Host records (restarts, wakes, attention, gaps, evals, failures, late
  // labels) are measurement written about an agent, not by it. Readers of the
  // plain feed (the dispatcher's progress mark, the agents' own recent-activity
  // reads) would take each one as fresh activity, so they appear only when
  // asked for by type. Turns and usage stay, as before: the dispatcher reads a
  // directed turn as progress.
  else query = query.not('activity_type', 'in', `(${HOST_RECORD_EVENT_TYPES.join(',')})`);

  const { data, count, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;
  return paginated(data || [], { page, limit, total: count || 0 });
}, { permission: 'audit.read' });

export const POST = withApi(async ({ supabase, body, apiKeyId, teamMemberId, access, scopes }) => {
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

  const parsed = body as z.infer<typeof createAgentActivitySchema>;

  // A fleet key (the host dispatcher's) speaks for the fleet, not for the
  // member it is linked to: it may post only host alerts that name no agent,
  // and those rows carry no agent at all. Anything else from it is refused
  // rather than quietly attributed to that member. A key that can also log
  // agent activity is an agent's own key, so the fleet scope on it changes
  // nothing (one stray scope must not stall that agent's telemetry).
  const fleetKey = scopes.includes('fleet_alerts.write')
    && !scopes.includes('agent_activity.write')
    && hasPermission(access, 'fleet_alerts.write', 'api');
  if (fleetKey) {
    const payload = (parsed as TypedAgentEvent).payload as Record<string, unknown> | undefined;
    if (parsed.activity_type !== 'attention.message' || payload?.kind !== 'host_alert') {
      throw forbidden('A fleet key may only post attention.message host alerts', { reason: 'fleet_key_scope' });
    }
  }
  const agentId: string | null = fleetKey ? null : teamMemberId;

  // Typed events carry no title by design: the server composes the one
  // canonical sentence per type, and the validated payload is stored in
  // metadata where queries can reach it. Legacy shapes pass through
  // unchanged until every plugin speaks the typed contract.
  const record = isAgentEventType(parsed.activity_type)
    ? (() => {
        const typed = parsed as TypedAgentEvent;
        const payload = typed.payload as Record<string, unknown>;
        // Host records keep task_id as sent; only a real uuid becomes a reference.
        // Without one in the payload, the event's own reference stands (the
        // plugins name the task, lead or contact there).
        const taskId = isUuid(payload.task_id) ? payload.task_id : null;
        const sent = !taskId && ['task', 'lead', 'contact'].includes(typed.reference_type ?? '') && isUuid(typed.reference_id)
          ? { type: typed.reference_type as string, id: typed.reference_id }
          : null;
        return {
          project_id: typed.project_id,
          activity_type: typed.activity_type,
          title: formatEventTitle(typed.activity_type, payload),
          description: '',
          reference_type: taskId ? 'task' : sent?.type ?? null,
          reference_id: taskId ?? sent?.id ?? null,
          metadata: payload,
          source_key: sourceKey(typed.activity_type, payload),
        };
      })()
    : { ...(parsed as LegacyAgentActivity), source_key: null };

  // Host publishers and merge scripts retry after ambiguous network failures.
  // Make their natural source identities idempotent at the API door: the
  // pre-check handles the common resend, and the partial unique indexes close
  // the race between concurrent retries (the 23505 catch below).
  const metadata = record.metadata as Record<string, unknown>;
  const identity = isAgentEventType(parsed.activity_type)
    ? metadataIdentity(parsed.activity_type, metadata)
    : null;
  const hasIdentity = Boolean(identity || record.source_key);

  const findExisting = async (type: string = parsed.activity_type) => {
    let query = supabase
      .from('agent_activities')
      .select('*')
      .eq('activity_type', type);
    query = agentId ? query.eq('agent_id', agentId) : query.is('agent_id', null);
    // Equality on the indexed identity, never a jsonb containment scan: the
    // partial unique indexes on metadata->>'source_turn_id' (and usage, PR)
    // answer these in one probe, where @> read every one of the agent's rows.
    if (record.source_key && type === parsed.activity_type) {
      query = query.eq('source_key', record.source_key);
    } else {
      const [field, value] = Object.entries(identity ?? { source_turn_id: metadata.source_turn_id })[0];
      query = query.eq(`metadata->>${field}`, String(value));
    }
    const { data: existing, error: existingError } = await query.limit(1).maybeSingle();
    if (existingError) throw existingError;
    return existing as AgentActivity | null;
  };

  // A late label merges onto its turn. It adds no runtime, so it is only
  // stored as its own row while the turn is missing, and the turn absorbs it
  // when it arrives (below). Resends change nothing.
  if (parsed.activity_type === 'turn.outcome') {
    const turn = await findExisting('turn.completed');
    if (turn) {
      const merged = mergeOutcome(turn.metadata ?? {}, metadata);
      if (!merged) return created(turn);
      const { data: updated, error: updateError } = await supabase
        .from('agent_activities')
        .update({ metadata: merged })
        .eq('id', turn.id)
        .select()
        .single();
      if (updateError) throw updateError;
      logAudit(supabase, {
        method: 'POST',
        endpoint: '/api/v1/agent-activities',
        entityType: 'agent_activities',
        entityId: turn.id,
        apiKeyId,
        teamMemberId,
        requestBody: body,
        beforeSnapshot: turn,
        afterSnapshot: updated,
        statusCode: 201,
      });
      return created(updated);
    }
  }

  if (hasIdentity) {
    const existing = await findExisting();
    if (existing) return created(existing);
  }

  // A turn arriving after its label (the label was kept as its own row).
  if (parsed.activity_type === 'turn.completed' && (typeof metadata.outcome !== 'string' || metadata.outcome === 'unknown')) {
    const label = await findExisting('turn.outcome');
    const merged = label ? mergeOutcome(metadata, label.metadata ?? {}) : null;
    if (merged) record.metadata = merged;
  }

  let entry;
  try {
    entry = await insertAgentActivity(supabase, {
      ...record,
      agent_id: agentId,
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
}, { schema: createAgentActivitySchema, permission: ['agent_activity.write', 'fleet_alerts.write'] });
