import type { AccessContext, PermissionKey } from '@/lib/access-control';
import { apiScopesFor, hasPermission } from '@/lib/access-control';

/**
 * Set up agents with AI: an Owner lets their own AI tool hire and configure
 * agents for one hour, from the first screen of Hire an agent.
 *
 * Two ways in, one set of rules:
 * - a connected AI tool (Connect AI) gets a time-boxed elevation: for an
 *   hour, on the agent setup routes only, its calls carry the Owner's own
 *   API powers; everywhere else it stays a connection (the connect scopes);
 * - without one, a setup key: a key of the Owner's own that lasts an hour,
 *   carries only the setup scopes, and works on the setup routes only.
 *
 * Either way every write runs the same route and server rules as the
 * screens (hireAgent, the scope grants, the key minting rules), every call
 * is still checked against the Owner's live access, and the session ends on
 * its own after an hour or when the Owner ends it. Pure and client-safe.
 */

/** How long a session lasts. */
export const AI_SETUP_MINUTES = 60;

/** A setup key's secret starts with this, so the server knows it on sight and keeps it to the setup routes. */
export const AI_SETUP_KEY_PREFIX = 'pk_setup_';

/** The name a setup key carries in Settings and the audit log. */
export const AI_SETUP_KEY_NAME = 'AI setup key';

export function isAiSetupKey(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(AI_SETUP_KEY_PREFIX);
}

/** The MCP tools a session unlocks (and, for a setup key, the only ones it sees). */
export const AI_SETUP_TOOLS: readonly string[] = [
  'pm_guide',
  'list_agent_templates', 'list_agent_profiles', 'list_projects', 'list_team', 'list_groups',
  'list_agents', 'get_agent_setup', 'get_agent_context',
  'hire_agent', 'create_agent', 'apply_agent_template', 'update_agent',
  'set_agent_projects', 'set_project_agent', 'remove_project_agent',
  'create_api_key', 'list_webhook_endpoints', 'create_webhook_endpoint',
];

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * The v1 routes those tools call: the only routes a session's extra powers
 * reach. A test checks every route of every tool above is here.
 */
export const AI_SETUP_ROUTES: ReadonlyArray<readonly [Method, string]> = [
  ['GET', '/api/v1/agents/me/context'],
  ['GET', '/api/v1/agent-templates'],
  ['GET', '/api/v1/agent-profiles'],
  ['GET', '/api/v1/projects'],
  ['GET', '/api/v1/team-members'],
  ['GET', '/api/v1/groups'],
  ['GET', '/api/v1/agents'],
  ['GET', '/api/v1/agents/{id}/setup'],
  ['GET', '/api/v1/agents/{id}/context'],
  ['POST', '/api/v1/agents/hire'],
  ['POST', '/api/v1/agents'],
  ['POST', '/api/v1/agents/{id}/template'],
  ['PATCH', '/api/v1/agents/{id}'],
  ['PATCH', '/api/v1/agents/{id}/projects'],
  ['PUT', '/api/v1/projects/{id}/agents/{agentId}'],
  ['DELETE', '/api/v1/projects/{id}/agents/{agentId}'],
  ['POST', '/api/v1/api-keys'],
  ['GET', '/api/v1/webhook-endpoints'],
  ['POST', '/api/v1/webhook-endpoints'],
];

const ROUTE_PATTERNS = AI_SETUP_ROUTES.map(([method, path]) => ({
  method,
  path,
  pattern: new RegExp(`^${path.replace(/\{\w+\}/g, '[^/]+')}/?$`),
}));

/** The setup route a request is on, or null. Ids may not be the words other routes use (me, hire). */
export function aiSetupRoute(method: string, pathname: string): string | null {
  const found = ROUTE_PATTERNS.find((route) => route.method === method && route.pattern.test(pathname));
  if (!found) return null;
  // /api/v1/agents/{id} must not stand for /api/v1/agents/me or /hire.
  if (found.path.startsWith('/api/v1/agents/{id}') && /^\/api\/v1\/agents\/(me|hire|import|roles|health|heartbeat|runs)(\/|$)/.test(pathname)) return null;
  return found.path;
}

/**
 * What a setup key carries: the permissions the setup tools need. The
 * powers it hands an agent's key come from the session (the Owner's own,
 * checked again on every call), and only on the setup routes.
 */
export const AI_SETUP_KEY_SCOPES: readonly PermissionKey[] = [
  'team.read',
  'team.manage',
  'project_members.manage',
  'projects.read',
  'api_keys.manage_all',
  'webhooks.manage',
];

/** Who may start a session: whoever may hire an agent (an Owner with team.manage), like the hire flow. */
export function mayStartAiSetup(access: AccessContext | null | undefined): boolean {
  return !!access && access.status === 'active' && access.role === 'owner' && hasPermission(access, 'team.manage', 'api');
}

/** The setup key's scopes for this person: the setup set, as far as they hold it. */
export function aiSetupKeyScopes(access: AccessContext | null | undefined): PermissionKey[] {
  const held = new Set(apiScopesFor(access));
  return AI_SETUP_KEY_SCOPES.filter((scope) => held.has(scope));
}

/** What a session allows, in plain words, for the consent step (exactly what the routes above do). */
export const AI_SETUP_ABILITIES: readonly string[] = [
  'Hire agents and set their names, roles, rules, owners and limits',
  'Add agents to projects, with instructions for each',
  'Make keys for those agents, only with powers you hold yourself',
  'Add webhooks that wake those agents for their own work',
  'Read your projects, team and agent templates to do it',
];

/** What it never does, said once under the list. */
export function aiSetupNever(tool: string): string {
  return `It cannot change people, settings, other keys or other webhooks, and it never does more than you can. Everything it does is in the audit log as made by ${tool}, for you.`;
}

export type AiSetupKind = 'connection' | 'key';

/** One session, as the hire page and Settings > Account show it. Never a secret. */
export interface AiSetupSessionView {
  id: string;
  kind: AiSetupKind;
  /** The tool's name (a connection), or the setup key's name. */
  client_name: string;
  /** The connection it elevates (kind connection). */
  grant_id: string | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
  /** Live: not ended and not expired. */
  active: boolean;
  /** The agents it made, newest first. */
  agents: AiSetupAgentView[];
}

export interface AiSetupAgentView {
  id: string;
  name: string;
  avatar: string | null;
  title: string | null;
  agent_role: string | null;
  status: string;
  created_at: string;
  /** Distinct powers across its live keys. */
  powers: number;
  projects: { id: string; name: string }[];
}

export interface AiSetupView {
  /** The database has AI setup (its migration has run). */
  ready: boolean;
  /** The person may start a session (an Owner). */
  may_start: boolean;
  /** Connect AI is on and the API too, so a connected tool can be used. */
  connect_enabled: boolean;
  /** The person's connected tools that could be elevated. */
  connections: { id: string; client_name: string; redirect_host: string }[];
  /** Live sessions, and ones that ended in the last two hours (so their agents stay listed). */
  sessions: AiSetupSessionView[];
  mcp_url: string;
}

/** Whole minutes left (60 right after it starts), never below 0. */
export function minutesLeft(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 60_000));
}

// ── The prompt ──────────────────────────────────────────────────────────

export interface AiSetupExample {
  id: string;
  label: string;
  request: string;
}

export const AI_SETUP_EXAMPLES: readonly AiSetupExample[] = [
  {
    id: 'company',
    label: 'Company agent',
    request: 'Set up a company agent called Alexa who runs the company, hands work to Jeff, John and Greg, and can act for me. Ask me anything you need first.',
  },
  {
    id: 'inbox-triage',
    label: 'Inbox triage',
    request: 'Set up an inbox triage agent called Iris for our shared inbox. It turns new email into tasks on the right project and asks me when it is not sure.',
  },
  {
    id: 'builder',
    label: 'Builder',
    request: 'Set up a builder agent called Nova for the Website project. It picks up tasks assigned to it and sends finished work to review.',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    request: 'Set up a reviewer agent called Lens who checks finished work on every project and sends it back with notes when it is not ready.',
  },
  {
    id: 'external',
    label: 'External agent',
    request: 'Set up an external agent called Relay that works in our CRM and only asks me questions here. It needs no projects.',
  },
];

/** What every prompt ends with: read the guide first, ask before acting, read it back after. */
export const AI_SETUP_PROMPT_TAIL = [
  'Use the project management tools (the MCP server named pm).',
  'Start with pm_guide: it explains how agent setup works here and lists the agent templates.',
  'Ask me anything you need before you create anything.',
  'Hire each agent with hire_agent, then read each one back to me with get_agent_setup.',
  'If a key is made, show me its secret once and never put it in a task or comment.',
].join(' ');

/** The prompt to copy: the person's request, then the tail. */
export function aiSetupPrompt(request: string): string {
  return `${request.trim()}\n\n${AI_SETUP_PROMPT_TAIL}`;
}
