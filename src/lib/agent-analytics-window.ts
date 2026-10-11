import type { AgentActivity, FleetAgentActivity } from '@/lib/types';
import type { AttributionDelta } from '@/lib/agent-telemetry-analytics';

/**
 * The compact answer of the agent_analytics_window database function
 * (20261011033458_agent_analytics_window.sql), turned back into the rows the
 * read models already understand. Pure, so a test can prove the compact path
 * and the raw-row path give identical analytics.
 *
 * - Turns come back as activity rows whose metadata holds only the fields the
 *   read model reads. Turn tokens arrive pre-summed, carried as `input` so the
 *   model's sum (input + output + cache read + cache write) is unchanged.
 * - Usage comes back summed per agent, project and hour, as one synthetic
 *   usage.recorded row per hour. They carry no session, so token attribution
 *   never double counts them; the directed sessions' raw deltas come back
 *   separately as `attribution`.
 */

type Turn = [string, string, string, string | null, string | null, number, string | null, string | null,
  string | null, string | null, string | null, string | null, string | null, string | null, number | null];
type UsageHour = [string, string | null, string, number, number, number, number, number];
type SessionDelta = [string, string, string, number];
type EventRow = [string, string | null, string | null, string, string | null, string, Record<string, unknown>];

export interface AnalyticsWindowPayload {
  turns: Turn[];
  usage_hours: UsageHour[];
  session_usage: SessionDelta[];
  events: EventRow[];
}

const row = (fields: Pick<AgentActivity, 'id' | 'agent_id' | 'project_id' | 'activity_type' | 'reference_id' | 'metadata' | 'created_at'>): AgentActivity => ({
  ...fields,
  title: '',
  description: '',
  reference_type: fields.reference_id ? 'task' : null,
});

// Postgres hands timestamps back with "+00:00"; the raw rows use ISO "Z".
const iso = (value: string) => new Date(value).toISOString();

export function activitiesFromWindow(payload: AnalyticsWindowPayload): {
  rows: AgentActivity[];
  fleet: FleetAgentActivity[];
  attribution: AttributionDelta[];
} {
  const rows: AgentActivity[] = [];
  const fleet: FleetAgentActivity[] = [];

  for (const [id, agentId, createdAt, sourceTurnId, origin, durationMs, startedAt, outcome, outcomeSource,
    jobName, trigger, sessionId, model, tokensScope, tokens] of payload.turns ?? []) {
    const metadata: Record<string, unknown> = { source_turn_id: sourceTurnId, origin, duration_ms: durationMs, started_at: startedAt };
    if (outcome) metadata.outcome = outcome;
    if (outcomeSource) metadata.outcome_source = outcomeSource;
    if (jobName) metadata.job_name = jobName;
    if (trigger) metadata.trigger = trigger;
    if (sessionId) metadata.session_id = sessionId;
    if (model) metadata.model = model;
    if (tokensScope) metadata.tokens_scope = tokensScope;
    if (tokens !== null && tokens !== undefined) metadata.tokens = { input: tokens };
    rows.push(row({ id, agent_id: agentId, project_id: null, activity_type: 'turn.completed', reference_id: null, metadata, created_at: iso(createdAt) }));
  }

  for (const [agentId, projectId, hour, input, output, cached, cost, deltas] of payload.usage_hours ?? []) {
    const at = iso(hour);
    rows.push(row({
      id: `usage-hour:${agentId}:${projectId ?? ''}:${at}`,
      agent_id: agentId,
      project_id: projectId,
      activity_type: 'usage.recorded',
      reference_id: null,
      metadata: {
        source_usage_id: `hour:${agentId}:${projectId ?? ''}:${at}`,
        input_tokens: Number(input), output_tokens: Number(output), cached_tokens: Number(cached),
        cost_usd: Number(cost), recorded_at: at, deltas: Number(deltas),
      },
      created_at: at,
    }));
  }

  for (const [id, agentId, projectId, type, referenceId, createdAt, metadata] of payload.events ?? []) {
    const event = row({ id, agent_id: agentId as string, project_id: projectId, activity_type: type, reference_id: referenceId, metadata: metadata ?? {}, created_at: iso(createdAt) });
    if (agentId === null) fleet.push({ ...event, agent_id: null });
    else rows.push(event);
  }

  const attribution = (payload.session_usage ?? []).map(([agentId, sessionId, at, tokens]) => ({
    agentId, sessionId, at: Date.parse(at), tokens: Number(tokens),
  }));
  return { rows, fleet, attribution };
}
