import type { AgentLimits, AgentUsage } from '@/lib/agent-limits';
import type { AgentRules } from '@/lib/agent-rules';
import type { AgentRunSummary } from '@/lib/agent-runs';

/**
 * The shapes the agent screens read from and send to the session API
 * (/api/workspace/agents, /agent-templates, /projects/{id}/agents, /brief,
 * /projects/setup), as the redesign contract states them, plus the one
 * helper every call goes through. Client-safe.
 *
 * Kept local to the screens until the backend's own exports land
 * (src/lib/project-agents.ts, src/lib/project-brief.ts); then these types
 * become re-exports of those.
 */

// ── Templates and their settings ────────────────────────────────────────

export type {
  SettingsField, SettingsFieldType, SettingsOption, SettingsValue, SettingsValues, AgentOwner, ProjectAgentAssignment,
} from '@/lib/project-agents';
export type { BriefEntry, BriefSection, BriefGoal, ProjectBrief } from '@/lib/project-brief';
export { BRIEF_SECTIONS } from '@/lib/project-brief';
export type { ConnectInfo } from '@/lib/agent-connect';
import type { AgentOwner, ProjectAgentAssignment, SettingsField, SettingsValues } from '@/lib/project-agents';
import type { BriefEntry, BriefGoal } from '@/lib/project-brief';
import type { ConnectInfo } from '@/lib/agent-connect';

export interface AgentTemplateView {
  key: string;
  label: string;
  description: string;
  rules: Partial<Pick<AgentRules, 'agent_self_assign' | 'agent_close_policy' | 'agent_create_policy'>>;
  scopes: string[];
  context?: string;
  webhook_events?: string[];
  settings?: SettingsField[];
  module?: string;
  /** The role label an agent from this template starts with ("builder"). */
  role?: string | null;
  /** The limits an agent hired from it starts with; null for none. */
  limits?: Partial<AgentLimits> | null;
}

// ── Agents ──────────────────────────────────────────────────────────────

/** One agent in a list read: what the roster needs beyond the team row. */
export interface AgentListItem {
  id: string;
  name: string;
  title: string | null;
  avatar_url: string | null;
  status: 'active' | 'suspended';
  agent_role: string | null;
  template_key: string | null;
  owners: AgentOwner[];
  /** Groups that own it beside its people (any member manages it). */
  owner_groups?: { id: string; name: string }[];
  /** Projects it is set up on (assignment project ids), up to 50. */
  project_ids?: string[];
  /** Projects it can open (project access), up to 50 the viewer reaches; how it actually works. */
  access_project_ids?: string[];
  /** Every project it can open that the viewer reaches. */
  access_total?: number;
  /** Its assignments (project_agents): how many projects it is set up on. */
  assignments?: { active: number; total: number };
}

export interface AgentKeyView {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at?: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  /** When it stops working (an agent key lifetime, or a rotation's overlap); null: until revoked. */
  expires_at?: string | null;
  /** When it was switched off; it no longer works. */
  disabled_at?: string | null;
}

export interface AgentDetail {
  agent: {
    id: string;
    name: string;
    title: string | null;
    description: string | null;
    avatar_url: string | null;
    status: 'active' | 'suspended';
    agent_role: string | null;
    /** When it was paused (reads, heartbeats and telemetry only); null while it works. */
    paused_at?: string | null;
    /** A personal agent's person (team_members.delegate_of); null for a shared agent. */
    delegate_of?: string | null;
  };
  /** A personal agent's person, and when they paused it on My Assistant; null for a shared agent. */
  person?: { id: string; name: string; status: 'active' | 'suspended'; paused_at: string | null } | null;
  /** The scopes a new key for it may carry (what it holds); sent with its keys. */
  key_scopes_available?: string[];
  rules: AgentRules & { agent_escalate_to_group?: string | null };
  /** Its limits (null: none set); absent or null usage on a database before limits. */
  limits?: AgentLimits | null;
  usage?: AgentUsage | null;
  health: unknown;
  current_run: AgentRunSummary | null;
  projects: ProjectAgentAssignment[];
  /** Every assignment the viewer reaches; projects holds the first 100. */
  projects_total?: number;
  /** Projects it has access to (project members) that the viewer reaches; how it actually works on them. */
  project_access?: { projects: { id: string; name: string; status: string }[]; hidden_count: number; total?: number };
  /** Only for who may manage every key; never a secret. */
  keys?: AgentKeyView[];
  webhooks?: unknown[];
  template_key: string | null;
  owners: AgentOwner[];
  /** Groups that own it beside its people (any member manages it). */
  owner_groups?: { id: string; name: string }[];
  /** Whether the viewer may edit this agent (an owner of it, or team.manage). */
  can_manage?: boolean;
  /** Whether the viewer is one of its owners, in person or through a group: opens its profile without agents.manage. */
  is_owner?: boolean;
  omitted: string[];
}

export interface NewKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** Shown once, never stored on the screen past the step that shows it. */
  secret: string;
  /** When the workspace's agent key lifetime ends it (a hire's key carries it); null or absent: until revoked. */
  expires_at?: string | null;
}

export interface HireRequest {
  name: string;
  title?: string;
  description?: string;
  avatar_url?: string;
  agent_role?: string;
  owner_ids?: string[];
  owner_group_ids?: string[];
  template_key?: string;
  project_ids?: string[];
  project_settings?: Record<string, { settings?: SettingsValues; instructions?: string }>;
  create_key?: boolean;
  key_name?: string;
  scopes?: string[];
  rules?: Partial<AgentRules> & { agent_escalate_to_group?: string | null };
}

export interface HireResponse {
  agent: { id: string; name: string };
  assignments: ProjectAgentAssignment[];
  key?: NewKey;
  connect: ConnectInfo;
}

// ── Project setup ───────────────────────────────────────────────────────

export interface ProjectSetupRequest {
  project: Record<string, unknown>;
  brief?: { section: string; content: string; pinned?: boolean }[];
  goals?: { title: string; description?: string; target_date?: string | null }[];
  agents?: { agent_id: string; template_key?: string | null; settings?: SettingsValues; instructions?: string }[];
  members?: string[];
}

export interface ProjectSetupResponse {
  project: { id: string; name: string };
  assignments: ProjectAgentAssignment[];
  brief: BriefEntry[];
  goals: BriefGoal[];
}

// ── Calls ───────────────────────────────────────────────────────────────

export class WorkspaceApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
    super(message);
  }
}

/**
 * One session API call. Reads the app's envelope ({ success, data } or
 * { data }) or a bare body, and turns an error body into a WorkspaceApiError
 * with the server's own message, so a screen can show it as is.
 */
export async function workspaceApi<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    cache: 'no-store',
    ...(init.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) } : {}),
  });
  const body = await response.json().catch(() => null) as
    | { success?: boolean; data?: unknown; error?: string | { code?: string; message?: string; details?: unknown } }
    | null;
  if (!response.ok || body?.success === false) {
    const error = body?.error;
    const message = typeof error === 'string' ? error : error?.message || `Request failed (${response.status})`;
    throw new WorkspaceApiError(message, response.status, typeof error === 'object' ? error?.code : undefined, typeof error === 'object' ? error?.details : undefined);
  }
  return (body && 'data' in body && body.data !== undefined ? body.data : body) as T;
}

/**
 * The key a key-making call answers: POST /agents/{id}/keys answers
 * { key: {...} } inside its data, and a hire carries the key bare. Either
 * way this returns the key, and refuses one with no secret, so a screen
 * never shows an empty box for a key that was made.
 */
export function newKeyFrom(body: unknown): NewKey {
  const candidate = (body && typeof body === 'object' && 'key' in body ? (body as { key: unknown }).key : body) as Partial<NewKey> | null;
  if (!candidate || typeof candidate.secret !== 'string' || !candidate.secret) {
    throw new WorkspaceApiError('The key was made but its secret did not arrive. Revoke it and make another.', 500);
  }
  return candidate as NewKey;
}

/** A field-level map from a 400's details, when the server names fields ({ fields: { key: message } } or [{ path, message }]). */
export function fieldErrorsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof WorkspaceApiError) || !error.details) return {};
  const details = error.details as { fields?: Record<string, string> } | { path?: (string | number)[]; message?: string }[];
  if (Array.isArray(details)) {
    return Object.fromEntries(details.filter((d) => d.path?.length).map((d) => [String(d.path![d.path!.length - 1]), d.message ?? 'Invalid']));
  }
  return details.fields ?? {};
}
