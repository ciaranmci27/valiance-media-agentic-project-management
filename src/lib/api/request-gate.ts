import type { SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_RATE_PER_MINUTE } from '@/lib/agent-limits';
import { ApiError } from './errors';
import { checkRateLimit } from './rate-limit';
import { currentPausedProjectIds } from './request-context';

/**
 * One database call per API request (pm.api_request_gate): it counts the
 * request against the right limit (the agent's own rate_per_minute across
 * all its keys when set, else DEFAULT_RATE_PER_MINUTE per key, both in the
 * database so every server instance shares them) and, for an agent, says
 * what is paused: the workspace (the kill switch), the agent itself, and the
 * projects it is paused on.
 *
 * While paused, an agent's key still reads, beats, reports telemetry and
 * winds down (finishes a run, releases a claim): PAUSE_EXEMPT. Every other
 * write is refused with 423. People's keys are never paused.
 */

export interface RequestGate {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  limit: number;
  /** The key's member is an agent. */
  agent: boolean;
  workspacePausedAt: string | null;
  agentPausedAt: string | null;
  pausedProjectIds: string[];
}

/** A database before the gate (by code only: any other error fails the request closed). */
const missingGate = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === 'PGRST202' || error.code === '42883');

/** The gate for one request; on a database before it, the per-key limit alone and nothing paused. */
export async function passRequestGate(supabase: SupabaseClient, apiKeyId: string, memberId: string): Promise<RequestGate> {
  const { data, error } = await supabase.rpc('api_request_gate', {
    p_api_key_id: apiKeyId,
    p_member_id: memberId,
    p_default_limit: DEFAULT_RATE_PER_MINUTE,
    p_window_seconds: 60,
  });
  if (error) {
    if (!missingGate(error)) throw error;
    const rate = await checkRateLimit(supabase, apiKeyId);
    return { ...rate, limit: DEFAULT_RATE_PER_MINUTE, agent: false, workspacePausedAt: null, agentPausedAt: null, pausedProjectIds: [] };
  }
  const gate = (data ?? {}) as Record<string, unknown>;
  return {
    allowed: gate.allowed === true,
    remaining: Number(gate.remaining ?? 0),
    resetAt: new Date(String(gate.reset_at)).getTime(),
    limit: Number(gate.limit ?? DEFAULT_RATE_PER_MINUTE),
    agent: gate.agent === true,
    workspacePausedAt: typeof gate.workspace_paused_at === 'string' ? gate.workspace_paused_at : null,
    agentPausedAt: typeof gate.agent_paused_at === 'string' ? gate.agent_paused_at : null,
    pausedProjectIds: Array.isArray(gate.paused_project_ids) ? (gate.paused_project_ids as string[]) : [],
  };
}

/**
 * Writes a paused agent may still make: its heartbeat and health report,
 * telemetry (agent activity, usage, turns), finishing or updating a run it
 * started, and releasing a claim. Starting new work never is.
 */
export function pauseExempt(pathname: string, method: string): boolean {
  if (method === 'POST' && /^\/api\/v1\/agents\/(heartbeat|health)\/?$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/v1\/agent-activities\/?$/.test(pathname)) return true;
  if (method === 'PATCH' && /^\/api\/v1\/agents\/runs\/[^/]+\/?$/.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/v1\/agents\/runs\/[^/]+\/finish\/?$/.test(pathname)) return true;
  if (method === 'DELETE' && /^\/api\/v1\/tasks\/[^/]+\/claim\/?$/.test(pathname)) return true;
  return false;
}

/** 423 for a write from a paused agent (the workspace switch first, then its own pause); null when it may go on. */
export function pausedRefusal(gate: RequestGate, pathname: string, method: string): ApiError | null {
  if (!gate.agent || pauseExempt(pathname, method)) return null;
  if (gate.workspacePausedAt) {
    return new ApiError(423, 'AGENTS_PAUSED', 'Every agent in this workspace is paused. Reads, heartbeats and telemetry still work; nothing else does until an Owner resumes agents.', {
      reason: 'agents_paused',
      paused_at: gate.workspacePausedAt,
      hint: 'Stop starting new work. Keep reporting your heartbeat and usage, and check again later.',
    });
  }
  if (gate.agentPausedAt) {
    return new ApiError(423, 'AGENT_PAUSED', 'This agent is paused. Reads, heartbeats and telemetry still work; nothing else does until a person resumes it.', {
      reason: 'agent_paused',
      paused_at: gate.agentPausedAt,
      hint: 'Stop starting new work. Keep reporting your heartbeat and usage, and check again later.',
    });
  }
  return null;
}

/** 423 project_paused for an agent's write on a project it is paused on. */
export function projectPausedRefusal(gate: Pick<RequestGate, 'agent' | 'pausedProjectIds'>, projectId: string | null | undefined): ApiError | null {
  if (!gate.agent || !projectId || !gate.pausedProjectIds.includes(projectId)) return null;
  return new ApiError(423, 'PROJECT_PAUSED', 'You are paused on this project: do not start or change work here until a person resumes you on it.', {
    reason: 'project_paused',
    project_id: projectId,
    hint: 'Work on your other projects. list_my_assignments shows which ones are paused.',
  });
}

/**
 * For writes whose project is known only inside the handler (a new task, a
 * run on a task or project): throws 423 project_paused when the current
 * request's agent is paused there.
 */
export function assertProjectWritable(projectId: string | null | undefined): void {
  const paused = currentPausedProjectIds();
  const refusal = projectPausedRefusal({ agent: paused.length > 0, pausedProjectIds: paused }, projectId);
  if (refusal) throw refusal;
}
