import { agentLimitsRow, loadLimitState, setAgentLimits } from './agent-limits';
import { insertAuditRows } from './audit';
import { currentAuditVia } from './request-context';
import type { SupabaseClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { API_ENDPOINT_PERMISSION_SET, apiScopesFor, type AccessContext, type PermissionKey } from '@/lib/access-control';
import { agentRulesOf, type AgentRules } from '@/lib/agent-rules';
import { buildConnectInfo, type ConnectInfo } from '@/lib/agent-connect';
import type { AgentOwner, ProjectAgentAssignment } from '@/lib/project-agents';
import { rulesColumnsFrom, type AgentKeyInput, type HireAgent, type PatchAgent } from '@/lib/schemas/agent-workspaces';
import type { AgentRunSummary } from '@/lib/agent-runs';
import { accessAllows, accessAllowsProject, resolveMemberAccess } from './access';
import {
  addOwners,
  agentsOwnedBy,
  callerChannel,
  callerHolds,
  canManageAgent,
  checkOwnerIds,
  isAgentOwner,
  ownersOf,
  ownerGroupsOf,
  addOwnerGroups,
  checkOwnerGroupIds,
  setOwnerGroups,
  requireManageAgent,
  setOwners,
  type AgentCaller,
} from './agent-owners';
import { agentRulesColumns } from './agent-rules';
import { presentStoredRuns } from './agent-runs';
import { checkKeyGrant, createAgentMember, grantableScopes, insertApiKey, memberApiKeys, type Granter } from './agent-setup';
import { AGENT_HIRE_ENDPOINT, appliedTemplateKey, appliedTemplateKeys, recordTemplateKey } from './agent-context';
import { agentTemplateRegistry, assertKnownAgentProfile } from './agent-registries';
import { addAgentScopeGrants, agentScopesBeyondRole, assertMayGiveAgentScopes, removeAgentScopeGrants } from './agent-scope-grants';
import { revokeKeyTree } from './key-revoke';
import { listWebhookEndpoints, type PublicWebhookEndpoint } from './webhook-endpoints';
import {
  canGrantProjectAccess,
  ensureProjectAccess,
  projectAccessNeeded,
  listAgentAssignments,
  migrationPending,
  newAssignmentRow,
  presentAssignments,
  PROJECT_AGENT_COLUMNS,
  requireTemplate,
} from './project-agents';
import { requireAgentsEnabled } from './agents';
import { readAll } from './read-all';
import { ApiError, forbidden, notFound } from './errors';

/**
 * The agents as people manage them: the list, one agent's profile, edits,
 * keys, and hiring an agent in one call. The session routes
 * (/api/workspace/agents) and the v1 API share these, so both apply the same
 * rules: the setup API's (agent-setup.ts) for anything that grants, and
 * canManageAgent (agent-owners.ts) for edits.
 *
 * Hiring (Owner only) makes the agent with no sign-in, applies its
 * template's role, profile and rules, makes the hirer (and anyone named) its
 * owners, gives it access to its projects and assigns it there with settings
 * checked against the template, can make a key (its secret in that answer
 * only), and answers how its host connects. Everything is checked before the
 * first write; a failure after one undoes what the call made (the key
 * revoked, assignments, owners and project access it added removed, the
 * agent suspended) and answers what stays, as an agent import does.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- rows are read field by field
type Row = Record<string, any>;

/** A signed-in member as a caller of these functions, and as the setup API's granter. */
export function sessionCaller(memberId: string, access: AccessContext): { caller: AgentCaller; granter: Granter } {
  return {
    caller: { memberId, access, scopes: null },
    // From the screens, a key may carry what the signed-in member holds on the api channel, as in Settings.
    granter: { memberId, access, scopes: apiScopesFor(access) },
  };
}

const MEMBER_LIST_COLUMNS = 'id, name, avatar, title, description, agent_role, agent_profile, status, created_at';

const missingSchema = (error: { code?: string; message?: string } | null) =>
  !!error && (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code ?? '') || /agent_role|description|project_agent_counts|schema cache/.test(error.message ?? ''));

// ── The list ────────────────────────────────────────────────────────────

export interface AgentFilters {
  role?: string | null;
  /** 'me' or a member id: agents that member owns. */
  owner?: string | null;
  template?: string | null;
  project?: string | null;
  status?: string | null;
  search?: string | null;
  /**
   * People's personal agents: left out by default (they have their own list,
   * /assistants), included, or only them.
   */
  personal?: 'exclude' | 'include' | 'only' | null;
  offset: number;
  limit: number;
}

export function agentFiltersFrom(searchParams: URLSearchParams): Omit<AgentFilters, 'offset' | 'limit'> {
  const status = searchParams.get('status');
  if (status && !['active', 'suspended'].includes(status)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'status is active or suspended', { reason: 'invalid_filter' });
  }
  const personal = searchParams.get('personal');
  if (personal && !['exclude', 'include', 'only'].includes(personal)) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'personal is exclude, include or only', { reason: 'invalid_filter' });
  }
  return {
    personal: personal as AgentFilters['personal'],
    role: searchParams.get('role'),
    owner: searchParams.get('owner'),
    template: searchParams.get('template'),
    project: searchParams.get('project') ?? searchParams.get('project_id'),
    status,
    search: searchParams.get('search'),
  };
}

export interface AgentListItem {
  id: string;
  name: string;
  title: string | null;
  description: string | null;
  avatar_url: string | null;
  status: 'active' | 'suspended';
  agent_role: string | null;
  agent_profile: string;
  template_key: string | null;
  owners: AgentOwner[];
  /** Groups that own it beside its people (any member manages it). */
  owner_groups: { id: string; name: string }[];
  /** Up to 50 of the projects it is assigned to (pm.project_agents), that the viewer reaches. */
  project_ids: string[];
  /** Up to 50 of the live projects it is a member of (pm.project_members, its project access), that the viewer reaches. */
  access_project_ids: string[];
  /** Every live project it is a member of, those the viewer cannot reach counted too. */
  access_total: number;
  assignments: { active: number; total: number };
  health: Row | null;
  current_run: AgentRunSummary | null;
  created_at: string;
}

/** Ids listed per agent in a list read; the rest are counted. */
export const AGENT_LIST_PROJECT_IDS = 50;

interface MemberProject { id: string; name: string; status: string }

/**
 * The live projects each agent is a member of (its project access), in one
 * read for many agents: the ones the viewer reaches, and the total with the
 * rest counted, never named. The list and an agent's profile both read it.
 */
export async function memberProjectAccess(service: SupabaseClient, viewer: AgentCaller, agentIds: string[]): Promise<Map<string, { visible: MemberProject[]; total: number }>> {
  const out = new Map<string, { visible: MemberProject[]; total: number }>();
  for (const id of agentIds) out.set(id, { visible: [], total: 0 });
  if (agentIds.length === 0) return out;
  // Paged: 200 agents on a few projects each pass the 1000 rows one response holds.
  const rows = await readAll<unknown>((from, to) => service
    .from('project_members')
    .select('member_id, project_id, project:projects!inner(id, name, status)')
    .in('member_id', agentIds)
    .is('project.deleted_at', null)
    .order('member_id')
    .order('project_id')
    .range(from, to));
  const channel = callerChannel(viewer);
  for (const row of rows as { member_id: string; project: MemberProject | MemberProject[] }[]) {
    const project = Array.isArray(row.project) ? row.project[0] : row.project;
    const entry = out.get(row.member_id);
    if (!project || !entry) continue;
    entry.total += 1;
    if (accessAllowsProject(viewer.access, project.id, channel)) entry.visible.push({ id: project.id, name: project.name, status: project.status });
  }
  for (const entry of out.values()) entry.visible.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_MATCH = ['00000000-0000-0000-0000-000000000000'];

/**
 * Agents by name, paged, each with its owners, template, live health,
 * current run and assignment counts. A fixed number of reads per page,
 * however many agents: the filters narrow by id first, then one read each
 * for health, running runs, owners, counts and templates.
 */
export async function listAgents(service: SupabaseClient, viewer: AgentCaller, filters: AgentFilters): Promise<{ rows: AgentListItem[]; total: number }> {
  requireAgentsEnabled(viewer.access);
  const scope: { ids: string[] | null } = { ids: null };
  const narrow = (next: string[]) => { scope.ids = scope.ids === null ? next : scope.ids.filter((id) => next.includes(id)); };
  if (filters.owner) {
    const owner = filters.owner === 'me' ? viewer.memberId : filters.owner;
    if (!UUID.test(owner)) throw new ApiError(422, 'VALIDATION_ERROR', 'owner is me or a team member id', { reason: 'invalid_filter' });
    narrow(await agentsOwnedBy(service, owner));
  }
  if (filters.project || filters.template) {
    const rows = await readAll<{ agent_id: string }>((from, to) => {
      let query = service.from('project_agents').select('agent_id, id');
      if (filters.project) query = query.eq('project_id', filters.project);
      if (filters.template) query = query.eq('template_key', filters.template);
      return query.order('id').range(from, to);
    }).catch((error) => { throw missingSchema(error) ? migrationPending() : error; });
    narrow([...new Set(rows.map((row) => row.agent_id))]);
  }

  const personal = filters.personal ?? 'exclude';
  const page = (byPersonal: boolean) => {
    let query = service.from('team_members').select(MEMBER_LIST_COLUMNS, { count: 'exact' }).eq('role', 'agent');
    if (scope.ids !== null) query = query.in('id', scope.ids.length ? scope.ids : NO_MATCH);
    if (filters.role) query = query.eq('agent_role', filters.role);
    if (filters.status) query = query.eq('status', filters.status);
    if (filters.search) {
      const term = filters.search.replace(/[,().%*\\]/g, '').trim();
      if (term) query = query.ilike('name', `%${term}%`);
    }
    if (byPersonal && personal === 'exclude') query = query.is('delegate_of', null);
    if (byPersonal && personal === 'only') query = query.not('delegate_of', 'is', null);
    return query.order('name').range(filters.offset, filters.offset + filters.limit - 1);
  };
  let { data, error, count } = await page(personal !== 'include');
  // Before 20261124001300 there are no personal agents: every agent is shared.
  if (error && personal !== 'include' && /delegate_of/.test(error.message ?? '')) {
    if (personal === 'only') return { rows: [], total: 0 };
    ({ data, error, count } = await page(false));
  }
  if (missingSchema(error)) throw migrationPending();
  if (error) throw error;
  const members = (data ?? []) as unknown as Row[];
  const pageIds = members.map((member) => member.id as string);
  if (pageIds.length === 0) return { rows: [], total: count ?? 0 };

  const [health, runs, owners, counts, templates, access, ownerGroups] = await Promise.all([
    service.from('agent_health').select('*').in('member_id', pageIds)
      .then(({ data: rows }) => new Map(((rows ?? []) as Row[]).map((row) => [row.member_id as string, row]))),
    service.from('agent_runs').select('*').in('agent_id', pageIds).eq('status', 'running').order('started_at', { ascending: false }).limit(pageIds.length * 3)
      .then(async ({ data: rows, error: runsError }) => {
        if (runsError) return new Map<string, AgentRunSummary>();
        const newest = new Map<string, Row>();
        for (const row of (rows ?? []) as Row[]) if (!newest.has(row.agent_id)) newest.set(row.agent_id, row);
        const presented = await presentStoredRuns(service, [...newest.values()]);
        return new Map(presented.filter((run) => run.status === 'running').map((run) => [run.agent_id, run]));
      }),
    ownersOf(service, pageIds),
    service.from('project_agent_counts').select('agent_id, active, total, project_ids').in('agent_id', pageIds)
      .then(({ data: rows }) => new Map(((rows ?? []) as Row[]).map((row) => [row.agent_id as string, row]))),
    appliedTemplateKeys(service, pageIds),
    memberProjectAccess(service, viewer, pageIds),
    ownerGroupsOf(service, pageIds),
  ]);

  const reachAll = accessAllows(viewer.access, 'projects.read_all', viewer.scopes === null ? 'app' : 'api');
  const reach = new Set(viewer.access.project_ids);
  return {
    rows: members.map((member): AgentListItem => {
      const counted = counts.get(member.id);
      return {
        id: member.id,
        name: member.name,
        title: member.title ?? null,
        description: member.description ?? null,
        avatar_url: member.avatar || null,
        status: member.status,
        agent_role: member.agent_role ?? null,
        agent_profile: member.agent_profile ?? 'generic',
        template_key: templates.get(member.id) ?? null,
        owners: owners.get(member.id) ?? [],
        owner_groups: ownerGroups.get(member.id) ?? [],
        project_ids: ((counted?.project_ids ?? []) as string[]).filter((id) => reachAll || reach.has(id)),
        access_project_ids: (access.get(member.id)?.visible ?? []).slice(0, AGENT_LIST_PROJECT_IDS).map((project) => project.id),
        access_total: access.get(member.id)?.total ?? 0,
        assignments: { active: counted?.active ?? 0, total: counted?.total ?? 0 },
        health: health.get(member.id) ?? null,
        current_run: runs.get(member.id) ?? null,
        created_at: member.created_at,
      };
    }),
    total: count ?? members.length,
  };
}

/** The role labels in use, by how many agents carry each, most first. */
export async function agentRoles(service: SupabaseClient): Promise<{ roles: string[]; counts: Record<string, number> }> {
  let rows: { agent_role: string }[];
  try {
    rows = await readAll<{ agent_role: string }>((from, to) => service.from('team_members').select('id, agent_role').eq('role', 'agent')
      .not('agent_role', 'is', null).order('id').range(from, to));
  } catch (error) {
    if (missingSchema(error as { code?: string; message?: string })) return { roles: [], counts: {} };
    throw error;
  }
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.agent_role] = (counts[row.agent_role] ?? 0) + 1;
  const roles = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
  return { roles, counts };
}

// ── One agent ───────────────────────────────────────────────────────────

async function loadAgentRow(service: SupabaseClient, agentId: string): Promise<Row> {
  const { data, error } = await service.from('team_members').select('*').eq('id', agentId).maybeSingle();
  if (error) throw error;
  if (!data) throw notFound('Agent');
  const row = data as Row;
  if (row.role !== 'agent') throw new ApiError(422, 'VALIDATION_ERROR', `${row.name} is not an agent`, { reason: 'agents_only' });
  return row;
}

function agentView(row: Row) {
  return {
    id: row.id as string,
    name: row.name as string,
    title: (row.title as string | null) ?? null,
    description: (row.description as string | null) ?? null,
    avatar_url: (row.avatar as string) || null,
    status: row.status as 'active' | 'suspended',
    agent_role: (row.agent_role as string | null) ?? null,
    agent_profile: (row.agent_profile as string) ?? 'generic',
    created_at: row.created_at as string,
    /** When it was paused (reads, heartbeats and telemetry only); null while it works. */
    paused_at: (row.agent_paused_at as string | null | undefined) ?? null,
  };
}

export const AGENT_DETAIL_ASSIGNMENTS = 100;

/** An agent's rules as the screens read them, with its escalation group when it has one. */
function rulesWithGroup(row: Row): AgentRules & { agent_escalate_to_group: string | null } {
  return {
    ...agentRulesOf(row as Partial<Record<keyof AgentRules, unknown>>),
    agent_escalate_to_group: typeof row.agent_escalate_to_group === 'string' ? row.agent_escalate_to_group : null,
  };
}

/**
 * One agent as the viewer may see it: who it is, its rules, live health and
 * current run, its assignments on projects the viewer reaches, its owners,
 * its keys (never a secret; with api_keys.manage_all) and webhooks (with
 * webhooks.manage), whether the viewer may manage it and whether they own it
 * (is_owner, in person or through a group). Parts left out are
 * named in omitted.
 */
export async function agentDetail(service: SupabaseClient, viewer: AgentCaller, agentId: string) {
  requireAgentsEnabled(viewer.access);
  const row = await loadAgentRow(service, agentId);
  const canKeys = callerHolds(viewer, 'api_keys.manage_all');
  const canHooks = callerHolds(viewer, 'webhooks.manage');
  const omitted: string[] = [];
  if (!canKeys) omitted.push('keys');
  if (!canHooks) omitted.push('webhooks');
  // A personal agent works for one person (team_members.delegate_of): its keys are theirs to make, its escalation theirs.
  const delegateId = typeof row.delegate_of === 'string' ? row.delegate_of : null;
  const [health, run, assignments, owners, keys, webhooks, templateKey, access, canManage, ownerGroups, limitState, isOwner, person, heldScopes] = await Promise.all([
    service.from('agent_health').select('*').eq('member_id', agentId).maybeSingle().then(({ data }) => (data as Row | null) ?? null),
    service.from('agent_runs').select('*').eq('agent_id', agentId).eq('status', 'running').order('started_at', { ascending: false }).limit(1)
      .then(async ({ data, error }) => {
        if (error || !data?.length) return null;
        const [summary] = await presentStoredRuns(service, data as Row[]);
        return summary?.status === 'running' ? summary : null;
      }),
    listAgentAssignments(service, viewer, agentId, { offset: 0, limit: AGENT_DETAIL_ASSIGNMENTS }).catch((error) => {
      if (error instanceof ApiError && error.statusCode === 503) return { rows: [] as ProjectAgentAssignment[], total: 0, hidden_count: 0 };
      throw error;
    }),
    ownersOf(service, [agentId]).then((map) => map.get(agentId) ?? []),
    canKeys ? memberApiKeys(service, agentId) : Promise.resolve(null),
    canHooks ? listWebhookEndpoints(service, { memberId: agentId }) : Promise.resolve(null),
    appliedTemplateKey(service, agentId),
    memberProjectAccess(service, viewer, [agentId]).then((map) => map.get(agentId) ?? { visible: [], total: 0 }),
    canManageAgent(service, viewer, agentId),
    ownerGroupsOf(service, [agentId]).then((map) => map.get(agentId) ?? []),
    loadLimitState(service, agentId, true),
    // One of its owners, in person or through a group: who may open its profile without agents.manage.
    isAgentOwner(service, agentId, viewer.memberId),
    delegateId
      ? service.from('team_members').select('id, name, status').eq('id', delegateId).maybeSingle().then(({ data }) => (data as Row | null) ?? null)
      : Promise.resolve(null),
    // What a key for it may carry (checkKeyGrant's rule), for whoever makes its keys.
    canKeys && !delegateId
      ? resolveMemberAccess(service, agentId).then((agentAccess) => (agentAccess ? apiScopesFor(agentAccess) as string[] : []))
      : Promise.resolve(null),
  ]);
  return {
    agent: { ...agentView(row), delegate_of: delegateId },
    // A personal agent's person, and whether they paused it on My Assistant.
    person: delegateId
      ? {
        id: delegateId,
        name: (person?.name as string | undefined) ?? '',
        status: person?.status === 'suspended' ? 'suspended' as const : 'active' as const,
        paused_at: (row.delegate_paused_at as string | null | undefined) ?? null,
      }
      : null,
    rules: rulesWithGroup(row),
    // Its limits (null: none) and what counts against them now; both null on a database before them.
    limits: limitState?.limits ?? null,
    usage: limitState?.usage ?? null,
    health,
    current_run: run,
    projects: assignments.rows,
    projects_total: assignments.total,
    projects_hidden: assignments.hidden_count,
    // Its project access (pm.project_members), by the list's rule: what the viewer reaches, the rest counted.
    project_access: { projects: access.visible, hidden_count: access.total - access.visible.length, total: access.total },
    owners,
    owner_groups: ownerGroups,
    keys: keys
      ? keys.map((key) => ({
        id: key.id, name: key.name, prefix: key.key_prefix, scopes: key.scopes ?? [], permissions: key.permissions,
        created_at: key.created_at, last_used_at: key.last_used_at ?? null, revoked_at: key.revoked_at ?? null,
        // An ended key (past its expiry, or switched off) is listed but no longer works.
        expires_at: key.expires_at ?? null, disabled_at: key.disabled_at ?? null,
      }))
      : undefined,
    // The scopes a new key for it may carry (what it holds on the api channel); with its keys only.
    key_scopes_available: heldScopes ?? undefined,
    webhooks: (webhooks as PublicWebhookEndpoint[] | null) ?? undefined,
    template_key: templateKey,
    can_manage: canManage,
    is_owner: isOwner,
    omitted,
  };
}

/**
 * Changes an agent: name, title, description, avatar, role label and rules
 * for whoever may manage it; owners for a workspace Owner or one of its
 * owners. Answers the agent as agentView reads it, its rules and owners.
 */
export async function patchAgent(service: SupabaseClient, caller: AgentCaller, agentId: string, body: PatchAgent) {
  requireAgentsEnabled(caller.access);
  const before = await loadAgentRow(service, agentId);
  const touchesProfile = ['name', 'title', 'description', 'avatar_url', 'agent_role', 'rules', 'paused'].some((field) => (body as Row)[field] !== undefined);
  if (touchesProfile) await requireManageAgent(service, caller, agentId);
  // Limits spend money and set how hard it may run: a workspace Owner's to set.
  if (body.limits !== undefined && caller.access.role !== 'owner') {
    throw forbidden("Only a workspace Owner sets an agent's limits", { reason: 'owner_only' });
  }
  const rules = await agentRulesColumns(service, { id: agentId, role: 'agent' }, rulesColumnsFrom(body.rules));
  const changes: Row = {
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.title !== undefined ? { title: body.title || null } : {}),
    ...(body.description !== undefined ? { description: body.description || null } : {}),
    ...(body.avatar_url !== undefined ? { avatar: body.avatar_url ?? '' } : {}),
    ...(body.agent_role !== undefined ? { agent_role: body.agent_role || null } : {}),
    ...rules,
    // Pausing again keeps when and by whom it was first paused.
    ...(body.paused === true && !before.agent_paused_at ? { agent_paused_at: new Date().toISOString(), agent_paused_by: caller.memberId } : {}),
    ...(body.paused === false && before.agent_paused_at ? { agent_paused_at: null, agent_paused_by: null } : {}),
  };
  // Owners are checked (and refused) before anything changes.
  let owners: { added: string[]; removed: string[] } | null = null;
  if (body.owner_ids !== undefined) owners = await setOwners(service, caller, agentId, body.owner_ids);
  let ownerGroupChanges: { added: string[]; removed: string[] } | null = null;
  if (body.owner_group_ids !== undefined) ownerGroupChanges = await setOwnerGroups(service, caller, agentId, body.owner_group_ids);
  let row = before;
  if (Object.keys(changes).length) {
    const { data, error } = await service.from('team_members').update(changes).eq('id', agentId).select().single();
    if (error) throw error;
    row = data as Row;
  }
  const limitsBefore = body.limits !== undefined ? await agentLimitsRow(service, agentId) : undefined;
  const limits = body.limits !== undefined ? await setAgentLimits(service, agentId, body.limits, caller.memberId) : undefined;
  return {
    before: { ...agentView(before), rules: rulesWithGroup(before), ...(limitsBefore !== undefined ? { limits: limitsBefore } : {}) },
    agent: agentView(row),
    rules: rulesWithGroup(row),
    ...(limits !== undefined ? { limits } : {}),
    owners: (await ownersOf(service, [agentId])).get(agentId) ?? [],
    owners_changed: owners,
    owner_groups: (await ownerGroupsOf(service, [agentId])).get(agentId) ?? [],
    ...(ownerGroupChanges ? { owner_groups_changed: ownerGroupChanges } : {}),
  };
}

// ── Keys ────────────────────────────────────────────────────────────────

export interface NewAgentKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  permissions: string;
  secret: string;
}

/**
 * Makes a key for an agent from the screens: the setup API's rules exactly
 * (checkKeyGrant: an Owner's for an agent, api_keys.manage_all, every scope
 * held by the agent and by the signed-in member). Its secret is in this
 * answer only. An owner of the agent who is not an Owner cannot.
 *
 * A scope its role lacks is given to this one agent first, as at hire
 * (agent-scope-grants.ts: an Owner only, never a never-for-agents scope),
 * and taken back if the key is then refused. A personal agent is never
 * given anything here: its person makes its keys.
 */
export async function mintAgentKey(service: SupabaseClient, caller: AgentCaller, granter: Granter, agentId: string, input: AgentKeyInput): Promise<NewAgentKey & { scopes_given: string[] }> {
  requireAgentsEnabled(caller.access);
  if (!callerHolds(caller, 'api_keys.manage_all')) {
    throw forbidden('Making a key needs api_keys.manage_all', { reason: 'missing_key_scope', needs: 'api_keys.manage_all' });
  }
  const row = await loadAgentRow(service, agentId);
  const scopes = [...new Set(input.scopes)];
  let beyondRole: string[] = [];
  if (!row.delegate_of && row.status === 'active') {
    // What a key can never grant is refused before anything is given.
    const unknown = scopes.filter((scope) => !API_ENDPOINT_PERMISSION_SET.has(scope as PermissionKey));
    if (unknown.length) throw new ApiError(422, 'VALIDATION_ERROR', `Not API scopes: ${unknown.join(', ')}`, { reason: 'unknown_scope' });
    const grantable = grantableScopes(granter);
    const beyondCaller = scopes.filter((scope) => !grantable.has(scope));
    if (beyondCaller.length) {
      throw forbidden(`A key can only carry scopes you hold yourself: ${beyondCaller.join(', ')}`, { reason: 'scope_escalation', beyond_caller: beyondCaller });
    }
    beyondRole = await agentScopesBeyondRole(service, granter, agentId, scopes);
    assertMayGiveAgentScopes(caller.access, beyondRole);
  }
  const given = await addAgentScopeGrants(service, agentId, beyondRole, caller.memberId);
  try {
    const granted = await checkKeyGrant(service, granter, { memberId: agentId, scopes });
    const made = await insertApiKey(service, {
      name: input.name ?? `${row.name} key`,
      memberId: agentId,
      createdBy: caller.memberId,
      createdByKeyId: null,
      scopes: granted.scopes,
      permissions: input.read_only ? 'read_only' : 'scoped',
    });
    return {
      id: made.key.id, name: made.key.name, prefix: made.key.key_prefix, scopes: made.key.scopes ?? [], permissions: made.key.permissions, secret: made.secret,
      // Powers this key gave the agent beyond its role (now its own, as a per-member allow).
      scopes_given: beyondRole,
    };
  } catch (failure) {
    await removeAgentScopeGrants(service, agentId, given).catch((error) => console.error('[agents] key scope grants not undone', error));
    throw failure;
  }
}

/**
 * Revokes one of an agent's keys and every key it made: an Owner or a holder
 * of api_keys.manage_all, as revoking any key someone else holds.
 */
export async function revokeAgentKey(service: SupabaseClient, caller: AgentCaller, agentId: string, keyId: string): Promise<string[]> {
  requireAgentsEnabled(caller.access);
  if (caller.access.role !== 'owner' && !callerHolds(caller, 'api_keys.manage_all')) {
    throw forbidden('Revoking an agent\'s key needs an Owner or api_keys.manage_all', { reason: 'missing_key_scope', needs: 'api_keys.manage_all' });
  }
  const { data, error } = await service.from('api_keys').select('id, team_member_id').eq('id', keyId).maybeSingle();
  if (error) throw error;
  if (!data || (data as Row).team_member_id !== agentId) throw notFound('API key');
  return revokeKeyTree(service, keyId, {
    memberId: caller.memberId,
    apiKeyId: null,
    endpoint: `/api/workspace/agents/${agentId}/keys/${keyId}/revoke`,
    via: 'app',
  });
}

// ── Hiring ──────────────────────────────────────────────────────────────

/** An address only this agent uses, made up when the hire names none: it never signs in. */
export function agentEmailFor(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'agent';
  return `${slug}-${randomBytes(4).toString('hex')}@agents.invalid`;
}

export interface HireResult {
  agent: ReturnType<typeof agentView> & { owners: AgentOwner[]; owner_groups: { id: string; name: string }[] };
  rules: AgentRules & { agent_escalate_to_group: string | null };
  template_key: string | null;
  assignments: ProjectAgentAssignment[];
  access_added: string[];
  /** Scopes the agent role lacks that this hire gave the agent (per-member allows on the API channel). */
  scopes_beyond_role: string[];
  key?: NewAgentKey;
  connect: ConnectInfo;
}

/**
 * Hires an agent in one call (POST /api/workspace/agents). Owner only, with
 * the AI agents module on. Every part is checked before the first write; a
 * failure after it undoes what this call made (undoHire).
 */
export async function hireAgent(
  service: SupabaseClient, caller: AgentCaller, granter: Granter, input: HireAgent, appUrl: string,
  /** Over the API (POST /api/v1/agents/hire): the calling key, so the audit row names it and the door it came through. */
  options: { apiKeyId?: string | null } = {},
): Promise<HireResult> {
  const apiKeyId = options.apiKeyId ?? null;
  const via = apiKeyId ? currentAuditVia() : 'app';
  requireAgentsEnabled(caller.access);
  if (caller.access.role !== 'owner') {
    throw forbidden('Only an Owner hires an agent', { reason: 'owner_only' });
  }

  // 1. Check everything first.
  const templates = await agentTemplateRegistry(service);
  const template = input.template_key ? requireTemplate(caller, input.template_key, templates) : null;
  await assertKnownAgentProfile(service, input.agent_profile ?? template?.profile);
  const projectIds = [...new Set(input.project_ids ?? [])];
  // Hiring is an Owner's, so this holds; kept so the rule reads the same on every path.
  if (projectIds.length && !canGrantProjectAccess(caller)) throw projectAccessNeeded(projectIds);
  const unknownSettings = Object.keys(input.project_settings ?? {}).filter((id) => !projectIds.includes(id));
  if (unknownSettings.length) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'project_settings names projects not in project_ids', { reason: 'unknown_project', project_ids: unknownSettings });
  }
  if (projectIds.length) {
    const { data, error } = await service.from('projects').select('id').in('id', projectIds).is('deleted_at', null);
    if (error) throw error;
    const live = new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
    const missing = projectIds.filter((id) => !live.has(id));
    if (missing.length) throw new ApiError(404, 'NOT_FOUND', 'Project not found. It may be in Trash.', { reason: 'not_found_or_in_trash', project_ids: missing });
  }
  // Each project's assignment row, checked against the template (agent id filled in after it exists).
  const assignmentRows = projectIds.map((projectId) => {
    const own = input.project_settings?.[projectId] ?? {};
    return newAssignmentRow(caller, projectId, '', { template_key: template?.key ?? null, settings: own.settings, instructions: own.instructions, status: own.status },
      `${projectId}: `, templates);
  });
  // The owners as sent; the hirer only when none are named, so an agent always has one.
  const owners = await checkOwnerIds(service, null, input.owner_ids?.length ? input.owner_ids : [caller.memberId]);
  const ownerGroupIds = input.owner_group_ids?.length ? await checkOwnerGroupIds(service, input.owner_group_ids) : [];
  const rulesInput = { ...(template?.rules ?? {}), ...rulesColumnsFrom(input.rules) };
  await agentRulesColumns(service, { id: '00000000-0000-4000-8000-000000000000', role: 'agent' }, rulesInput);
  let keyScopes: string[] | null = null;
  let beyondRole: string[] = [];
  if (input.create_key) {
    if (!callerHolds(caller, 'api_keys.manage_all')) {
      throw forbidden('Making a key needs api_keys.manage_all', { reason: 'missing_key_scope', needs: 'api_keys.manage_all' });
    }
    keyScopes = [...new Set(input.scopes ?? template?.scopes ?? [])];
    if (keyScopes.length === 0) throw new ApiError(422, 'VALIDATION_ERROR', 'A key needs at least one scope: send scopes, or a template', { reason: 'scopes_required' });
    const unknown = keyScopes.filter((scope) => !API_ENDPOINT_PERMISSION_SET.has(scope as PermissionKey));
    if (unknown.length) throw new ApiError(422, 'VALIDATION_ERROR', `Not API scopes: ${unknown.join(', ')}`, { reason: 'unknown_scope' });
    const grantable = grantableScopes(granter);
    const beyond = keyScopes.filter((scope) => !grantable.has(scope));
    if (beyond.length) {
      throw forbidden(`A key can only carry scopes you hold yourself: ${beyond.join(', ')}`, { reason: 'scope_escalation', beyond_caller: beyond });
    }
    // Powers the agent role lacks are given to this agent alone (who manages access only), so the key can carry them.
    beyondRole = await agentScopesBeyondRole(service, granter, null, keyScopes);
    assertMayGiveAgentScopes(caller.access, beyondRole);
  }

  // 2. Write, undoing on a failure.
  const state: HireState = {
    agentId: null, done: [], ownersAdded: [], ownerGroupsAdded: [], accessAdded: [], assignmentIds: [], keyId: null, scopeGrants: { added: [], wasDenied: [] },
  };
  try {
    const member = await createAgentMember(service, caller.access, {
      name: input.name,
      email: input.email ?? agentEmailFor(input.name),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.avatar_url !== undefined ? { avatar: input.avatar_url } : {}),
      ...(input.agent_profile !== undefined ? { agent_profile: input.agent_profile } : template?.profile ? { agent_profile: template.profile } : {}),
      ...(input.agent_role !== undefined ? { agent_role: input.agent_role } : template?.role ? { agent_role: template.role } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    });
    const agentId = member.id;
    state.agentId = agentId;
    state.done.push('agent added');

    const columns = await agentRulesColumns(service, { id: agentId, role: 'agent' }, rulesInput);
    let row: Row = member;
    if (Object.keys(columns).length) {
      const { data, error } = await service.from('team_members').update(columns).eq('id', agentId).select().single();
      if (error) throw error;
      row = data as Row;
      state.done.push('rules set');
    }
    if (template?.limits) {
      await setAgentLimits(service, agentId, template.limits, caller.memberId);
      state.done.push('limits set');
    }
    if (beyondRole.length) {
      state.scopeGrants = await addAgentScopeGrants(service, agentId, beyondRole, caller.memberId);
      state.done.push('powers beyond its role given');
    }
    state.ownersAdded = await addOwners(service, agentId, owners, caller.memberId);
    state.ownerGroupsAdded = await addOwnerGroups(service, agentId, ownerGroupIds, caller.memberId);

    let assignments: ProjectAgentAssignment[] = [];
    if (assignmentRows.length) {
      state.accessAdded = await ensureProjectAccess(service, agentId, projectIds);
      const { data, error } = await service.from('project_agents').insert(assignmentRows.map((r) => ({ ...r, agent_id: agentId }))).select(PROJECT_AGENT_COLUMNS);
      if (error) {
        if (missingSchema(error)) throw migrationPending();
        throw error;
      }
      const inserted = (data ?? []) as Row[];
      state.assignmentIds = inserted.map((r) => r.id as string);
      assignments = await presentAssignments(service, inserted);
    }

    // The template is recorded where the context pack and export look for it.
    const { error: auditError } = await insertAuditRows(service, {
      method: 'POST', endpoint: AGENT_HIRE_ENDPOINT, entity_type: 'team_member', entity_id: agentId, api_key_id: apiKeyId, team_member_id: caller.memberId,
      request_body: { template: template?.key ?? null, project_ids: projectIds, create_key: !!input.create_key, scopes: keyScopes },
      after_snapshot: { agent: agentView(row), assignments: state.assignmentIds }, status_code: 201, via,
    });
    if (auditError) console.error('[agents] hire audit write failed', auditError);
    if (template) await recordTemplateKey(service, agentId, template.key);

    // With the workspace's key lifetime, the key says when it ends (null: until revoked).
    let key: (NewAgentKey & { expires_at: string | null }) | undefined;
    if (keyScopes) {
      const granted = await checkKeyGrant(service, granter, { memberId: agentId, scopes: keyScopes });
      const made = await insertApiKey(service, {
        name: input.key_name ?? `${input.name}${template ? ` (${template.label})` : ''}`,
        memberId: agentId, createdBy: caller.memberId, createdByKeyId: null, scopes: granted.scopes, permissions: 'scoped',
      });
      state.keyId = made.key.id;
      key = {
        id: made.key.id, name: made.key.name, prefix: made.key.key_prefix, scopes: made.key.scopes ?? [], permissions: made.key.permissions, secret: made.secret,
        expires_at: (made.key as { expires_at?: string | null }).expires_at ?? null,
      };
    }

    return {
      agent: {
        ...agentView(row),
        owners: (await ownersOf(service, [agentId])).get(agentId) ?? [],
        owner_groups: (await ownerGroupsOf(service, [agentId])).get(agentId) ?? [],
      },
      rules: rulesWithGroup(row),
      template_key: template?.key ?? null,
      assignments,
      access_added: state.accessAdded,
      scopes_beyond_role: beyondRole,
      ...(key ? { key } : {}),
      connect: buildConnectInfo(appUrl),
    };
  } catch (failure) {
    if (!state.agentId) throw failure;
    return undoHire(service, caller, state, failure, { apiKeyId, via });
  }
}

interface HireState {
  agentId: string | null;
  done: string[];
  ownersAdded: string[];
  ownerGroupsAdded: string[];
  accessAdded: string[];
  assignmentIds: string[];
  keyId: string | null;
  /** Powers given beyond the agent role (per-member allows on the API channel). */
  scopeGrants: { added: string[]; wasDenied: string[] };
}

/**
 * Undoes a hire that failed after the agent was made: its key revoked (with
 * its own audit row), the assignments, owners, project access and powers
 * beyond its role this call added removed, and the agent suspended, so
 * nothing half made can act. A
 * member is never deleted (their login stays, suspended). Throws an answer
 * saying what was undone and what stays.
 */
async function undoHire(service: SupabaseClient, caller: AgentCaller, state: HireState, failure: unknown, door: { apiKeyId: string | null; via: string }): Promise<never> {
  const agentId = state.agentId as string;
  const cause = failure instanceof Error ? failure.message : String((failure as { message?: string })?.message ?? failure);
  const rolledBack: string[] = [];
  const failed: string[] = [];
  const step = async (what: string, run: () => PromiseLike<{ error: unknown } | unknown>) => {
    try {
      const result = await run();
      const error = (result as { error?: unknown } | undefined)?.error;
      if (error) throw error;
      rolledBack.push(what);
    } catch (error) {
      console.error(`[agents] hire rollback: ${what} failed`, error);
      failed.push(what);
    }
  };
  if (state.keyId) {
    const keyId = state.keyId;
    await step('key revoked', () => revokeKeyTree(service, keyId, { memberId: caller.memberId, apiKeyId: null, endpoint: `/api/workspace/agents/${agentId}/keys/${keyId}/revoke`, via: 'app' }));
  }
  if (state.assignmentIds.length) await step('assignments removed', () => service.from('project_agents').delete().in('id', state.assignmentIds));
  if (state.accessAdded.length) await step('project access removed', () => service.from('project_members').delete().eq('member_id', agentId).in('project_id', state.accessAdded));
  if (state.ownersAdded.length) await step('owners removed', () => service.from('agent_owners').delete().eq('agent_id', agentId).in('member_id', state.ownersAdded));
  if (state.ownerGroupsAdded.length) await step('owner groups removed', () => service.from('agent_owner_groups').delete().eq('agent_id', agentId).in('group_id', state.ownerGroupsAdded));
  if (state.scopeGrants.added.length || state.scopeGrants.wasDenied.length) {
    await step('powers beyond its role removed', () => removeAgentScopeGrants(service, agentId, state.scopeGrants));
  }
  await step('agent suspended', () => service.from('team_members').update({ status: 'suspended' }).eq('id', agentId));
  const details = {
    reason: 'hire_incomplete',
    agent_id: agentId,
    rolled_back: rolledBack,
    remains: ['The agent stays in Team, suspended: reactivate it to finish setting it up, or leave it.'],
    ...(failed.length ? { rollback_failed: failed } : {}),
    cause,
  };
  const { error } = await insertAuditRows(service, {
    method: 'POST', endpoint: AGENT_HIRE_ENDPOINT, entity_type: 'team_member', entity_id: agentId, api_key_id: door.apiKeyId, team_member_id: caller.memberId,
    request_body: null, after_snapshot: details, status_code: 500, error: cause, via: door.via,
  });
  if (error) console.error('[agents] hire rollback audit failed', error);
  if (failure instanceof ApiError) {
    throw new ApiError(failure.statusCode, failure.code, `The agent was not hired: ${failure.message}. What this call made was undone.`, {
      ...(typeof failure.details === 'object' && failure.details ? failure.details as Row : {}),
      ...details,
      reason: (failure.details as Row | undefined)?.reason ?? details.reason,
    });
  }
  throw new ApiError(500, 'HIRE_INCOMPLETE', 'The agent was not hired: it stopped partway. What this call made was undone.', details);
}
