import type { AgentActivity, FleetAgentActivity } from '@/lib/types';
import type { AttributionDelta } from '@/lib/agent-telemetry-analytics';
import { isOpenEventType } from '@/lib/agent-events';
import type { QuestionStats, RunStats } from '@/lib/agent-analytics-model';

/**
 * The compact answer of the agent_analytics_window database function
 * (20261011033458_agent_analytics_window.sql), or of its second version
 * agent_analytics_window_v2 (20261124001200_agent_event_pipeline.sql),
 * turned back into the rows the read models already understand. Pure, so a
 * test can prove the compact path and the raw-row path give identical
 * analytics.
 *
 * - Turns come back as activity rows whose metadata holds only the fields the
 *   read model reads. Turn tokens arrive pre-summed, carried as `input` so the
 *   model's sum (input + output + cache read + cache write) is unchanged.
 * - Usage comes back summed per agent, project and hour, as one synthetic
 *   usage.recorded row per hour. They carry no session, so token attribution
 *   never double counts them; the directed sessions' raw deltas come back
 *   separately as `attribution`.
 * - Version 2 sums usage per model, provider, labels and priced-or-not as
 *   well, so each hour row keeps its model (marked split) and never merges a
 *   priced record with an unpriced one; turns carry run_id and their own
 *   input and output tokens, and events their labels. Version 1 answers read
 *   exactly as before.
 * - Open events (note, custom.<namespace>.<name>) are left out unless
 *   includeOpenEvents asks for them: they are an agent's own words, and no
 *   total may move because an agent chose to narrate.
 */

type Turn = [string, string, string, string | null, string | null, number, string | null, string | null,
  string | null, string | null, string | null, string | null, string | null, string | null, number | null,
  // Version 2: run_id, and the turn's own input and output tokens (tokens_scope turn).
  (string | null)?, (number | null)?, (number | null)?];
type UsageHour = [string, string | null, string, number, number, number, number, number,
  // Version 2: model, provider, priced, labels.
  (string | null)?, (string | null)?, boolean?, string[]?];
type SessionDelta = [string, string, string, number];
type EventRow = [string, string | null, string | null, string, string | null, string, Record<string, unknown>,
  // Version 2: labels.
  string[]?];

export interface AnalyticsWindowPayload {
  /** 2 for agent_analytics_window_v2; absent for the first version. */
  version?: number;
  turns: Turn[];
  usage_hours: UsageHour[];
  session_usage: SessionDelta[];
  events: EventRow[];
}

const row = (fields: Pick<AgentActivity, 'id' | 'agent_id' | 'project_id' | 'activity_type' | 'reference_id' | 'metadata' | 'created_at'> & { labels?: string[] }): AgentActivity => ({
  ...fields,
  labels: fields.labels ?? [],
  title: '',
  description: '',
  reference_type: fields.reference_id ? 'task' : null,
});

// Postgres hands timestamps back with "+00:00"; the raw rows use ISO "Z".
const iso = (value: string) => new Date(value).toISOString();

export function activitiesFromWindow(payload: AnalyticsWindowPayload, options: { includeOpenEvents?: boolean } = {}): {
  rows: AgentActivity[];
  fleet: FleetAgentActivity[];
  attribution: AttributionDelta[];
} {
  const rows: AgentActivity[] = [];
  const fleet: FleetAgentActivity[] = [];

  for (const turn of payload.turns ?? []) {
    const [id, agentId, createdAt, sourceTurnId, origin, durationMs, startedAt, outcome, outcomeSource,
      jobName, trigger, sessionId, model, tokensScope, tokens, runId, ownIn, ownOut] = turn;
    const metadata: Record<string, unknown> = { source_turn_id: sourceTurnId, origin, duration_ms: durationMs, started_at: startedAt };
    if (outcome) metadata.outcome = outcome;
    if (outcomeSource) metadata.outcome_source = outcomeSource;
    if (jobName) metadata.job_name = jobName;
    if (trigger) metadata.trigger = trigger;
    if (sessionId) metadata.session_id = sessionId;
    if (model) metadata.model = model;
    if (tokensScope) metadata.tokens_scope = tokensScope;
    if (tokens !== null && tokens !== undefined) {
      // Version 2 knows a turn's own input and output: kept as sent, the rest
      // as cache, so the sum every reader takes is the same.
      const split = turn.length > 15 && tokensScope === 'turn' && (ownIn != null || ownOut != null);
      metadata.tokens = split
        ? {
          ...(ownIn != null ? { input: Number(ownIn) } : {}),
          ...(ownOut != null ? { output: Number(ownOut) } : {}),
          cache_read: Math.max(0, Number(tokens) - Number(ownIn ?? 0) - Number(ownOut ?? 0)),
        }
        : { input: tokens };
    }
    if (runId) metadata.run_id = runId;
    rows.push(row({ id, agent_id: agentId, project_id: null, activity_type: 'turn.completed', reference_id: null, metadata, created_at: iso(createdAt) }));
  }

  for (const hourRow of payload.usage_hours ?? []) {
    const [agentId, projectId, hour, input, output, cached, cost, deltas, model, provider, priced, labels] = hourRow;
    const at = iso(hour);
    // Version 2 rows are one per model, provider, labels and pricing within the hour.
    const split = hourRow.length > 8;
    const key = split
      ? `${agentId}:${projectId ?? ''}:${at}:${priced ? 'p' : 'u'}:${provider ?? ''}\u0000${model ?? ''}\u0000${(labels ?? []).join(',')}`
      : `${agentId}:${projectId ?? ''}:${at}`;
    rows.push(row({
      id: `usage-hour:${key}`,
      agent_id: agentId,
      project_id: projectId,
      activity_type: 'usage.recorded',
      reference_id: null,
      metadata: {
        source_usage_id: `hour:${key}`,
        input_tokens: Number(input), output_tokens: Number(output), cached_tokens: Number(cached),
        cost_usd: Number(cost), recorded_at: at, deltas: Number(deltas),
        ...(split ? { split: true, model: model ?? null, provider: provider ?? null } : {}),
      },
      labels: labels ?? [],
      created_at: at,
    }));
  }

  for (const [id, agentId, projectId, type, referenceId, createdAt, metadata, labels] of payload.events ?? []) {
    // An agent's own notes and custom events are not core's to count.
    if (!options.includeOpenEvents && isOpenEventType(type)) continue;
    const event = row({ id, agent_id: agentId as string, project_id: projectId, activity_type: type, reference_id: referenceId, metadata: metadata ?? {}, labels: labels ?? [], created_at: iso(createdAt) });
    if (agentId === null) fleet.push({ ...event, agent_id: null });
    else rows.push(event);
  }

  const attribution = (payload.session_usage ?? []).map(([agentId, sessionId, at, tokens]) => ({
    agentId, sessionId, at: Date.parse(at), tokens: Number(tokens),
  }));
  return { rows, fleet, attribution };
}

// ── Server aggregates (20261124001200_agent_event_pipeline.sql) ─────────────

type RunStatTuple = [string, string | null, string | null, string | null, string, number, number, number, number, number, number, number, number, number];
type RunFailureTuple = [string, string | null, string | null, string | null, string, string | null, string];
type QuestionStatTuple = [string, string | null, string, number, number, number[] | null, number | null];

/** pm.agent_run_stats's answer, as the read model takes it. */
export function runStatsFromAnswer(answer: { groups?: RunStatTuple[]; failures?: RunFailureTuple[] } | null): RunStats {
  return {
    groups: (answer?.groups ?? []).map(([agentId, projectId, model, provider, dateKey, runs, succeeded, failed, busyMs,
      tokensIn, tokensOut, costUsd, unpricedTokens, runsNoTokens]) => ({
      agentId, projectId, model, provider, dateKey,
      runs: Number(runs), succeeded: Number(succeeded), failed: Number(failed), busyMs: Number(busyMs),
      tokensIn: Number(tokensIn), tokensOut: Number(tokensOut), costUsd: Number(costUsd),
      unpricedTokens: Number(unpricedTokens), runsNoTokens: Number(runsNoTokens),
    })),
    failures: (answer?.failures ?? []).map(([agentId, projectId, model, provider, startedAt, title, status]) => ({
      agentId, projectId, model, provider, startedAt: iso(startedAt), title, status,
    })),
  };
}

/** pm.agent_question_stats's answer, as the read model takes it. */
export function questionStatsFromAnswer(answer: { scope?: string; groups?: QuestionStatTuple[] } | null): QuestionStats {
  return {
    scope: answer?.scope === 'all' ? 'all' : 'projects',
    groups: (answer?.groups ?? []).map(([askedBy, projectId, dateKey, questions, approvals, answerMs, medianAnswerMs]) => ({
      askedBy, projectId, dateKey,
      questions: Number(questions), approvals: Number(approvals),
      answerMs: (answerMs ?? []).map(Number),
      medianAnswerMs: medianAnswerMs === null || medianAnswerMs === undefined ? null : Number(medianAnswerMs),
    })),
  };
}
